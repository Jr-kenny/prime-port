// The agent-facing surface of Prime Port: MCP tools over streamable HTTP.
// Tools: publish, get_offers, negotiate, hire, confirm_hire, approve, plus
// port_connect as an advanced compatibility path. The primary buyer surface
// is the job inbox (GET /jobs/:jobId/inbox and POST /jobs/:jobId/messages):
// plain HTTP, so an agent installs nothing. Freelancer lanes stay separate
// behind stable candidate aliases (C1, C2, ...), but the alias is a label the
// caller addresses by, never text the relay injects into a message.
//
// Two other surfaces share the process:
//   - REST for the freelancer web app (claim a job, countersign the hire),
//   - an append-only events file (data/events.jsonl) that distribution and
//     contracts consume (job-created, publish-task-paid, publish-delivered,
//     hire-committed, job-task-linked, job-task-escrowed, submission-created,
//     submission-accepted, and job-completed).
//     Escrow settlement hangs off those same events.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { keccak256, toBytes, verifyMessage } from "viem";
import { canonicalize, commitmentHash } from "../commitment/commitment.mjs";
import { requestStateBackup } from "../state-sync.mjs";
import {
  assignCandidateAlias,
  ensureCandidateAliases,
  findCandidate,
} from "./candidates.mjs";
import {
  appendInboxMessage,
  ensureInbox,
  inboxAfter,
  inboxByClientId,
  inboxCursor,
  inboxHas,
  inboxThreads,
  requireBuyer,
  resolveThread,
} from "./inbox.mjs";
import {
  authorizationMessage,
  buildDisputeRequest,
  buildEscrowAuthorization,
  buildFundingRequest,
  buildRefundRequest,
  buildReleaseRequest,
  escrowConfig,
  requireEscrow,
} from "./escrow.mjs";
import { startEscrowWatcher } from "./escrow-watcher.mjs";
import {
  MEMO_PATTERN,
  nativePaymentConfig,
  nativePaymentRequirements,
  publicationMemoGuard,
  verifyNativePayment,
} from "./native-payment.mjs";

const PORT = Number(process.env.PORT ?? 8792);
const PORT_SVC = process.env.PORT_SVC ?? "http://localhost:8791";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? "https://prime-port-latest.onrender.com";
const PORT_SERVICE_TOKEN = process.env.PORT_SERVICE_TOKEN ?? randomBytes(32).toString("hex");
const SESSION_SECRET = process.env.SESSION_SECRET ?? randomBytes(32).toString("hex");
const BACKEND_SERVICE_TOKEN = process.env.BACKEND_SERVICE_TOKEN ?? randomBytes(32).toString("hex");
// The publication fee is paid in the settlement chain's native gas token
// (ETH on Robinhood Chain). The config fails at boot rather than serving an
// unpaid publication.
const PUBLISH_PAYMENT = nativePaymentConfig();
const ESCROW = escrowConfig();
// Prime Port earns the fixed publication charge. It never deducts from the
// separately negotiated freelancer wage; the commitment retains this field
// for protocol compatibility and fixes it at zero.
const FEE_BPS = 0;
const DATA = process.env.MCP_DATA_DIR
  ? `${process.env.MCP_DATA_DIR.replace(/\/$/, "")}/`
  : new URL("./data/", import.meta.url).pathname;
mkdirSync(DATA, { recursive: true });

const jobsPath = `${DATA}jobs.json`;
const jobs = existsSync(jobsPath) ? JSON.parse(readFileSync(jobsPath, "utf8")) : {};
const save = () => {
  const next = `${jobsPath}.next`;
  writeFileSync(next, JSON.stringify(jobs, null, 2));
  renameSync(next, jobsPath);
  requestStateBackup();
};
const emit = (type, payload) =>
  appendFileSync(`${DATA}events.jsonl`, JSON.stringify({ type, at: Date.now(), ...payload }) + "\n");

const portSvc = async (method, path, body, contentType = "application/json", extraHeaders = {}) => {
  const r = await fetch(`${PORT_SVC}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${PORT_SERVICE_TOKEN}`,
      ...(body !== undefined ? { "content-type": contentType } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : contentType === "application/json" ? JSON.stringify(body) : body,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`port-service ${path}: ${j.error}`);
  return j;
};

async function recoverMarkedPorts() {
  const recoveries = Object.values(jobs).filter((job) => job.port?.recoveryPending === true);
  for (const job of recoveries) {
    let recovered;
    let lastError;
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      try {
        recovered = await portSvc("POST", "/ports", { jobId: job.jobId });
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 10) await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    if (!recovered) throw lastError ?? new Error(`failed to recover port for ${job.jobId}`);
    job.port = {
      inboxId: recovered.inboxId,
      address: recovered.address,
      grantToken: recovered.grantToken,
    };
    job.portRecoveredAt = Date.now();
    save();
    emit("port-recovered", { jobId: job.jobId, reason: "ephemeral-state-recovery" });
    console.log(`[mcp-server] recovered unused port for settled job ${job.jobId}`);
  }
}

await recoverMarkedPorts();

const getJob = (jobId) => {
  const job = jobs[jobId];
  if (!job) throw new Error(`unknown job ${jobId}`);
  return job;
};
const requireAgent = (job, session) => {
  if (!session?.wallet || job.agent.wallet.toLowerCase() !== session.wallet) {
    throw new Error("job agent authorization required");
  }
};

const b64url = (value) => Buffer.from(value).toString("base64url");
const signToken = (payload) => {
  const encoded = b64url(JSON.stringify(payload));
  const signature = createHmac("sha256", SESSION_SECRET).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
};
const readToken = (token, expectedType) => {
  const [encoded, supplied] = String(token ?? "").split(".");
  if (!encoded || !supplied) throw new Error("authentication required");
  const expected = createHmac("sha256", SESSION_SECRET).update(encoded).digest();
  const actual = Buffer.from(supplied, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("invalid session");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (payload.type !== expectedType || !payload.exp || payload.exp < Date.now()) throw new Error("expired session");
  return payload;
};
const bearer = (req) => String(req.headers.authorization ?? "").match(/^Bearer (.+)$/)?.[1];
const requireSession = (req) => readToken(bearer(req), "freelancer-session");
const optionalSession = (req) => {
  try {
    return requireSession(req);
  } catch {
    return null;
  }
};
const requireBackend = (req) => {
  if (req.headers["x-backend-service-token"] !== BACKEND_SERVICE_TOKEN) throw new Error("backend service authentication required");
};
const ownsJob = (job, session) => job.claims.some(
  (claim) => claim.inboxId === session.inboxId && claim.wallet === session.wallet,
);
const hiredSession = (job, session) =>
  hiredInboxId(job) === session.inboxId
  && job.pendingHire?.commitment.freelancer.wallet.toLowerCase() === session.wallet;

function publicJob(job, session) {
  const ownClaims = session
    ? job.claims.filter((claim) => claim.inboxId === session.inboxId && claim.wallet === session.wallet)
    : [];
  const hired = Boolean(session && hiredSession(job, session));
  return {
    jobId: job.jobId,
    status: job.status,
    title: job.title,
    description: job.description,
    deliverables: job.deliverables,
    criteria: job.criteria,
    price: job.price,
    currency: job.currency,
    deadline: job.deadline,
    createdAt: job.createdAt,
    claims: ownClaims,
    ...(ownClaims.length ? { port: { inboxId: job.port.inboxId } } : {}),
    ...(hired ? {
      pendingHire: {
        hash: job.pendingHire.hash,
        commitment: job.pendingHire.commitment,
        escrow: job.pendingHire.escrow ? {
          version: job.pendingHire.escrow.version,
          chainId: job.pendingHire.escrow.chainId,
          escrowAddress: job.pendingHire.escrow.escrowAddress,
          tokenAddress: job.pendingHire.escrow.tokenAddress,
          authorizationHash: job.pendingHire.escrow.authorizationHash,
          signThisExactly: job.pendingHire.escrow.signThisExactly,
          amount: job.pendingHire.escrow.amount,
          currency: job.pendingHire.escrow.currency,
        } : undefined,
      },
      settlement: job.settlement,
      submissions: job.submissions,
    } : {}),
  };
}

// Reconstruct the internal escrow ledger for pre-upgrade jobs without
// pretending their wage is funded. A real EscrowFunded event is the only
// transition that can make a freelancer start work.
const ensureSettlement = (job) => {
  if (!job.pendingHire?.hash) return false;
  if (job.settlement && !job.settlement.workerAgentId) return false;
  if (job.settlement?.workerAgentId || job.jobTask) {
    job.settlement = {
      contractAddress: ESCROW.address,
      chainId: ESCROW.chainId,
      tokenAddress: ESCROW.token,
      commitmentHash: job.pendingHire.hash,
      status: "legacy-signatures-incompatible",
      reviewStatus: job.settlement?.reviewStatus ?? "not-submitted",
      migrationRequired: true,
      migratedAt: Date.now(),
    };
    return true;
  }
  const statusByJob = {
    "awaiting-escrow": "awaiting-funding",
    hired: "escrow-locked",
    delivered: "release-ready",
    "delivery-rejected": "dispute-available",
    settled: "settled",
    failed: "refunded",
  };
  const accepted = job.submissions?.find((submission) => submission.status === "accepted");
  const latest = job.submissions?.at(-1);
  job.settlement = {
    contractAddress: ESCROW.address,
    chainId: ESCROW.chainId,
    tokenAddress: ESCROW.token,
    commitmentHash: job.pendingHire.hash,
    status: statusByJob[job.status] ?? "awaiting-funding",
    reviewStatus: accepted ? "final-delivery-ready" : latest?.status ?? "not-submitted",
    ...(latest ? { latestSubmissionId: latest.submissionId } : {}),
    ...(accepted ? { finalSubmissionId: accepted.submissionId } : {}),
    migratedAt: Date.now(),
  };
  job.submissions ??= [];
  return true;
};

let migratedSettlement = false;
for (const job of Object.values(jobs)) {
  migratedSettlement = ensureSettlement(job) || migratedSettlement;
  migratedSettlement = ensureCandidateAliases(job) || migratedSettlement;
  if (job.agentToken) {
    delete job.agentToken;
    migratedSettlement = true;
  }
}
if (migratedSettlement) save();

// The publication fee pays for the port. The later negotiated wage is
// internal Prime Port escrow, a separate transaction from the fee.
const requirePaidPort = (job, verb) => {
  if (!job.publishTask)
    throw new Error(`${verb} needs a paid port: this job was published without a payment record. Publish through POST /mcp/publish and settle the fee first.`);
  if (!job.publishTask.paidAt)
    throw new Error(`${verb} needs a paid port: the publication fee for ${job.publishTask.publishId} has not settled yet`);
};

// Key delivery is the publish task's settlement moment: the first time the
// agent takes the port key (port_connect) or operates the port through us
// (negotiate), the publish deliverable is complete and provable.
const markKeyDelivered = (job, via) => {
  if (job.publishTask.keyDeliveredAt) return;
  job.publishTask.keyDeliveredAt = Date.now();
  save();
  emit("publish-delivered", {
    jobId: job.jobId,
    publishId: job.publishTask.publishId,
    via,
    portInboxId: job.port.inboxId,
  });
};

// The GenLayer relayer posts dispute verdicts; a shared token keeps random
// callers from writing settlement state.
const RELAYER_TOKEN = process.env.RELAYER_TOKEN ?? "";
const requireRelayer = (req) => {
  if (!RELAYER_TOKEN || req.headers["x-relayer-token"] !== RELAYER_TOKEN)
    throw new Error("relayer token required");
};
const text = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });

// The exact string the agent wallet personal_signs over a review hash. Same
// shape as the hire commitment message so verifiers treat both alike.
const reviewMessage = (hash) => `Prime Port freelancer review v1: ${hash}`;

const hiredInboxId = (job) => job.pendingHire?.commitment.freelancer.inboxId;

const settlementNotice = async (job, kind) => {
  const notices = {
    "funding-ready": {
      field: "fundingReadyNoticeSentAt",
      content: "[prime-port:escrow-funding-ready]",
    },
    locked: {
      field: "escrowLockedNoticeSentAt",
      content: "[prime-port:escrow-locked]",
    },
    released: {
      field: "escrowReleasedNoticeSentAt",
      content: "[prime-port:escrow-released]",
    },
    refunded: {
      field: "escrowRefundedNoticeSentAt",
      content: "[prime-port:escrow-refunded]",
    },
    disputed: {
      field: "disputeOpenedNoticeSentAt",
      content: "[prime-port:dispute-opened]",
    },
    resolved: {
      field: "disputeResolvedNoticeSentAt",
      content: "[prime-port:dispute-resolved]",
    },
  };
  const notice = notices[kind];
  if (!notice || job.settlement?.[notice.field]) return;
  await portSvc("POST", `/ports/${job.jobId}/messages`, {
    peerInboxId: hiredInboxId(job),
    content: `${notice.content}\n${JSON.stringify({
      jobId: job.jobId,
      commitmentHash: job.pendingHire.hash,
      amount: job.pendingHire.commitment.terms.price,
      currency: job.pendingHire.commitment.terms.currency,
      transactionHash: job.settlement?.lastTransactionHash ?? null,
      providerBps: job.settlement?.providerBps ?? null,
    })}`,
  });
  job.settlement[notice.field] = Date.now();
  save();
};

const findJobByCommitment = (hash) => Object.values(jobs).find(
  (job) => job.pendingHire?.hash?.toLowerCase() === String(hash).toLowerCase(),
);

async function archiveSettledPort(job) {
  if (job.archive) return;
  try {
    const scrapped = await portSvc("POST", `/ports/${job.jobId}/scrap`, {});
    job.archive = scrapped.archive;
    emit("port-scrapped", { jobId: job.jobId, transcriptHashes: scrapped.archive.transcriptHashes });
  } catch (error) {
    console.error(`[escrow] ${job.jobId} settled but port archive failed: ${error.message}`);
  }
}

async function applyEscrowEvent(event) {
  const commitment = event.args.commitmentHash?.toLowerCase();
  const job = commitment ? findJobByCommitment(commitment) : null;
  if (!job) return { ignored: true, reason: "no matching Prime Port commitment" };
  ensureSettlement(job);
  const eventId = `${event.transactionHash}:${event.logIndex}`;
  const duplicate = job.settlement.processedEvents?.includes(eventId);
  let noticeKind;

  if (!duplicate) {
    const expected = job.pendingHire.escrow ?? buildEscrowAuthorization(job.pendingHire, ESCROW);
    if (event.eventName === "EscrowFunded") {
      if (
        event.args.buyer.toLowerCase() !== expected.buyer.toLowerCase()
        || event.args.provider.toLowerCase() !== expected.provider.toLowerCase()
        || event.args.payout.toLowerCase() !== expected.payout.toLowerCase()
        || event.args.amount.toString() !== expected.amountUnits
        || Number(event.args.deadline) !== expected.deadline
      ) throw new Error(`EscrowFunded does not match signed authorization ${commitment}`);
      job.status = "hired";
      ensureCandidateAliases(job);
      for (const claim of job.claims) {
        claim.selectionStatus = claim.inboxId === hiredInboxId(job) ? "hired" : "not-selected";
        if (claim.selectionStatus === "hired") claim.hiredAt = Date.now();
      }
      job.settlement.status = "escrow-locked";
      job.settlement.fundedAt = Date.now();
      job.settlement.fundingTransactionHash = event.transactionHash;
      noticeKind = "locked";
      emit("escrow-funded", { jobId: job.jobId, commitmentHash: commitment, transactionHash: event.transactionHash });
    } else if (event.eventName === "EscrowReleased") {
      job.status = "settled";
      job.settlement.status = "released";
      job.settlement.settledAt = Date.now();
      job.settlement.releaseTransactionHash = event.transactionHash;
      noticeKind = "released";
      emit("escrow-released", { jobId: job.jobId, commitmentHash: commitment, transactionHash: event.transactionHash });
      await archiveSettledPort(job);
    } else if (event.eventName === "EscrowRefunded") {
      job.status = "failed";
      job.settlement.status = "refunded";
      job.settlement.settledAt = Date.now();
      job.settlement.refundTransactionHash = event.transactionHash;
      noticeKind = "refunded";
      emit("escrow-refunded", { jobId: job.jobId, commitmentHash: commitment, transactionHash: event.transactionHash });
      await archiveSettledPort(job);
    } else if (event.eventName === "DisputeOpened") {
      job.status = "disputed";
      job.settlement.status = "disputed";
      job.settlement.disputedAt = Date.now();
      job.settlement.evidenceHash = event.args.evidenceHash;
      job.settlement.disputeTransactionHash = event.transactionHash;
      noticeKind = "disputed";
      emit("escrow-disputed", {
        jobId: job.jobId,
        commitmentHash: commitment,
        evidenceHash: event.args.evidenceHash,
        transactionHash: event.transactionHash,
      });
    } else if (event.eventName === "DisputeResolved") {
      job.status = "settled";
      job.settlement.status = "resolved";
      job.settlement.settledAt = Date.now();
      job.settlement.resolutionId = event.args.resolutionId;
      job.settlement.verdictHash = event.args.verdictHash;
      job.settlement.providerBps = Number(event.args.providerBps);
      job.settlement.providerAmountUnits = event.args.providerAmount.toString();
      job.settlement.buyerAmountUnits = event.args.buyerAmount.toString();
      job.settlement.resolutionTransactionHash = event.transactionHash;
      noticeKind = "resolved";
      emit("escrow-resolved", {
        jobId: job.jobId,
        commitmentHash: commitment,
        verdictHash: event.args.verdictHash,
        providerBps: Number(event.args.providerBps),
        transactionHash: event.transactionHash,
      });
      await archiveSettledPort(job);
    }
    if (!noticeKind) return { ignored: true, reason: `unsupported event ${event.eventName}` };
    (job.settlement.processedEvents ??= []).push(eventId);
    job.settlement.lastTransactionHash = event.transactionHash;
    save();
  } else {
    noticeKind = {
      EscrowFunded: "locked",
      EscrowReleased: "released",
      EscrowRefunded: "refunded",
      DisputeOpened: "disputed",
      DisputeResolved: "resolved",
    }[event.eventName];
  }

  if (noticeKind) {
    try { await settlementNotice(job, noticeKind); }
    catch (error) { console.error(`[escrow] ${job.jobId} notification failed: ${error.message}`); }
  }
  return { applied: !duplicate, duplicate, jobId: job.jobId, status: job.status };
}

async function buildDisputeEvidence(job, openedBy, reason) {
  if (!job.pendingHire?.escrow) {
    throw new Error("this pre-upgrade hire must be re-signed before it can use Prime Port escrow");
  }
  const channel = await portSvc(
    "GET",
    `/ports/${job.jobId}/channel?peer=${encodeURIComponent(hiredInboxId(job))}`,
  );
  const manifest = {
    version: 1,
    kind: "prime-port-dispute-evidence",
    jobId: job.jobId,
    commitmentHash: job.pendingHire.hash,
    commitment: job.pendingHire.commitment,
    signatures: {
      buyer: job.pendingHire.agentSignature,
      provider: job.pendingHire.freelancerSignature,
      authorizationHash: job.pendingHire.escrow.authorizationHash,
    },
    openedBy,
    reason,
    transcriptHash: channel.transcriptHash,
    messages: channel.messages.map((message) => message.kind === "text"
      ? { fromPort: message.fromPort, kind: "text", content: message.content }
      : {
          fromPort: message.fromPort,
          kind: "attachment",
          filename: message.filename,
          contentLength: message.contentLength,
          contentDigest: message.contentDigest,
        }),
    submissions: (job.submissions ?? []).map((submission) => ({
      submissionId: submission.submissionId,
      revision: submission.revision,
      note: submission.note,
      attachments: submission.attachments.map(({ filename, contentLength, contentDigest }) => ({
        filename,
        contentLength,
        contentDigest,
      })),
      transcriptHash: submission.transcriptHash,
      status: submission.status,
      feedback: submission.feedback ?? "",
      submittedAt: submission.submittedAt,
      reviewedAt: submission.reviewedAt ?? 0,
    })),
  };
  const encoded = canonicalize(manifest);
  const evidenceHash = keccak256(toBytes(encoded));
  mkdirSync(`${DATA}evidence`, { recursive: true });
  writeFileSync(`${DATA}evidence/${evidenceHash}.json`, encoded);
  job.disputeDraft = { evidenceHash, openedBy, reason, createdAt: Date.now() };
  save();
  return {
    evidenceHash,
    evidenceUrl: `${PUBLIC_BASE_URL}/evidence/${evidenceHash}`,
    transaction: buildDisputeRequest(job.pendingHire, evidenceHash, ESCROW),
  };
}

// Reputation is computed from the jobs file every time, never stored: the
// jobs are the ledger, the profile is just a view over it.
function reputation(inboxId) {
  const all = Object.values(jobs);
  const claimed = all.filter((j) => j.claims.some((c) => c.inboxId === inboxId));
  const hired = all.filter((j) => hiredInboxId(j) === inboxId && ["hired", "delivered", "delivery-rejected", "settled"].includes(j.status));
  const completed = hired.filter((j) => j.status === "settled");
  const reviews = all
    .filter((j) => j.review?.freelancer === inboxId)
    .map(({ jobId, title, review }) => ({ jobId, title, stars: review.stars, note: review.note, ratedAt: review.ratedAt }));
  const claims = claimed
    .flatMap((j) => j.claims.filter((c) => c.inboxId === inboxId))
    .sort((a, b) => a.claimedAt - b.claimedAt);
  return {
    inboxId,
    name: claims.at(-1)?.name ?? null,
    jobsClaimed: claimed.length,
    jobsHired: hired.length,
    jobsCompleted: completed.length,
    completionRate: hired.length ? Math.round((completed.length / hired.length) * 100) / 100 : null,
    avgStars: reviews.length
      ? Math.round((reviews.reduce((s, r) => s + r.stars, 0) / reviews.length) * 10) / 10
      : null,
    reviewCount: reviews.length,
    reviews,
    firstClaimAt: claims[0]?.claimedAt ?? null,
    lastClaimAt: claims.at(-1)?.claimedAt ?? null,
  };
}

// Publishing a job = mint a port + open the listing. One function, two
// callers: the paid HTTP endpoint (POST /mcp/publish) and the trusted
// internal REST route (POST /jobs).
const publishShape = z.object({
  description: z.string().min(30),
  deliverables: z.string().min(10),
  criteria: z.string().min(10),
  price: z.string().regex(/^\d+(\.\d{1,6})?$/).optional(),
  currency: z.literal("USDT").default("USDT"),
  // Payment clients may carry values as strings on the paid replay. Accept
  // both that wire shape and native JSON numbers, then store a number.
  deadline: z.coerce.number().int(),
  // A buyer is identified by the wallet that pays and signs.
  agentId: z.string().optional(),
  agentWallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  title: z.string().min(8).max(120).refine((title) => !/^(post|publish|help me post|set up)\b/i.test(title), "title must describe the actual freelancer job"),
});

async function prepareJob(args) {
  const jobId = `job-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const port = await portSvc("POST", "/ports", { jobId });
  const agentWallet = args.agentWallet.toLowerCase();
  const job = {
    jobId,
    status: "open",
    title: args.title,
    description: args.description,
    deliverables: args.deliverables,
    criteria: args.criteria,
    price: args.price ?? null,
    currency: args.currency,
    deadline: args.deadline,
    agent: { agentId: String(args.agentId ?? agentWallet), wallet: agentWallet },
    feeBps: FEE_BPS,
    port: { inboxId: port.inboxId, address: port.address, grantToken: port.grantToken },
    claims: [],
    submissions: [],
    // No relay sits between the buyer and a candidate. The buyer addresses a
    // lane as C1, C2, ... over the job inbox; the label exists so a rejected
    // candidate's wallet is never handed to the buyer.
    // Which social channels this job has been posted to, and when. Written
    // once per channel by POST /jobs/:jobId/posted so a redeploy never
    // re-posts. Lives on the job so it rides the persisted, backed-up state.
    postedTo: {},
    // The fee payment IS the publish task. paidAt lands when the fee has
    // verified on chain; keyDeliveredAt when the agent takes the port. Both
    // are settlement facts, not our opinions. The publication itself is the
    // paid artifact: a native-ETH transfer whose memo binds it to this job.
    ...(args.payment
      ? {
          publishTask: {
            publishId: args.payment.id,
            paidAt: Date.now(),
            keyDeliveredAt: null,
            paymentMode: args.payment.mode ?? "native-eth",
            paymentTx: args.payment.txHash ?? null,
            paymentMemo: args.payment.memo ?? null,
            payer: args.payment.payer ?? null,
            chainId: args.payment.chainId ?? null,
          },
        }
      : {}),
    createdAt: Date.now(),
  };
  return { jobId, job, port: { inboxId: port.inboxId } };
}

function commitPreparedJob(prepared) {
  const { jobId, job, port } = prepared;
  if (jobs[jobId] && jobs[jobId] !== job) throw new Error(`job ${jobId} already exists`);
  jobs[jobId] ??= job;
  save();
  emit("job-created", {
    jobId,
    title: job.title,
    price: job.price,
    deadline: job.deadline,
    publishId: job.publishTask?.publishId ?? null,
  });
  return { jobId, port };
}

async function offersForJob(job) {
  ensureCandidateAliases(job);
  const { conversations } = await portSvc("GET", `/ports/${job.jobId}/conversations`);
  const offers = [];
  for (const claim of job.claims) {
    const { jobsClaimed, jobsCompleted, completionRate, avgStars, reviewCount } = reputation(claim.inboxId);
    const channel = conversations.find((candidate) => candidate.peerInboxId === claim.inboxId) ?? { messageCount: 0 };
    const fullChannel = channel.messageCount > 0
      ? await portSvc("GET", `/ports/${job.jobId}/channel?peer=${encodeURIComponent(claim.inboxId)}`)
      : { messages: [], transcriptHash: null };
    offers.push({
      ...claim,
      reputation: { jobsClaimed, jobsCompleted, completionRate, avgStars, reviewCount },
      channel,
      transcriptHash: fullChannel.transcriptHash,
      messages: fullChannel.messages,
      attachments: fullChannel.messages.filter((message) => message.kind === "attachment"),
    });
  }
  return offers;
}

async function sendCandidateMessage(job, claim, rawMessage) {
  const message = z.string().trim().min(1).max(8_000).parse(rawMessage);
  const ongoingStatuses = [
    "hiring",
    "awaiting-freelancer-signature",
    "awaiting-escrow",
    "hired",
    "delivered",
    "delivery-rejected",
    "disputed",
  ];
  if (job.status !== "open") {
    if (!ongoingStatuses.includes(job.status)) throw new Error(`job is ${job.status}, conversation is closed`);
    if (claim.inboxId !== hiredInboxId(job)) throw new Error(`only the selected candidate can be messaged while job is ${job.status}`);
  }
  requirePaidPort(job, "candidate messaging");
  markKeyDelivered(job, "direct-port");
  const sent = await portSvc("POST", `/ports/${job.jobId}/messages`, { peerInboxId: claim.inboxId, content: message });
  const channel = await portSvc("GET", `/ports/${job.jobId}/channel?peer=${encodeURIComponent(claim.inboxId)}`);
  return { sent: true, candidateId: claim.candidateId, messageId: sent?.messageId ?? null, channel: channel.messages };
}

async function startHire(job, claim, input) {
  if (job.status !== "open") throw new Error(`job is ${job.status}`);
  requirePaidPort(job, "hire");
  requireEscrow(ESCROW);
  const price = z.string().regex(/^\d+(\.\d{1,6})?$/).parse(input.price);
  const deadline = z.coerce.number().int().parse(input.deadline);
  if (deadline <= Math.floor(Date.now() / 1000)) throw new Error("hire deadline must be in the future");
  const criteria = input.criteria == null
    ? job.criteria
    : z.string().trim().min(10).max(8_000).parse(input.criteria);
  const channel = await portSvc("GET", `/ports/${job.jobId}/channel?peer=${encodeURIComponent(claim.inboxId)}`);
  const commitment = {
    version: 2,
    jobId: job.jobId,
    port: { inboxId: job.port.inboxId },
    agent: job.agent,
    freelancer: { inboxId: claim.inboxId, wallet: claim.wallet, payoutAddress: claim.payoutAddress },
    terms: { criteria, price, currency: job.currency, deadline },
    feeBps: job.feeBps,
    dispute: {
      system: "GenLayer",
      evidencePolicy: "If either party opens a dispute, the selected job transcript, submissions, revision feedback, and attachment metadata are disclosed to GenLayer validators for settlement.",
      outcome: "provider-award-bps",
    },
    transcriptHash: channel.transcriptHash,
    hiredAt: Math.floor(Date.now() / 1000),
  };
  const hash = commitmentHash(commitment);
  job.pendingHire = {
    commitment,
    hash,
    candidateId: claim.candidateId,
    previousSelectionStatus: claim.selectionStatus ?? "available",
  };
  job.pendingHire.escrow = buildEscrowAuthorization(job.pendingHire, ESCROW);
  job.status = "hiring";
  claim.selectionStatus = "selected";
  claim.selectedAt = Date.now();
  save();
  emit("hire-prepared", { jobId: job.jobId, candidateId: claim.candidateId, commitmentHash: hash });
  return {
    candidateId: claim.candidateId,
    commitmentHash: hash,
    commitment,
    escrowAuthorization: job.pendingHire.escrow,
    signThisExactly: job.pendingHire.escrow.signThisExactly,
    next: "The buyer wallet must personal_sign this exact escrow authorization, then submit the signature. No USDT has moved.",
  };
}

async function confirmHire(job, signatureInput) {
  if (job.status !== "hiring" || !job.pendingHire) throw new Error("no hire in progress");
  const signature = z.string().regex(/^0x[0-9a-fA-F]+$/).parse(signatureInput);
  const valid = await verifyMessage({
    address: job.agent.wallet,
    message: authorizationMessage(job.pendingHire.escrow.authorizationHash),
    signature,
  });
  if (!valid) throw new Error("signature does not recover the agent wallet");
  job.pendingHire.agentSignature = signature;
  job.status = "awaiting-freelancer-signature";
  save();
  return {
    ok: true,
    candidateId: job.pendingHire.candidateId ?? null,
    waitingOn: "freelancer countersignature in the private candidate lane",
    then: "After the freelancer countersigns, Prime Port will return the exact escrow approval and funding transactions. No USDT has moved yet.",
  };
}

async function cancelHire(job) {
  if (job.status === "awaiting-escrow") {
    throw new Error("both signatures already exist, so this authorization can still be funded until its deadline. Prime Port will not claim an off-chain cancellation is safe");
  }
  if (!["hiring", "awaiting-freelancer-signature"].includes(job.status) || !job.pendingHire) {
    throw new Error("no safely cancellable hire is in progress");
  }
  const stage = job.status;
  const candidateId = job.pendingHire.candidateId
    ?? job.claims.find((claim) => claim.inboxId === hiredInboxId(job))?.candidateId
    ?? null;
  (job.cancelledHires ??= []).push({
    commitmentHash: job.pendingHire.hash,
    candidateId,
    stage,
    buyerSigned: Boolean(job.pendingHire.agentSignature),
    cancelledAt: Date.now(),
  });
  const selected = job.claims.find((claim) => claim.candidateId === candidateId);
  if (selected) {
    selected.selectionStatus = job.pendingHire.previousSelectionStatus ?? "available";
    delete selected.selectedAt;
  }
  delete job.pendingHire;
  delete job.settlement;
  job.status = "open";
  save();
  emit("hire-cancelled", { jobId: job.jobId, candidateId, stage });
  if (selected) {
    try {
      await portSvc("POST", `/ports/${job.jobId}/messages`, {
        peerInboxId: selected.inboxId,
        content: `[prime-port:hire-cancelled]\nThe buyer cancelled the prepared hire before both signatures existed. Negotiation is open again.`,
      });
    } catch (error) {
      console.error(`[mcp-server] ${job.jobId} hire cancelled but candidate notice failed: ${error.message}`);
    }
  }
  return {
    cancelled: true,
    candidateId,
    previousStage: stage,
    status: job.status,
    safety: "The freelancer had not countersigned, so the cancelled authorization cannot fund escrow.",
  };
}

async function reviewJobSubmission(job, input) {
  ensureSettlement(job);
  if (job.status !== "hired") throw new Error(`job is ${job.status}, review requires locked escrow`);
  const submissionId = z.string().parse(input.submissionId);
  const decision = z.enum(["request_changes", "accept"]).parse(input.decision);
  const submission = job.submissions?.find((candidate) => candidate.submissionId === submissionId);
  if (!submission) throw new Error("unknown submission");
  if (submission.status !== "awaiting-review") throw new Error(`submission is ${submission.status}`);

  if (decision === "request_changes") {
    const reason = z.string().trim().min(3).max(2_000).parse(input.feedback);
    submission.status = "revision-requested";
    submission.reviewedAt = Date.now();
    submission.feedback = reason;
    job.settlement.reviewStatus = "revision-requested";
    job.settlement.revisionRequestedAt = submission.reviewedAt;
    await portSvc("POST", `/ports/${job.jobId}/messages`, {
      peerInboxId: hiredInboxId(job),
      content: `Changes requested for ${submissionId}: ${reason}`,
    });
    save();
    emit("submission-revision-requested", { jobId: job.jobId, submissionId, commitmentHash: job.pendingHire.hash, feedback: reason });
    return { ok: true, status: "revision-requested", submissionId, next: "Wait for the freelancer's revised submission in this conversation." };
  }

  submission.status = "accepted";
  submission.reviewedAt = Date.now();
  submission.feedback = input.feedback?.trim() ?? "";
  job.settlement.reviewStatus = "final-delivery-ready";
  job.settlement.finalSubmissionId = submissionId;
  job.settlement.acceptedForDeliveryAt = submission.reviewedAt;
  job.status = "delivered";
  job.settlement.status = "release-ready";
  save();
  emit("submission-accepted", { jobId: job.jobId, submissionId, commitmentHash: job.pendingHire.hash });
  return {
    ok: true,
    status: "release-ready",
    submissionId,
    next: "The buyer must explicitly request approval before Prime Port returns the release transaction.",
  };
}

async function approveJob(job, rawNote) {
  ensureSettlement(job);
  if (job.status !== "delivered") throw new Error(`job is ${job.status}, no Prime Port revision has been accepted for release`);
  const note = rawNote == null ? null : z.string().trim().min(1).max(2_000).parse(rawNote);
  if (note) await portSvc("POST", `/ports/${job.jobId}/messages`, { peerInboxId: hiredInboxId(job), content: note });
  job.settlement.approvalRequestedAt = Date.now();
  save();
  emit("job-approval-requested", { jobId: job.jobId, commitmentHash: job.pendingHire.hash });
  return {
    ok: true,
    transaction: buildReleaseRequest(job.pendingHire, ESCROW),
    next: "The buyer wallet must sign and broadcast this transaction. Settlement only changes after EscrowReleased is observed on the settlement chain.",
  };
}

async function openBuyerDispute(job, rawReason) {
  ensureSettlement(job);
  if (!["hired", "delivered", "delivery-rejected"].includes(job.status)) {
    throw new Error(`job is ${job.status}, only funded unsettled jobs can be disputed`);
  }
  const reason = z.string().trim().min(10).max(2_000).parse(rawReason);
  const evidence = await buildDisputeEvidence(job, "buyer", reason);
  emit("dispute-requested", { jobId: job.jobId, commitmentHash: job.pendingHire.hash, evidenceHash: evidence.evidenceHash, openedBy: "buyer" });
  return {
    ok: true,
    ...evidence,
    next: "The buyer wallet must sign and broadcast the openDispute transaction. Prime Port submits to GenLayer only after DisputeOpened is observed on the settlement chain.",
  };
}

function startRating(job, input) {
  if (job.status !== "settled") throw new Error(`job is ${job.status}, rate after escrow settles`);
  if (job.review) throw new Error("already rated");
  const stars = z.coerce.number().int().min(1).max(5).parse(input.stars);
  const note = input.note == null ? "" : z.string().max(280).parse(input.note);
  const review = {
    version: 1,
    jobId: job.jobId,
    commitmentHash: job.pendingHire.hash,
    freelancer: hiredInboxId(job),
    stars,
    note,
    ratedAt: Math.floor(Date.now() / 1000),
  };
  const hash = commitmentHash(review);
  job.pendingReview = { review, hash };
  save();
  return {
    reviewHash: hash,
    review,
    signThisExactly: reviewMessage(hash),
    next: "The buyer wallet must personal_sign that exact message, then submit the signature.",
  };
}

async function confirmRating(job, signatureInput) {
  if (!job.pendingReview) throw new Error("no rating in progress");
  const signature = z.string().regex(/^0x[0-9a-fA-F]+$/).parse(signatureInput);
  const valid = await verifyMessage({
    address: job.agent.wallet,
    message: reviewMessage(job.pendingReview.hash),
    signature,
  });
  if (!valid) throw new Error("signature does not recover the agent wallet");
  job.review = { ...job.pendingReview.review, hash: job.pendingReview.hash, signature };
  delete job.pendingReview;
  save();
  emit("freelancer-rated", { jobId: job.jobId, freelancer: job.review.freelancer, stars: job.review.stars, reviewHash: job.review.hash });
  return { ok: true, review: job.review };
}

function buildServer(agentSession) {
  const mcp = new McpServer({ name: "prime-port", version: "0.1.0" });

  mcp.tool(
    "port_connect",
    "Advanced compatibility path for runtimes that explicitly want direct port control. Most buyers should use the job inbox over HTTP and never call this tool.",
    { jobId: z.string() },
    async ({ jobId }) => {
      const job = getJob(jobId);
      requireAgent(job, agentSession);
      requirePaidPort(job, "port_connect");
      markKeyDelivered(job, "port_connect");
      return text({
        inboxId: job.port.inboxId,
        identity: job.port.address,
        grantEndpoint: `${PUBLIC_BASE_URL}/jobs/${jobId}/agent-grant/sign`,
        grantAuthorizationHeader: { authorization: `Bearer ${agentSession.token}` },
        sdk: "@xmtp/node-sdk@4.6.0, Client.create with a signer whose signMessage POSTs {message} to the grant endpoint",
      });
    },
  );

  mcp.tool(
    "get_offers",
    "List freelancers who claimed this job, with their negotiation channels' latest state. Delivered evidence shows up here as attachment messages: encrypted payload URL plus the key material to decrypt it (XMTP remote attachments; agents on port_connect receive the same envelopes natively).",
    { jobId: z.string() },
    async ({ jobId }) => {
      const job = getJob(jobId);
      requireAgent(job, agentSession);
      const offers = await offersForJob(job);
      return text({
        jobId,
        status: job.status,
        settlement: job.settlement ?? null,
        escrowFunding: job.status === "awaiting-escrow" && job.pendingHire?.escrow && job.pendingHire?.freelancerSignature
          ? buildFundingRequest(job.pendingHire, ESCROW)
          : null,
        latestSubmission: job.submissions?.at(-1) ?? null,
        offers,
      });
    },
  );

  mcp.tool(
    "negotiate",
    "Send a message to one claimant through the port. The HTTP inbox calls this routing path with a stable candidate ID. This MCP form remains for compatible agent clients.",
    { jobId: z.string(), claimantInboxId: z.string(), message: z.string() },
    async ({ jobId, claimantInboxId, message }) => {
      const job = getJob(jobId);
      requireAgent(job, agentSession);
      const claim = job.claims.find((candidate) => candidate.inboxId === claimantInboxId);
      if (!claim) throw new Error("no such claimant");
      return text(await sendCandidateMessage(job, claim, message));
    },
  );

  mcp.tool(
    "hire",
    "Commit to one claimant at the negotiated terms. Builds the hire commitment (criteria, price, deadline, payout address, transcript hash of this channel) and returns the exact message your wallet must personal_sign. Nothing locks until both parties sign and EscrowFunded is confirmed on chain.",
    {
      jobId: z.string(),
      claimantInboxId: z.string(),
      price: z.string().regex(/^\d+(\.\d{1,6})?$/).describe("Final negotiated price"),
      deadline: z.number().int(),
      criteria: z.string().optional().describe("Final criteria if they changed during negotiation; defaults to the published criteria"),
    },
    async ({ jobId, claimantInboxId, price, deadline, criteria }) => {
      const job = getJob(jobId);
      requireAgent(job, agentSession);
      const claim = job.claims.find((c) => c.inboxId === claimantInboxId);
      if (!claim) throw new Error("no such claimant");
      return text(await startHire(job, claim, { price, deadline, criteria }));
    },
  );

  mcp.tool(
    "confirm_hire",
    "Deliver your wallet's signature over the exact escrow authorization. We verify it, then the freelancer countersigns the same authorization in the web app. Both signatures authorize funding, but escrow is locked only after the EscrowFunded event.",
    { jobId: z.string(), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) },
    async ({ jobId, signature }) => {
      const job = getJob(jobId);
      requireAgent(job, agentSession);
      return text(await confirmHire(job, signature));
    },
  );

  mcp.tool(
    "cancel_hire",
    "Cancel a prepared hire before the freelancer countersigns it. Prime Port refuses off-chain cancellation after both signatures exist because that authorization can still be funded until its deadline.",
    { jobId: z.string() },
    async ({ jobId }) => {
      const job = getJob(jobId);
      requireAgent(job, agentSession);
      return text(await cancelHire(job));
    },
  );

  mcp.tool(
    "review_submission",
    "Review the selected freelancer's latest Prime Port submission. Request specific changes to keep iterating inside the port, or accept one exact revision and make it eligible for escrow release.",
    {
      jobId: z.string(),
      submissionId: z.string(),
      decision: z.enum(["request_changes", "accept"]),
      feedback: z.string().max(2000).optional(),
    },
    async ({ jobId, submissionId, decision, feedback }) => {
      const job = getJob(jobId);
      requireAgent(job, agentSession);
      return text(await reviewJobSubmission(job, { submissionId, decision, feedback }));
    },
  );

  mcp.tool(
    "approve",
    "Confirm that you want to approve the accepted revision. Prime Port returns the exact settlement transaction that releases escrow directly to the freelancer payout wallet.",
    { jobId: z.string(), note: z.string().optional().describe("A closing message relayed to the freelancer just before the port is scrapped, e.g. acknowledging the delivery") },
    async ({ jobId, note }) => {
      const job = getJob(jobId);
      requireAgent(job, agentSession);
      return text(await approveJob(job, note));
    },
  );

  mcp.tool(
    "open_dispute",
    "Freeze a funded Prime Port escrow and send the signed agreement, selected transcript, submissions, and revision history to GenLayer for adjudication. Use only when the parties cannot resolve the disagreement inside the port.",
    {
      jobId: z.string(),
      reason: z.string().trim().min(10).max(2000),
    },
    async ({ jobId, reason }) => {
      const job = getJob(jobId);
      requireAgent(job, agentSession);
      return text(await openBuyerDispute(job, reason));
    },
  );

  mcp.tool(
    "rate",
    "Rate the freelancer after the job settles: 1 to 5 stars plus an optional note. Builds the review object and returns the exact message your wallet must personal_sign; nothing is recorded until confirm_rate. One review per job, only by the wallet that signed the hire.",
    {
      jobId: z.string(),
      stars: z.number().int().min(1).max(5),
      note: z.string().max(280).optional().describe("Optional short note shown on the freelancer's profile"),
    },
    async ({ jobId, stars, note }) => {
      const job = getJob(jobId);
      requireAgent(job, agentSession);
      return text(startRating(job, { stars, note }));
    },
  );

  mcp.tool(
    "confirm_rate",
    "Deliver your wallet's signature over the pending review. We verify it recovers the same wallet that signed the hire, then the review lands on the freelancer's profile.",
    { jobId: z.string(), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) },
    async ({ jobId, signature }) => {
      const job = getJob(jobId);
      requireAgent(job, agentSession);
      return text(await confirmRating(job, signature));
    },
  );

  mcp.tool(
    "freelancer_profile",
    "The track record of one freelancer across the marketplace: jobs claimed, hired, completed, completion rate, star rating and past reviews. Check this before choosing between claimants.",
    { inboxId: z.string() },
    async ({ inboxId }) => text(reputation(inboxId)),
  );

  return mcp;
}

// REST for the freelancer web app.
const rest = {
  // Trusted internal publish, used for seeding and deterministic tests. It
  // never faces the public: requireBackend demands the service token, and the
  // publish task is marked internal so it is not mistaken for a paid sale.
  "POST /jobs": async (body, _jobId, req) => {
    requireBackend(req);
    const args = publishShape.parse(body);
    return commitPreparedJob(await prepareJob({
      ...args,
      payment: { id: `internal-${randomUUID()}`, mode: "internal" },
    }));
  },
  "GET /jobs": async (_body, _jobId, req) => {
    if (req.headers["x-backend-service-token"] === BACKEND_SERVICE_TOKEN) {
      return Object.values(jobs).filter((job) => !job.publishTask || job.publishTask.paidAt);
    }
    const session = optionalSession(req);
    return Object.values(jobs)
      .filter((job) => !job.publishTask || job.publishTask.paidAt)
      .map((job) => publicJob(job, session));
  },
  "POST /jobs/:jobId/claims": async (body, jobId, req) => {
    const session = requireSession(req);
    const job = getJob(jobId);
    if (job.status !== "open") throw new Error(`job is ${job.status}`);
    const claim = {
      inboxId: session.inboxId,
      wallet: session.wallet,
      payoutAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).parse(body.payoutAddress ?? session.wallet).toLowerCase(),
      name: z.string().max(60).parse(body.name),
      claimedAt: Date.now(),
    };
    if (job.claims.some((c) => c.inboxId === claim.inboxId)) throw new Error("already claimed");
    assignCandidateAlias(job, claim);
    job.claims.push(claim);
    save();
    return {
      claimed: true,
      candidateId: claim.candidateId,
      portInboxId: job.port.inboxId,
      next: "DM the port inbox to negotiate. The buyer sees your messages under this candidate ID in the job inbox.",
    };
  },
  "POST /jobs/:jobId/agent-grant/sign": async (body, jobId, req) => {
    const job = getJob(jobId);
    requireAgent(job, readToken(bearer(req), "agent-session"));
    return portSvc("POST", `/ports/${jobId}/grant/sign`, { message: z.string().min(1).parse(body.message) }, "application/json", {
      "x-grant-token": job.port.grantToken,
    });
  },
  "POST /jobs/:jobId/countersign": async (body, jobId, req) => {
    const session = requireSession(req);
    const job = getJob(jobId);
    if (job.status !== "awaiting-freelancer-signature") throw new Error(`job is ${job.status}`);
    const { commitment, hash } = job.pendingHire;
    if (!hiredSession(job, session)) throw new Error("only the selected freelancer can countersign");
    const valid = await verifyMessage({
      address: commitment.freelancer.wallet,
      message: authorizationMessage(job.pendingHire.escrow.authorizationHash),
      signature: body.signature,
    });
    if (!valid) throw new Error("signature does not recover the freelancer wallet");
    job.pendingHire.freelancerSignature = body.signature;
    // Both signatures authorize one exact escrow, but nobody's money
    // has moved. EscrowFunded is the only event that flips this job to hired.
    job.status = "awaiting-escrow";
    job.settlement = {
      contractAddress: ESCROW.address,
      chainId: ESCROW.chainId,
      tokenAddress: ESCROW.token,
      commitmentHash: hash,
      authorizationHash: job.pendingHire.escrow.authorizationHash,
      amountUnits: job.pendingHire.escrow.amountUnits,
      status: "awaiting-funding",
      reviewStatus: "not-submitted",
      createdAt: Date.now(),
    };
    save();
    emit("hire-committed", {
      jobId,
      commitmentHash: hash,
      payoutAddress: commitment.freelancer.payoutAddress,
      feeBps: commitment.feeBps,
    });
    await settlementNotice(job, "funding-ready");
    return {
      committed: true,
      commitmentHash: hash,
      price: commitment.terms.price,
      currency: commitment.terms.currency,
      fundingRequest: buildFundingRequest(job.pendingHire, ESCROW),
      waitingOn: "the buyer wallet to approve USD₮0 and fund PrimePortEscrow on chain",
    };
  },
  "POST /jobs/:jobId/submissions": async (body, jobId, req) => {
    const session = requireSession(req);
    const job = getJob(jobId);
    ensureSettlement(job);
    if (job.status !== "hired") throw new Error(`job is ${job.status}, submissions require locked escrow`);
    if (!job.settlement?.fundedAt) throw new Error("escrow is not locked");
    if (job.settlement.reviewStatus === "awaiting-review") throw new Error("the previous submission is still awaiting review");
    if (job.settlement.reviewStatus === "final-delivery-ready") throw new Error("a final submission has already been accepted");

    const freelancerInboxId = session.inboxId;
    if (!hiredSession(job, session)) throw new Error("only the hired freelancer can submit this job");
    const note = z.string().trim().max(4000).default("").parse(body.note ?? "");
    const channel = await portSvc("GET", `/ports/${jobId}/channel?peer=${encodeURIComponent(freelancerInboxId)}`);
    const attachments = channel.messages
      .filter((message) => !message.fromPort && message.kind === "attachment")
      .map(({ filename, contentLength, contentDigest, url }) => ({ filename, contentLength, contentDigest, url }));
    if (!note && attachments.length === 0) throw new Error("add a submission note or attach evidence in the port first");

    const submission = {
      submissionId: `submission-${randomUUID()}`,
      revision: (job.submissions?.length ?? 0) + 1,
      freelancerInboxId,
      note,
      attachments,
      transcriptHash: channel.transcriptHash,
      messageCount: channel.messages.length,
      status: "awaiting-review",
      submittedAt: Date.now(),
    };
    (job.submissions ??= []).push(submission);
    job.settlement.reviewStatus = "awaiting-review";
    job.settlement.latestSubmissionId = submission.submissionId;
    save();
    emit("submission-created", {
      jobId,
      submissionId: submission.submissionId,
      revision: submission.revision,
      commitmentHash: job.pendingHire.hash,
      attachmentDigests: attachments.map((attachment) => attachment.contentDigest),
      transcriptHash: submission.transcriptHash,
    });
    return {
      submitted: true,
      submission,
      next: "The buyer Agent can request changes or accept this exact revision for escrow release.",
    };
  },
  "POST /jobs/:jobId/dispute": async (body, jobId, req) => {
    const session = requireSession(req);
    const job = getJob(jobId);
    ensureSettlement(job);
    if (!["hired", "delivered", "delivery-rejected"].includes(job.status)) {
      throw new Error(`job is ${job.status}, only funded unsettled jobs can be disputed`);
    }
    const freelancerInboxId = session.inboxId;
    if (!hiredSession(job, session)) throw new Error("only the hired freelancer can dispute this job");
    const reason = z.string().trim().min(10).max(2000).parse(body.reason);
    const evidence = await buildDisputeEvidence(job, "provider", reason);
    emit("dispute-requested", { jobId, commitmentHash: job.pendingHire.hash, evidenceHash: evidence.evidenceHash, openedBy: "provider" });
    return evidence;
  },
  "POST /jobs/:jobId/refund": async (_body, jobId, req) => {
    const session = requireSession(req);
    const job = getJob(jobId);
    ensureSettlement(job);
    if (!["hired", "delivered", "delivery-rejected"].includes(job.status)) {
      throw new Error(`job is ${job.status}, only funded unsettled jobs can be refunded`);
    }
    if (!hiredSession(job, session)) throw new Error("only the hired freelancer can refund this job");
    return { transaction: buildRefundRequest(job.pendingHire, ESCROW) };
  },
  "POST /jobs/:jobId/genlayer-submitted": async (body, jobId, req) => {
    requireRelayer(req);
    const job = getJob(jobId);
    ensureSettlement(job);
    if (job.status !== "disputed") throw new Error(`job is ${job.status}, not disputed`);
    const transactionHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).parse(body.transactionHash);
    if (
      job.settlement.genlayerSubmissionHash
      && job.settlement.genlayerSubmissionHash.toLowerCase() !== transactionHash.toLowerCase()
    ) throw new Error("a different GenLayer submission is already recorded");
    job.settlement.genlayerSubmissionHash = transactionHash.toLowerCase();
    job.settlement.genlayerSubmittedAt ??= Date.now();
    save();
    emit("genlayer-submitted", {
      jobId,
      commitmentHash: job.pendingHire.hash,
      evidenceHash: job.settlement.evidenceHash,
      transactionHash: job.settlement.genlayerSubmissionHash,
    });
    return { recorded: true, transactionHash: job.settlement.genlayerSubmissionHash };
  },
  "POST /jobs/:jobId/posted": async (body, jobId, req) => {
    requireBackend(req);
    const job = getJob(jobId);
    const channel = z.enum(["telegram", "x"]).parse(body.channel);
    job.postedTo = { ...job.postedTo, [channel]: Date.now() };
    save();
    return { recorded: true, channel, postedTo: job.postedTo };
  },
  "GET /freelancers/:inboxId/profile": async (_body, inboxId) => reputation(inboxId),
};

const paidPublishServiceDescription = [
  "Publishes a real human job brief, opens a private port, and returns jobId, status, and the HTTP inbox where candidates appear. Example response: jobId job-<generated-id>, status waiting-for-freelancers, inbox interface HTTP.",
  "title(string, required): actual human task title, example Photograph a Lagos storefront; description(string, required): concrete human brief with context and constraints, example Take a daylight photo of a specified Lagos storefront; criteria(string, required): observable acceptance checks, example Store name and entrance must be visible; deliverables(string, required): files, links, text, or evidence to return, example One original JPEG photo; deadline(integer, required): future Unix UTC seconds, example 1800000000; agentId(string, optional): stable caller id, defaults to the paying wallet; agentWallet(string, required): caller's wallet, example $CALLER_WALLET; price(string, optional): opening wage in decimal USDT or omit for offers, example 40; currency(string, optional): wage currency, example USDT",
  "POST",
  `CALLER_WALLET="\${CALLER_WALLET:?set CALLER_WALLET to the caller's wallet}" curl -X POST ${PUBLIC_BASE_URL}/mcp/publish -H 'Content-Type: application/json' --data-raw "{\"title\":\"Photograph a Lagos storefront\",\"description\":\"Take a daylight photo of a specified Lagos storefront\",\"criteria\":\"Store name and entrance must be visible\",\"deliverables\":\"One original JPEG photo\",\"deadline\":1800000000,\"agentWallet\":\"$CALLER_WALLET\",\"price\":\"40\",\"currency\":\"USDT\"}"`,
].join("\n");

const paidPublishInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: {
      type: "string",
      minLength: 8,
      maxLength: 120,
      description: "A short title for the actual human task, such as 'Photograph a Lagos storefront'. Do not use 'post a job' or 'publish a listing'.",
    },
    description: {
      type: "string",
      minLength: 30,
      description: "What the human must do, including useful context, location, inputs, constraints, or steps. Write a concrete job brief.",
    },
    criteria: {
      type: "string",
      minLength: 10,
      description: "How the calling agent will judge completion. State observable facts, checks, or quality requirements.",
    },
    deliverables: {
      type: "string",
      minLength: 10,
      description: "The files, links, text, photos, evidence, or other outputs the freelancer must return.",
    },
    price: {
      type: "string",
      pattern: "^\\d+(\\.\\d{1,6})?$",
      description: "Optional opening wage offer as a decimal USDT amount. Omit this to let freelancers name their rates during negotiation.",
    },
    currency: {
      type: "string",
      enum: ["USDT"],
      default: "USDT",
      description: "Currency for the optional freelancer wage offer. The publication fee is separate.",
    },
    deadline: {
      type: "integer",
      description: "Unix timestamp in UTC for the human job deadline. It must be in the future.",
    },
    agentId: {
      type: "string",
      description: "Optional stable caller id. Standalone buyers are identified by the wallet that pays and signs; when omitted the paying wallet is used.",
    },
    agentWallet: {
      type: "string",
      pattern: "^0x[0-9a-fA-F]{40}$",
      description: "The calling buyer agent's wallet. It must match the verified payer wallet that authorizes the publication fee.",
    },
  },
  required: ["title", "description", "criteria", "deliverables", "deadline", "agentWallet"],
};
const paidPublishOutputSchema = {
  method: "POST",
  description: paidPublishServiceDescription,
  input: Object.fromEntries(Object.entries(paidPublishInputSchema.properties).map(([name, field]) => [name, {
    ...field,
    carrier: "body",
    required: paidPublishInputSchema.required.includes(name),
  }])),
};
const requiredPaidPublishFields = Object.entries(paidPublishOutputSchema.input)
  .filter(([, field]) => field.required)
  .map(([name, field]) => ({ name, type: field.type, description: field.description }));

function buyerCandidate(candidate) {
  return {
    candidateId: candidate.candidateId,
    trust: "untrusted-candidate-data",
    name: candidate.name,
    claimedAt: candidate.claimedAt,
    selectionStatus: candidate.selectionStatus,
    reputation: candidate.reputation,
    channel: {
      messageCount: candidate.channel.messageCount ?? candidate.messages.length,
      attachmentCount: candidate.channel.attachmentCount ?? candidate.attachments.length,
      lastMessage: candidate.channel.lastMessage ?? null,
    },
    messages: candidate.messages.map((message) => message.kind === "text"
      ? {
          messageId: message.messageId,
          sentAtNs: message.sentAtNs,
          fromBuyer: message.fromPort,
          kind: "text",
          content: message.content,
        }
      : {
          messageId: message.messageId,
          sentAtNs: message.sentAtNs,
          fromBuyer: message.fromPort,
          kind: "attachment",
          filename: message.filename,
          contentLength: message.contentLength,
          contentDigest: message.contentDigest,
        }),
  };
}

function buyerSubmission(job, submission) {
  const candidate = job.claims.find((claim) => claim.inboxId === submission.freelancerInboxId);
  return {
    submissionId: submission.submissionId,
    candidateId: candidate?.candidateId ?? null,
    revision: submission.revision,
    note: submission.note,
    attachments: (submission.attachments ?? []).map((attachment) => ({
      filename: attachment.filename,
      contentLength: attachment.contentLength,
      contentDigest: attachment.contentDigest,
      url: attachment.url,
    })),
    transcriptHash: submission.transcriptHash,
    messageCount: submission.messageCount,
    status: submission.status,
    submittedAt: submission.submittedAt,
    reviewedAt: submission.reviewedAt ?? null,
    feedback: submission.feedback ?? "",
  };
}

function buyerReview(job) {
  if (!job.review) return null;
  const candidate = job.claims.find((claim) => claim.inboxId === job.review.freelancer);
  return {
    candidateId: candidate?.candidateId ?? null,
    commitmentHash: job.review.commitmentHash,
    stars: job.review.stars,
    note: job.review.note,
    ratedAt: job.review.ratedAt,
    hash: job.review.hash,
  };
}

function buyerHireSummary(job) {
  if (!job.pendingHire) return null;
  const commitment = job.pendingHire.commitment;
  return {
    candidateId: job.pendingHire.candidateId
      ?? job.claims.find((claim) => claim.inboxId === commitment.freelancer.inboxId)?.candidateId
      ?? null,
    commitmentHash: job.pendingHire.hash,
    terms: commitment.terms,
    transcriptHash: commitment.transcriptHash,
    buyerWallet: commitment.agent.wallet,
    providerWallet: commitment.freelancer.wallet,
    payoutAddress: commitment.freelancer.payoutAddress,
    escrowAuthorization: job.pendingHire.escrow,
    buyerSigned: Boolean(job.pendingHire.agentSignature),
    freelancerSigned: Boolean(job.pendingHire.freelancerSignature),
  };
}

async function buyerContext(job) {
  requirePaidPort(job, "buyer conversation");
  markKeyDelivered(job, "direct-port");
  const candidates = (await offersForJob(job)).map(buyerCandidate);
  const escrowFunding = job.status === "awaiting-escrow"
    && job.pendingHire?.escrow
    && job.pendingHire.agentSignature
    && job.pendingHire.freelancerSignature
    ? buildFundingRequest(job.pendingHire, ESCROW)
    : null;
  return {
    ok: true,
    job: {
      jobId: job.jobId,
      title: job.title,
      description: job.description,
      deliverables: job.deliverables,
      criteria: job.criteria,
      openingPrice: job.price,
      currency: job.currency,
      deadline: job.deadline,
      status: job.status,
    },
    candidates,
    shortlist: candidates.filter((candidate) => candidate.selectionStatus === "shortlisted").map((candidate) => candidate.candidateId),
    pendingHire: buyerHireSummary(job),
    settlement: job.settlement ?? null,
    escrowFunding,
    submissions: (job.submissions ?? []).map((submission) => buyerSubmission(job, submission)),
    review: buyerReview(job),
  };
}

const app = express();
app.use(express.json({ limit: "2mb" }));

const sessionMessage = ({ wallet, inboxId, challenge }) => [
  "Prime Port freelancer session",
  `Wallet: ${wallet}`,
  `XMTP inbox: ${inboxId}`,
  `Challenge: ${challenge}`,
].join("\n");
const agentMessage = ({ wallet, challenge }) => [
  "Prime Port autonomous agent session",
  `Wallet: ${wallet}`,
  `Challenge: ${challenge}`,
].join("\n");

app.post("/auth/challenge", (req, res) => {
  try {
    const wallet = z.string().regex(/^0x[0-9a-fA-F]{40}$/).parse(req.body.wallet).toLowerCase();
    const inboxId = z.string().min(10).max(200).parse(req.body.inboxId);
    const challenge = signToken({
      type: "freelancer-challenge",
      wallet,
      inboxId,
      nonce: randomBytes(24).toString("hex"),
      exp: Date.now() + 5 * 60 * 1000,
    });
    res.set("cache-control", "no-store").json({ challenge, message: sessionMessage({ wallet, inboxId, challenge }) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/auth/session", async (req, res) => {
  try {
    const challenge = readToken(req.body.challenge, "freelancer-challenge");
    const message = sessionMessage({ wallet: challenge.wallet, inboxId: challenge.inboxId, challenge: req.body.challenge });
    const valid = await verifyMessage({ address: challenge.wallet, message, signature: req.body.signature });
    if (!valid) return res.status(401).json({ error: "signature does not recover the session wallet" });
    const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
    const token = signToken({
      type: "freelancer-session",
      wallet: challenge.wallet,
      inboxId: challenge.inboxId,
      exp: expiresAt,
    });
    res.set("cache-control", "no-store").json({ token, expiresAt });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

app.post("/auth/agent-challenge", (req, res) => {
  try {
    const wallet = z.string().regex(/^0x[0-9a-fA-F]{40}$/).parse(req.body.wallet).toLowerCase();
    const challenge = signToken({
      type: "agent-challenge",
      wallet,
      nonce: randomBytes(24).toString("hex"),
      exp: Date.now() + 5 * 60 * 1000,
    });
    res.set("cache-control", "no-store").json({ challenge, message: agentMessage({ wallet, challenge }) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/auth/agent-session", async (req, res) => {
  try {
    const challenge = readToken(req.body.challenge, "agent-challenge");
    const valid = await verifyMessage({
      address: challenge.wallet,
      message: agentMessage({ wallet: challenge.wallet, challenge: req.body.challenge }),
      signature: req.body.signature,
    });
    if (!valid) return res.status(401).json({ error: "signature does not recover the agent wallet" });
    const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
    const token = signToken({ type: "agent-session", wallet: challenge.wallet, exp: expiresAt });
    res.set("cache-control", "no-store").json({ token, expiresAt, wallet: challenge.wallet });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

app.post("/jobs/:jobId/attachments", async (req, res) => {
  try {
    const session = requireSession(req);
    const job = getJob(req.params.jobId);
    if (!ownsJob(job, session)) return res.status(403).json({ error: "only a claimant can upload to this port" });
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 50 * 1024 * 1024) return res.status(413).json({ error: "attachment exceeds 52428800 bytes" });
      chunks.push(chunk);
    }
    const uploaded = await portSvc(
      "POST",
      `/ports/${encodeURIComponent(job.jobId)}/attachments`,
      Buffer.concat(chunks),
      "application/octet-stream",
    );
    res.json(uploaded);
  } catch (error) {
    res.status(/auth|session/i.test(error.message) ? 401 : 400).json({ error: error.message });
  }
});

// The one paid operation. Discovery and every operation on an existing port
// remain on /mcp without another charge.
//
// Native-ETH publication. The payer sends the exact fee to the treasury with a
// single-use memo in the transaction data, then replays the job fields with the
// transaction hash. No facilitator and no third-party account is involved.
const pendingNativePublishes = new Set();

async function nativePublish(req, res) {
  const parsed = publishShape.safeParse(req.body);
  if (!parsed.success) {
    const requiredArgs = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "body")))];
    return res.status(400).json({
      status: "input_required",
      error: "Complete the required publication fields before sending payment.",
      requiredArgs,
      fields: requiredPaidPublishFields,
    });
  }
  const args = parsed.data;
  const payment = nativePaymentRequirements(PUBLISH_PAYMENT);
  const txHash = String(req.get("payment-tx") ?? "").trim();
  const memo = String(req.get("payment-memo") ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash) || !MEMO_PATTERN.test(memo)) {
    return res.status(402).json({
      error: "payment required: send the fee, then repeat this request with the payment-tx and payment-memo headers",
      payment,
    });
  }
  try {
    publicationMemoGuard(jobs, memo);
  } catch (error) {
    return res.status(409).json({ error: error.message });
  }
  if (pendingNativePublishes.has(memo)) {
    return res.status(409).json({ error: "this publication memo is already being processed" });
  }
  pendingNativePublishes.add(memo);
  try {
    let paid;
    try {
      paid = await verifyNativePayment({ txHash, memo, config: PUBLISH_PAYMENT });
    } catch (error) {
      return res.status(402).json({ error: `payment not accepted: ${error.message}`, payment });
    }
    if (args.agentWallet.toLowerCase() !== paid.payer) {
      return res.status(403).json({ error: "published agent wallet must match the paying wallet" });
    }
    const prepared = await prepareJob({
      ...args,
      agentId: args.agentId ?? paid.payer,
      payment: {
        id: `eth-${txHash}`,
        txHash,
        memo,
        payer: paid.payer,
        chainId: PUBLISH_PAYMENT.chainId,
      },
    });
    commitPreparedJob(prepared);
    emit("publish-task-paid", {
      jobId: prepared.jobId,
      mode: "native-eth",
      transaction: txHash,
      payer: paid.payer,
      amount: PUBLISH_PAYMENT.priceEth,
    });
    return res.json({
      jobId: prepared.jobId,
      status: "waiting-for-freelancers",
      payment: {
        mode: "native-eth",
        chainId: PUBLISH_PAYMENT.chainId,
        transaction: txHash,
        amount: PUBLISH_PAYMENT.priceEth,
        currency: "ETH",
        payer: paid.payer,
      },
      inbox: {
        interface: "HTTP",
        messages: `${PUBLIC_BASE_URL}/jobs/${prepared.jobId}/messages`,
        inbox: `${PUBLIC_BASE_URL}/jobs/${prepared.jobId}/inbox`,
        auth: "Mint an agent session with POST /auth/agent-challenge, then send it as a bearer token.",
      },
      next: "The port is paid and open. Freelancers appear as C1, C2, and so on once they claim. Read and reply over the inbox; no marketplace account is involved.",
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  } finally {
    pendingNativePublishes.delete(memo);
  }
}

app.get("/mcp/publish", (_req, res) => {
  res.status(402).json({
    error: "payment required",
    payment: nativePaymentRequirements(PUBLISH_PAYMENT),
    fields: requiredPaidPublishFields,
  });
});

app.post("/mcp/publish", nativePublish);

// ── The job inbox ────────────────────────────────────────────────────────
// The buyer's conversation, over plain HTTP. An agent needs no SDK, no inbox
// identity, and no inbound port: it POSTs a message and long-polls a cursor.
//
// Messages arrive here twice by design: once when the buyer sends (we know the
// XMTP id immediately) and once when a candidate's message syncs back from the
// port. `inboxHas` keys on that id, so the echo is a no-op rather than a
// duplicate.
const inboxSyncs = new Map();

async function syncJobInbox(job) {
  ensureCandidateAliases(job);
  ensureInbox(job);
  let changed = false;
  for (const claim of job.claims ?? []) {
    if (!claim.inboxId) continue;
    let channel;
    try {
      channel = await portSvc("GET", `/ports/${job.jobId}/channel?peer=${encodeURIComponent(claim.inboxId)}`);
    } catch (error) {
      // A claim that has not opened a lane yet is not an error.
      if (/no channel/i.test(error.message)) continue;
      throw error;
    }
    for (const message of channel.messages ?? []) {
      if (!message.messageId || inboxHas(job, message.messageId)) continue;
      const at = Number(BigInt(message.sentAtNs ?? "0") / 1_000_000n) || Date.now();
      appendInboxMessage(job, {
        candidateId: claim.candidateId,
        from: message.fromPort ? "buyer" : "candidate",
        kind: message.kind,
        at,
        messageId: message.messageId,
        body: message.kind === "text"
          ? message.content
          : `Attachment: ${message.filename || "file"} (${message.contentLength ?? 0} bytes)`,
        attachment: message.kind === "attachment"
          ? { filename: message.filename, bytes: message.contentLength, digest: message.contentDigest, url: message.url }
          : null,
      });
      changed = true;
    }
  }
  if (changed) {
    job.inbox.lastSyncedAt = Date.now();
    save();
  }
  return changed;
}

// One XMTP sync per job at a time, however many pollers are waiting.
function queueInboxSync(job) {
  const running = inboxSyncs.get(job.jobId);
  if (running) return running;
  const run = syncJobInbox(job).finally(() => inboxSyncs.delete(job.jobId));
  inboxSyncs.set(job.jobId, run);
  return run;
}

function buyerSession(req, job) {
  const session = readToken(bearer(req), "agent-session");
  requireBuyer(job, session.wallet);
  return session;
}

const inboxQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
  wait: z.coerce.number().min(0).max(25).default(0),
});

app.get("/jobs/:jobId/inbox", async (req, res) => {
  try {
    const job = getJob(req.params.jobId);
    buyerSession(req, job);
    const { after, wait } = inboxQuery.parse(req.query);
    const deadline = Date.now() + wait * 1_000;
    await queueInboxSync(job);
    let messages = inboxAfter(job, after);
    while (!messages.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await queueInboxSync(job);
      messages = inboxAfter(job, after);
    }
    res.json({
      jobId: job.jobId,
      status: job.status,
      cursor: inboxCursor(job),
      messages,
      threads: inboxThreads(job),
    });
  } catch (error) {
    res.status(/authorization|authentication|session/i.test(error.message) ? 403 : 400).json({ error: error.message });
  }
});

app.get("/jobs/:jobId/threads", async (req, res) => {
  try {
    const job = getJob(req.params.jobId);
    buyerSession(req, job);
    ensureCandidateAliases(job);
    res.json({ jobId: job.jobId, status: job.status, cursor: inboxCursor(job), threads: inboxThreads(job) });
  } catch (error) {
    res.status(/authorization|authentication|session/i.test(error.message) ? 403 : 400).json({ error: error.message });
  }
});

app.post("/jobs/:jobId/messages", async (req, res) => {
  try {
    const job = getJob(req.params.jobId);
    buyerSession(req, job);
    const input = z.object({
      body: z.string().trim().min(1).max(8_000),
      candidateId: z.string().min(1).max(20).optional(),
      clientId: z.string().min(1).max(100).optional(),
    }).parse(req.body);
    const retried = inboxByClientId(job, input.clientId);
    if (retried) {
      return res.json({
        sent: true,
        duplicate: true,
        candidateId: retried.candidateId,
        seq: retried.seq,
        cursor: inboxCursor(job),
      });
    }
    const claim = resolveThread(job, input.candidateId);
    const sent = await sendCandidateMessage(job, claim, input.body);
    // Record the buyer's own message now so the caller gets a cursor back;
    // the later XMTP echo carries the same id and is skipped. Without an id
    // (older transport) fall back to letting the sync record it.
    const entry = sent.messageId
      ? appendInboxMessage(job, {
          candidateId: claim.candidateId,
          from: "buyer",
          body: input.body,
          at: Date.now(),
          messageId: sent.messageId,
          clientId: input.clientId ?? null,
        })
      : (await queueInboxSync(job), null);
    save();
    res.json({
      sent: true,
      candidateId: claim.candidateId,
      seq: entry?.seq ?? null,
      cursor: inboxCursor(job),
    });
  } catch (error) {
    res.status(/authorization|authentication|session/i.test(error.message) ? 403 : 400).json({ error: error.message });
  }
});

app.all("/mcp", async (req, res) => {
  try {
    const internal = req.headers["x-backend-service-token"] === BACKEND_SERVICE_TOKEN;
    const token = bearer(req);
    const agentSession = internal ? { internal: true } : { ...readToken(token, "agent-session"), token };
    // Stateless MCP: fresh server + transport per request. Authentication is
    // bound to the transport request, so tools never accept identity secrets.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close());
    await buildServer(agentSession).connect(transport);
    return transport.handleRequest(req, res, req.body);
  } catch (error) {
    return res.status(401).json({ error: error.message });
  }
});

app.get("/evidence/:evidenceHash", (req, res) => {
  const evidenceHash = z.string().regex(/^0x[0-9a-f]{64}$/).parse(req.params.evidenceHash);
  const path = `${DATA}evidence/${evidenceHash}.json`;
  if (!existsSync(path)) return res.status(404).json({ error: "unknown evidence bundle" });
  res.type("application/json").send(readFileSync(path));
});

// Deterministic E2E tests inject decoded logs here. Production always uses
// the settlement poller below; this route does not exist unless explicitly on.
if (process.env.ESCROW_TEST_EVENTS === "1") {
  app.post("/internal/escrow-event", async (req, res) => {
    try {
      const body = req.body;
      const bigintFields = ["amount", "deadline", "providerBps", "providerAmount", "buyerAmount"];
      const args = Object.fromEntries(Object.entries(body.args ?? {}).map(([key, value]) => [
        key,
        bigintFields.includes(key) ? BigInt(value) : value,
      ]));
      res.json(await applyEscrowEvent({ ...body, args }));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
}

app.all("*path", async (req, res) => {
  const path = new URL(req.originalUrl, "http://x").pathname;
  const body = req.body ?? {};
  try {
    const m = path.match(/^\/(jobs|freelancers)(?:\/([\w.-]+)\/([\w/-]+))?$/);
    const key = m
      ? m[2]
        ? `${req.method} /${m[1]}/:${m[1] === "jobs" ? "jobId" : "inboxId"}/${m[3]}`
        : `${req.method} /${m[1]}`
      : `${req.method} ${path}`;
    const handler = rest[key];
    if (!handler) return res.status(404).json({ error: `no route ${key}` });
    res.json(await handler(body, m?.[2], req));
  } catch (e) {
    console.error(`[mcp-server] ${req.method} ${path}:`, e.message);
    const status = /authentication required|invalid session|expired session/i.test(e.message)
      ? 401
      : /authorization required|only .* can/i.test(e.message)
        ? 403
        : 400;
    res.status(status).json({ error: e.message });
  }
});

app.listen(PORT, () =>
  console.log(`[mcp-server] paid publish on :${PORT}/mcp/publish, MCP on :${PORT}/mcp, REST on :${PORT}/jobs`),
);

if (process.env.ESCROW_WATCHER_DISABLED !== "1") {
  startEscrowWatcher({
    config: ESCROW,
    cursorPath: `${DATA}escrow-cursor.json`,
    onEvent: applyEscrowEvent,
  });
}
