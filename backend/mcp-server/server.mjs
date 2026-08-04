// The agent-facing surface of Prime Port: MCP tools over streamable HTTP.
// Tools: publish, get_offers, negotiate, hire, confirm_hire, approve, plus
// port_connect as an advanced compatibility path. The primary buyer surface
// is one ready-made OKX A2A conversation that relays deterministic actions
// into separate freelancer channels behind stable candidate aliases.
//
// Two other surfaces share the process:
//   - REST for the freelancer web app (claim a job, countersign the hire),
//   - an append-only events file (data/events.jsonl) that distribution and
//     contracts consume (job-created, publish-task-paid, publish-delivered,
//     hire-committed, job-task-linked, job-task-escrowed, submission-created,
//     submission-accepted, and job-completed).
//     marketplace escrow calls hang off those same events; wiring them to
//     onchainos is the next lane deliverable and marked MARKETPLACE below.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-express";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { z } from "zod";
import { keccak256, toBytes, verifyMessage } from "viem";
import { canonicalize, commitmentHash } from "../commitment/commitment.mjs";
import { clearLegacyPublicationPrice } from "../listing-price.mjs";
import { requestStateBackup } from "../state-sync.mjs";
import {
  assignCandidateAlias,
  enqueueA2AMessage,
  ensureA2AState,
  ensureCandidateAliases,
  findCandidate,
  formatCandidateRelay,
  leaseOutboxItems,
  pruneDeliveredCandidateMessages,
  rememberPortMessage,
  welcomeMessage,
} from "../a2a-bridge/core.mjs";
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
  paymentPayloadKey,
  paymentPayerFromHeader,
  paymentSignatureHeader,
} from "./x402-request.mjs";

const PORT = Number(process.env.PORT ?? 8792);
const PORT_SVC = process.env.PORT_SVC ?? "http://localhost:8791";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? "https://prime-port-latest.onrender.com";
const PORT_SERVICE_TOKEN = process.env.PORT_SERVICE_TOKEN ?? randomBytes(32).toString("hex");
const SESSION_SECRET = process.env.SESSION_SECRET ?? randomBytes(32).toString("hex");
const BACKEND_SERVICE_TOKEN = process.env.BACKEND_SERVICE_TOKEN ?? randomBytes(32).toString("hex");
const PAY_TO_ADDRESS = process.env.PAY_TO_ADDRESS ?? "0x7ab4daee18a449eb76a8a7d66cb02cf34a28563e";
const PUBLISH_PRICE = process.env.PUBLISH_PRICE ?? "$1.00";
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
const numericPublishPrice = PUBLISH_PRICE.match(/\d+(?:\.\d+)?/)?.[0] ?? "1";
if (Object.values(jobs).some((job) => clearLegacyPublicationPrice(job, numericPublishPrice))) save();
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

// The public x402 purchase pays the flat fee and opens the port. The later
// negotiated wage is internal Prime Port escrow and never becomes another
// OKX marketplace service.
const requirePaidPort = (job, verb) => {
  if (!job.publishTask)
    throw new Error(`${verb} needs a paid port: this job was published without a marketplace publish task (pass marketplaceJobId when publishing, or buy the publish service on the marketplace and let the watcher vend it)`);
  if (!job.publishTask.paidAt)
    throw new Error(`${verb} needs a paid port: publish task ${job.publishTask.marketplaceJobId} exists but its escrow has not locked yet`);
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
    marketplaceJobId: job.publishTask.marketplaceJobId,
    via,
    portInboxId: job.port.inboxId,
  });
};

// Watcher-facing endpoints carry payment facts; a shared token keeps random
// callers from marking their own port paid. Unset means open (local dev).
const WATCHER_TOKEN = process.env.WATCHER_TOKEN ?? "";
const RELAYER_TOKEN = process.env.RELAYER_TOKEN ?? "";
const requireWatcher = (req) => {
  if (WATCHER_TOKEN && req.headers["x-watcher-token"] !== WATCHER_TOKEN)
    throw new Error("watcher token required");
};
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
  if (job.a2a?.enabled) {
    ensureCandidateAliases(job);
    const candidate = job.claims.find((claim) => claim.inboxId === hiredInboxId(job));
    enqueueA2AMessage(job, {
      eventId: `settlement:${kind}:${job.pendingHire.hash}`,
      kind: "escrow-update",
      candidateId: candidate?.candidateId ?? null,
      message: [
        `[Prime Port | ${job.jobId} | ${candidate?.candidateId ?? "selected candidate"} | ${job.title}]`,
        `Escrow update: ${kind}`,
        `Commitment: ${job.pendingHire.hash}`,
        `Amount: ${job.pendingHire.commitment.terms.price} ${job.pendingHire.commitment.terms.currency}`,
        `Confirmed transaction: ${job.settlement?.lastTransactionHash ?? "not confirmed yet"}`,
      ].join("\n"),
    });
  }
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
// callers: the MCP publish tool (agents talking MCP) and REST POST /jobs
// (the marketplace watcher vending a designation into a listing).
const publishShape = z.object({
  description: z.string().min(30),
  deliverables: z.string().min(10),
  criteria: z.string().min(10),
  price: z.string().regex(/^\d+(\.\d{1,6})?$/).optional(),
  currency: z.literal("USDT").default("USDT"),
  // Payment clients carry --param values as strings on the paid HTTP replay.
  // Accept both that wire shape and native JSON numbers, then store a number.
  deadline: z.coerce.number().int(),
  agentId: z.string(),
  agentWallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  title: z.string().min(8).max(120).refine((title) => !/^(post|publish|help me post|set up)\b/i.test(title), "title must describe the actual freelancer job"),
  marketplaceJobId: z.string().optional(),
  conversationJobId: z.string().min(1).max(300).optional(),
});
const paidPublishShape = publishShape.omit({ marketplaceJobId: true });

async function prepareJob(args) {
  const jobId = `job-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const port = await portSvc("POST", "/ports", { jobId });
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
    agent: { agentId: args.agentId, wallet: args.agentWallet.toLowerCase() },
    feeBps: FEE_BPS,
    port: { inboxId: port.inboxId, address: port.address, grantToken: port.grantToken },
    claims: [],
    submissions: [],
    // The paid service opens one ready-made OKX conversation for the buyer.
    // Freelancer XMTP channels remain hidden behind stable candidate aliases.
    a2a: {
      version: 1,
      enabled: true,
      buyerAgentId: String(args.agentId),
      conversationJobId: args.conversationJobId ?? null,
      outbox: [],
      seenPortMessageIds: [],
    },
    // Which social channels this job has been posted to, and when. Written
    // once per channel by POST /jobs/:jobId/posted so a redeploy never
    // re-posts. Lives on the job so it rides the persisted, backed-up state.
    postedTo: {},
    // The marketplace order that bought this listing IS the publish task.
    // paidAt lands when the watcher sees its escrow lock; keyDeliveredAt when
    // the agent takes the port. Both are settlement facts, not our opinions.
    ...(args.marketplaceJobId
      ? {
          marketplaceJobId: args.marketplaceJobId,
          publishTask: { marketplaceJobId: args.marketplaceJobId, paidAt: null, keyDeliveredAt: null },
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
  ensureA2AState(jobs[jobId]);
  save();
  emit("job-created", {
    jobId,
    title: job.title,
    price: job.price,
    deadline: job.deadline,
    marketplaceJobId: job.marketplaceJobId,
  });
  return { jobId, port };
}

function stagePreparedJob(prepared) {
  if (jobs[prepared.jobId]) throw new Error(`job ${prepared.jobId} already exists`);
  ensureA2AState(prepared.job);
  jobs[prepared.jobId] = prepared.job;
  save();
}

async function publishJob(args) {
  return commitPreparedJob(await prepareJob(args));
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
  markKeyDelivered(job, "okx-a2a-conversation");
  await portSvc("POST", `/ports/${job.jobId}/messages`, { peerInboxId: claim.inboxId, content: message });
  const channel = await portSvc("GET", `/ports/${job.jobId}/channel?peer=${encodeURIComponent(claim.inboxId)}`);
  return { sent: true, candidateId: claim.candidateId, channel: channel.messages };
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
    then: "After the freelancer countersigns, Prime Port will return the exact X Layer approval and funding transactions. No USDT has moved yet.",
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
    next: "The buyer wallet must sign and broadcast this transaction. Settlement only changes after EscrowReleased is observed on X Layer.",
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
    next: "The buyer wallet must sign and broadcast the openDispute transaction. Prime Port submits to GenLayer only after DisputeOpened is observed on X Layer.",
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
    "publish",
    "Internal marketplace bridge for publishing a job. Public agents must use the x402-protected /mcp/publish endpoint.",
    {
      publishToken: z.string().describe("Internal marketplace bridge credential"),
      criteria: z.string().min(10).describe("Acceptance criteria, plain text. This exact text goes into the signed hire commitment."),
      description: z.string().min(30).describe("A concrete description of the human work. Generic instructions such as 'post a job' are rejected."),
      deliverables: z.string().min(10).describe("The files, output, or evidence the freelancer must provide."),
      price: z.string().regex(/^\d+(\.\d{1,6})?$/).optional().describe("Offered price as a decimal string, e.g. '40'. Omit to list the job open to offers, with no anchor price: the freelancer names their rate and you settle it in negotiation."),
      currency: z.literal("USDT").default("USDT"),
      deadline: z.coerce.number().int().describe("Unix seconds UTC"),
      agentId: z.string().describe("Your OKX marketplace agent id"),
      agentWallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("Your marketplace wallet; it will sign the hire commitment"),
      title: z.string().min(8).max(120).refine((title) => !/^(post|publish|help me post|set up)\b/i.test(title), "title must describe the actual freelancer job"),
      marketplaceJobId: z.string().optional().describe("The OKX task id of the publish task you opened against our 'Job publishing' service. Without it the listing goes up, but port_connect, negotiate and hire stay locked: the publish fee pays for the port."),
      conversationJobId: z.string().min(1).max(300).optional().describe("Optional current OKX A2A job id. When supplied, Prime Port binds the ready-made buyer conversation exactly. Otherwise it reuses the latest existing conversation with the buyer agent."),
    },
    async (args) => {
      if (args.publishToken !== BACKEND_SERVICE_TOKEN) throw new Error("publish service authorization required");
      if (agentSession?.wallet && args.agentWallet.toLowerCase() !== agentSession.wallet) {
        throw new Error("published agent wallet must match the authenticated wallet");
      }
      const { jobId, port } = await publishJob(args);
      const job = getJob(jobId);
      return text({
        jobId,
        port,
        conversation: job.a2a?.enabled ? {
          interface: "OKX A2A",
          primePortAgentId: String(process.env.EXPECTED_OKX_AGENT_ID ?? "5982"),
          jobId: job.a2a.conversationJobId,
        } : null,
        next: "Freelancers will appear as C1, C2, and so on in the buyer's existing OKX conversation after the publish task escrow locks.",
      });
    },
  );

  mcp.tool(
    "port_connect",
    "Advanced compatibility path for runtimes that explicitly want direct port control. Most buyers should stay in the ready-made OKX conversation and never call this tool.",
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
    "Send a message to one claimant through the port. The ready-made OKX buyer conversation calls this routing path with a stable candidate ID. This MCP form remains for compatible agent clients.",
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
    "Commit to one claimant at the negotiated terms. Builds the hire commitment (criteria, price, deadline, payout address, transcript hash of this channel) and returns the exact message your wallet must personal_sign. Nothing locks until both parties sign and EscrowFunded is confirmed on X Layer.",
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
    "Deliver your wallet's signature over the exact escrow authorization. We verify it, then the freelancer countersigns the same authorization in the web app. Both signatures authorize funding, but escrow is locked only after the X Layer EscrowFunded event.",
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
    "Confirm that you want to approve the accepted revision. Prime Port returns the exact X Layer transaction that releases escrow directly to the freelancer payout wallet.",
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
  "POST /jobs": async (body, _jobId, req) => {
    requireBackend(req);
    return publishJob(publishShape.parse(body));
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
      next: "DM the port inbox to negotiate. The buyer sees your messages under this candidate ID in their existing OKX conversation.",
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
    // Both signatures authorize one exact X Layer escrow, but nobody's money
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
      waitingOn: "the buyer wallet to approve USD₮0 and fund PrimePortEscrow on X Layer",
    };
  },
  "POST /jobs/:jobId/submissions": async (body, jobId, req) => {
    const session = requireSession(req);
    const job = getJob(jobId);
    ensureSettlement(job);
    if (job.status !== "hired") throw new Error(`job is ${job.status}, submissions require locked escrow`);
    if (!job.settlement?.fundedAt) throw new Error("X Layer escrow is not locked");
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
      next: "The buyer Agent can request changes or accept this exact revision for X Layer escrow release.",
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
  // Watcher-facing: payment facts observed on the marketplace. The board
  // never asks the marketplace anything; the watcher tells it what happened.
  "POST /jobs/:jobId/publish-task/paid": async (body, jobId, req) => {
    requireWatcher(req);
    const job = getJob(jobId);
    if (!job.publishTask) throw new Error("job has no publish task");
    if (body.marketplaceJobId !== job.publishTask.marketplaceJobId)
      throw new Error(`marketplaceJobId does not match this job's publish task`);
    if (!job.publishTask.paidAt) {
      job.publishTask.paidAt = Date.now();
      save();
      emit("publish-task-paid", { jobId, marketplaceJobId: job.publishTask.marketplaceJobId });
    }
    return { paid: true };
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

const okxFacilitator = new OKXFacilitatorClient({
  apiKey: process.env.OKX_API_KEY ?? "",
  secretKey: process.env.OKX_SECRET_KEY ?? "",
  passphrase: process.env.OKX_PASSPHRASE ?? "",
  baseUrl: process.env.OKX_BASE_URL ?? "https://web3.okx.com",
  syncSettle: true,
});
const testSettlementEnabled = process.env.NODE_ENV === "test" && process.env.X402_TEST_SETTLEMENT === "1";
const testFacilitator = {
  getSupported: async () => ({
    kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:196" }],
    extensions: [],
    signers: {},
  }),
  verify: async (payload) => ({
    isValid: true,
    payer: payload?.payload?.authorization?.from,
  }),
  settle: async (payload, requirements) => ({
    success: true,
    status: "success",
    transaction: `0x${"ab".repeat(32)}`,
    network: requirements.network,
    payer: payload?.payload?.authorization?.from,
  }),
};
// This mode is only for local unpaid-challenge tests. Payment verification and
// settlement still go to OKX and therefore still require real credentials.
const facilitator = testSettlementEnabled
  ? testFacilitator
  : process.env.X402_OFFLINE_CHALLENGE === "1"
  ? {
      getSupported: async () => ({
        kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:196" }],
        extensions: [],
        signers: {},
      }),
      verify: (...args) => okxFacilitator.verify(...args),
      settle: (...args) => okxFacilitator.settle(...args),
    }
  : okxFacilitator;
const paymentServer = new x402ResourceServer(facilitator)
  .register("eip155:196", new ExactEvmScheme());
const pendingPaidPublishes = new Map();

paymentServer.onAfterSettle(async ({ paymentPayload, requirements, result }) => {
  const key = paymentPayloadKey(paymentPayload);
  const pending = pendingPaidPublishes.get(key);
  if (!pending) return;
  try {
    pending.job.publishTask.paidAt = Date.now();
    pending.job.publishTask.settlement = {
      amount: requirements.amount,
      asset: requirements.asset,
      network: result.network ?? requirements.network,
      payer: result.payer ?? pending.payer,
      status: result.status ?? "success",
      transaction: result.transaction ?? null,
    };
    commitPreparedJob(pending);
    emit("publish-task-paid", {
      jobId: pending.jobId,
      marketplaceJobId: pending.job.marketplaceJobId,
      paymentMode: "x402",
      transaction: result.transaction ?? null,
    });
    pendingPaidPublishes.delete(key);
  } catch (error) {
    console.error(`[mcp-server] CRITICAL: payment settled but job commit failed for ${pending.jobId}: ${error.message}`);
  }
});

paymentServer.onSettleFailure(async ({ paymentPayload, error }) => {
  const key = paymentPayloadKey(paymentPayload);
  const pending = pendingPaidPublishes.get(key);
  if (!pending) return;
  pendingPaidPublishes.delete(key);
  delete jobs[pending.jobId];
  save();
  try {
    await portSvc("POST", `/ports/${encodeURIComponent(pending.jobId)}/scrap`, {});
  } catch (cleanupError) {
    console.error(`[mcp-server] failed to scrap unpaid port ${pending.jobId}: ${cleanupError.message}`);
  }
  console.error(`[mcp-server] x402 settlement failed for ${pending.jobId}: ${error.message}`);
});
const paidPublishServiceDescription = [
  "You are the calling buyer agent. Use this paid operation when you need a real human to do work that the agent cannot do directly.",
  "Send one complete brief for the human job, not a request to publish or describe an agent service.",
  "The publication fee creates the job and opens a ready-made private Prime Port conversation with Prime Port Connect inside OKX. It does not pay the freelancer wage and it does not guarantee that a freelancer will claim the job.",
  "Stay in the same OKX conversation after purchase. Prime Port labels separate private freelancer lanes as C1, C2, and so on, relays their messages, compares recorded evidence, and guides selection, signatures, escrow funding, revisions, approval, or dispute without requiring an XMTP installation.",
].join(" ");

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
      description: "The calling buyer agent's OKX agent ID. This identifies who owns the private port and signs later hire terms.",
    },
    conversationJobId: {
      type: "string",
      minLength: 1,
      maxLength: 300,
      description: "Optional current OKX A2A job ID. Supply it to bind this purchase to the exact existing conversation. If omitted, Prime Port reuses the latest existing conversation with this buyer agent.",
    },
    agentWallet: {
      type: "string",
      pattern: "^0x[0-9a-fA-F]{40}$",
      description: "The calling buyer agent's X Layer wallet. It must match the verified x402 payer wallet that authorizes the publication fee.",
    },
  },
  required: ["title", "description", "criteria", "deliverables", "deadline", "agentId", "agentWallet"],
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

function requirePublishInputBeforeSignedReplay(req, res, next) {
  if (!paymentSignatureHeader(req)) return next();
  const parsed = paidPublishShape.safeParse(req.body);
  if (!parsed.success) {
    const requiredArgs = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "body")))];
    return res.status(400).json({
      status: "input_required",
      error: "Complete the required publication fields before authorizing payment.",
      requiredArgs,
      fields: requiredPaidPublishFields,
    });
  }
  req.paidPublishArgs = parsed.data;
  return next();
}
const publishPaymentRequirements = {
  accepts: [{
    scheme: "exact",
    network: "eip155:196",
    payTo: PAY_TO_ADDRESS,
    price: PUBLISH_PRICE,
    maxTimeoutSeconds: 300,
  }],
  description: paidPublishServiceDescription,
  mimeType: "application/json",
  resource: `${PUBLIC_BASE_URL}/mcp/publish`,
  // Keep the x402 v2 challenge in PAYMENT-REQUIRED and describe the business
  // request separately in the 402 body. Payment clients use this schema to
  // carry the original fields into the paid POST replay instead of sending {}.
  unpaidResponseBody: async () => ({
    contentType: "application/json",
    body: { outputSchema: paidPublishOutputSchema },
  }),
};
const requirePublishPayment = paymentMiddleware(
  {
    // OKX's marketplace discovery probe checks the advertised endpoint with
    // GET before it prepares the paid POST. Both methods must advertise the
    // same challenge, while only POST is allowed to create a job.
    "GET /mcp/publish": publishPaymentRequirements,
    "POST /mcp/publish": publishPaymentRequirements,
  },
  paymentServer,
);

// OKX marketplace review clients may parse the unpaid challenge from the JSON
// body when preparing the paid replay, even though x402 v2 canonically carries
// it in PAYMENT-REQUIRED. Mirror the middleware-generated challenge into the
// body so both client behaviours receive identical payment requirements.
function requirePublishPaymentWithJsonChallenge(req, res, next) {
  const sendJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode === 402) {
      const encoded = res.getHeader("PAYMENT-REQUIRED");
      if (typeof encoded === "string") {
        try {
          const challenge = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
          return sendJson({ ...challenge, ...(body ?? {}) });
        } catch {
          // Preserve the SDK response if an unexpected header format is used.
        }
      }
    }
    return sendJson(body);
  };
  return requirePublishPayment(req, res, next);
}

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
  markKeyDelivered(job, "okx-a2a-conversation");
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

function findA2AJobs(rawConversationJobId, rawBuyerAgentId) {
  const conversationId = z.string().min(1).max(300).parse(rawConversationJobId);
  const buyerAgentId = z.string().min(1).max(100).parse(String(rawBuyerAgentId ?? ""));
  const bound = Object.values(jobs).filter((job) => {
    if (!job.a2a?.enabled) return false;
    ensureA2AState(job);
    return job.a2a.conversationJobId === conversationId;
  });
  if (bound.length === 0) throw new Error(`no Prime Port job is bound to OKX conversation ${conversationId}`);
  const owned = bound.filter((job) => String(job.a2a.buyerAgentId ?? job.agent.agentId) === buyerAgentId);
  if (owned.length === 0) throw new Error("this OKX buyer agent does not own the Prime Port job");
  return owned;
}

function findA2AJob(rawConversationJobId, rawBuyerAgentId, rawPrimePortJobId) {
  const matches = findA2AJobs(rawConversationJobId, rawBuyerAgentId);
  if (rawPrimePortJobId != null) {
    const primePortJobId = z.string().min(1).max(300).parse(rawPrimePortJobId);
    const exact = matches.find((job) => job.jobId === primePortJobId);
    if (!exact) throw new Error(`Prime Port job ${primePortJobId} is not bound to this OKX conversation`);
    return exact;
  }
  if (matches.length > 1) {
    const choices = matches.map((job) => `${job.jobId} (${job.title})`).join(", ");
    throw new Error(`this OKX conversation contains multiple Prime Port jobs. Choose one exact job: ${choices}`);
  }
  return matches[0];
}

async function runA2AAction(body) {
  if (body.action === "jobs") {
    return {
      ok: true,
      jobs: findA2AJobs(body.conversationJobId, body.buyerAgentId).map((job) => ({
        jobId: job.jobId,
        title: job.title,
        status: job.status,
        createdAt: job.createdAt,
      })),
    };
  }
  const job = findA2AJob(body.conversationJobId, body.buyerAgentId, body.primePortJobId);
  const args = body.args ?? {};
  switch (body.action) {
    case "context":
      return buyerContext(job);
    case "send":
      return sendCandidateMessage(job, findCandidate(job, args.candidateId), args.message);
    case "shortlist": {
      if (job.status !== "open") throw new Error(`job is ${job.status}, shortlist is closed`);
      const candidateIds = z.array(z.string()).min(1).max(20).parse(args.candidateIds);
      const selected = new Set(candidateIds.map((candidateId) => findCandidate(job, candidateId).candidateId));
      for (const claim of job.claims) {
        if (["selected", "hired", "not-selected"].includes(claim.selectionStatus)) continue;
        claim.selectionStatus = selected.has(claim.candidateId) ? "shortlisted" : "available";
        if (claim.selectionStatus === "shortlisted") claim.shortlistedAt = Date.now();
        else delete claim.shortlistedAt;
      }
      save();
      emit("candidates-shortlisted", { jobId: job.jobId, candidateIds: [...selected] });
      return { ok: true, shortlisted: [...selected] };
    }
    case "hire": {
      const result = await startHire(job, findCandidate(job, args.candidateId), args);
      return {
        ok: true,
        candidateId: result.candidateId,
        commitmentHash: result.commitmentHash,
        terms: result.commitment.terms,
        transcriptHash: result.commitment.transcriptHash,
        escrowAuthorization: result.escrowAuthorization,
        signThisExactly: result.signThisExactly,
        next: result.next,
      };
    }
    case "cancel-hire":
      return { ok: true, ...(await cancelHire(job)) };
    case "confirm-hire":
      return confirmHire(job, args.signature);
    case "review":
      return reviewJobSubmission(job, args);
    case "approve":
      return approveJob(job, args.note);
    case "dispute":
      return openBuyerDispute(job, args.reason);
    case "rate":
      return { ok: true, ...startRating(job, args) };
    case "confirm-rate":
      return confirmRating(job, args.signature);
    default:
      throw new Error(`unsupported buyer conversation action ${body.action}`);
  }
}

async function syncA2AOutbox() {
  let changed = false;
  for (const job of Object.values(jobs)) {
    if (!job.a2a?.enabled || !job.publishTask?.paidAt) continue;
    changed = ensureA2AState(job) || changed;
    changed = enqueueA2AMessage(job, {
      eventId: `welcome:v1:${job.jobId}`,
      kind: "welcome",
      message: welcomeMessage(job),
    }) || changed;
    const seenPortMessages = new Set(job.a2a.seenPortMessageIds);

    for (const claim of job.claims) {
      const profile = reputation(claim.inboxId);
      changed = enqueueA2AMessage(job, {
        eventId: `candidate-joined:${claim.candidateId}`,
        kind: "candidate-joined",
        candidateId: claim.candidateId,
        message: [
          `[Prime Port | ${job.jobId} | ${claim.candidateId} | ${job.title}]`,
          `Candidate display name, untrusted: ${JSON.stringify(String(claim.name ?? ""))}`,
          "A new candidate joined their private lane.",
          `Recorded history: ${profile.jobsCompleted}/${profile.jobsHired} hired jobs completed, ${profile.avgStars ?? "no"} average stars from ${profile.reviewCount} reviews.`,
          "Ask me to show candidates before comparing or choosing.",
        ].join("\n"),
      }) || changed;

      let channel;
      try {
        channel = await portSvc("GET", `/ports/${job.jobId}/channel?peer=${encodeURIComponent(claim.inboxId)}`);
      } catch (error) {
        if (/no channel/i.test(error.message)) continue;
        throw error;
      }
      for (const message of channel.messages) {
        if (!message.messageId || seenPortMessages.has(message.messageId)) continue;
        rememberPortMessage(job, message.messageId);
        seenPortMessages.add(message.messageId);
        changed = true;
        if (message.fromPort) continue;
        enqueueA2AMessage(job, {
          eventId: `port-message:${message.messageId}`,
          kind: "candidate-message",
          candidateId: claim.candidateId,
          message: formatCandidateRelay(job, claim, message),
        });
      }
    }
    changed = pruneDeliveredCandidateMessages(job) || changed;
    job.a2a.lastSyncedAt = Date.now();
  }
  if (changed) save();
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.post("/internal/a2a/action", async (req, res) => {
  try {
    requireBackend(req);
    res.json(await runA2AAction(req.body ?? {}));
  } catch (error) {
    const status = /authentication required/i.test(error.message) ? 401
      : /does not own/i.test(error.message) ? 403
        : 400;
    res.status(status).json({ error: error.message });
  }
});

app.post("/internal/a2a/outbox/lease", async (req, res) => {
  try {
    requireBackend(req);
    await syncA2AOutbox();
    const limit = z.coerce.number().int().min(1).max(25).default(10).parse(req.body?.limit ?? 10);
    const items = leaseOutboxItems(Object.values(jobs), {
      limit,
      leaseToken: randomUUID,
    });
    if (items.length) save();
    res.json({ items });
  } catch (error) {
    res.status(/authentication required/i.test(error.message) ? 401 : 400).json({ error: error.message });
  }
});

app.post("/internal/a2a/outbox/ack", (req, res) => {
  try {
    requireBackend(req);
    const eventId = z.string().min(1).max(500).parse(req.body?.eventId);
    const leaseToken = z.string().uuid().parse(req.body?.leaseToken);
    const match = Object.values(jobs)
      .flatMap((job) => (job.a2a?.outbox ?? []).map((item) => ({ job, item })))
      .find(({ item }) => item.eventId === eventId && item.leaseToken === leaseToken);
    if (!match) throw new Error("unknown or expired A2A outbox lease");
    const { job, item } = match;
    if (req.body?.success === true) {
      const resolvedA2AJobId = z.string().min(1).max(300).parse(req.body?.resolvedA2AJobId);
      if (job.a2a.conversationJobId && job.a2a.conversationJobId !== resolvedA2AJobId) {
        throw new Error("A2A delivery resolved to a different OKX conversation");
      }
      job.a2a.conversationJobId ??= resolvedA2AJobId;
      item.status = "sent";
      item.deliveredAt = Date.now();
      item.a2aMessageId = req.body.messageId == null ? null : String(req.body.messageId).slice(0, 500);
      delete item.lastError;
      delete item.nextAttemptAt;
      if (item.kind === "welcome") markKeyDelivered(job, "okx-a2a-conversation");
    } else {
      item.status = "pending";
      item.lastError = String(req.body?.error ?? "unknown A2A delivery error").slice(0, 2_000);
      item.nextAttemptAt = Date.now() + Math.min(10 * 60_000, 5_000 * (2 ** Math.min(item.attempts, 7)));
    }
    delete item.leaseToken;
    delete item.leasedUntil;
    save();
    res.json({ recorded: true, eventId, status: item.status });
  } catch (error) {
    res.status(/authentication required/i.test(error.message) ? 401 : 400).json({ error: error.message });
  }
});

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
// remain on /mcp without another charge. Reaching this handler means the OKX
// middleware verified the payment authorization for this exact request.
app.get("/mcp/publish", requirePublishPaymentWithJsonChallenge, (_req, res) => {
  res.status(405).json({ error: "Use POST with the complete job fields to publish." });
});

app.post(
  "/mcp/publish",
  requirePublishInputBeforeSignedReplay,
  requirePublishPaymentWithJsonChallenge,
  async (req, res) => {
  try {
    const { payer, paymentPayload } = paymentPayerFromHeader(paymentSignatureHeader(req));
    const args = req.paidPublishArgs ?? paidPublishShape.parse(req.body);
    if (args.agentWallet.toLowerCase() !== payer) {
      return res.status(403).json({ error: "published agent wallet must match the verified x402 payer" });
    }
    const key = paymentPayloadKey(paymentPayload);
    if (pendingPaidPublishes.has(key)) {
      return res.status(409).json({ error: "x402 payment replay is already being processed" });
    }
    const paymentId = `x402-${randomUUID()}`;
    const pending = await prepareJob({ ...args, marketplaceJobId: paymentId });
    pending.job.publishTask.paymentMode = "x402";
    ensureA2AState(pending.job);
    pending.payer = payer;
    stagePreparedJob(pending);
    pendingPaidPublishes.set(key, pending);
    res.json({
      jobId: pending.jobId,
      status: "waiting-for-freelancers",
      conversation: {
        interface: "OKX A2A",
        primePortAgentId: String(process.env.EXPECTED_OKX_AGENT_ID ?? "5982"),
        jobId: pending.job.a2a.conversationJobId,
        status: pending.job.a2a.conversationJobId ? "opening" : "binding-existing-conversation",
      },
      next: "Stay in your existing OKX conversation with Prime Port Connect. Candidate and escrow updates will arrive there automatically. Publication does not guarantee that a freelancer will claim the job.",
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
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
// the X Layer poller below; this route does not exist unless explicitly on.
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
