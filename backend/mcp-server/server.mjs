// The agent-facing surface of Prime Port: MCP tools over streamable HTTP.
// Tools: publish, get_offers, negotiate, hire, confirm_hire, approve, plus
// port_connect for agents that run their own XMTP client (the first-class
// path). negotiate/get_offers are the server-side fallback for agents that
// can't.
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
  jobs[prepared.jobId] = prepared.job;
  save();
}

async function publishJob(args) {
  return commitPreparedJob(await prepareJob(args));
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
    },
    async (args) => {
      if (args.publishToken !== BACKEND_SERVICE_TOKEN) throw new Error("publish service authorization required");
      if (agentSession?.wallet && args.agentWallet.toLowerCase() !== agentSession.wallet) {
        throw new Error("published agent wallet must match the authenticated wallet");
      }
      const { jobId, port } = await publishJob(args);
      return text({
        jobId,
        port,
        next: "Freelancers will claim and appear in get_offers. Talk to them yourself via port_connect (preferred) or negotiate (we relay). Both unlock once your publish task's escrow locks.",
      });
    },
  );

  mcp.tool(
    "port_connect",
    "Get the credential to run your own XMTP client as this job's port. You register your own device on the port inbox: create an XMTP client for the port's identity and have your signer POST the sign-in message to the grant endpoint with the token. Budgeted and time-limited; we never see your device keys.",
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
      const { conversations } = await portSvc("GET", `/ports/${jobId}/conversations`);
      const offers = [];
      for (const claim of job.claims) {
        const { jobsClaimed, jobsCompleted, completionRate, avgStars, reviewCount } = reputation(claim.inboxId);
        const channel = conversations.find((c) => c.peerInboxId === claim.inboxId) ?? { messageCount: 0 };
        // Evidence delivered on this channel, envelope and all, so the agent
        // can fetch and decrypt each deliverable without its own XMTP client.
        const attachments = channel.attachmentCount
          ? (await portSvc("GET", `/ports/${jobId}/channel?peer=${claim.inboxId}`)).messages.filter((m) => m.kind === "attachment")
          : [];
        offers.push({
          ...claim,
          reputation: { jobsClaimed, jobsCompleted, completionRate, avgStars, reviewCount },
          channel,
          attachments,
        });
      }
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
    "Send a message to one claimant through the port (server-relayed fallback; prefer port_connect to speak on your own power). Returns the channel so far.",
    { jobId: z.string(), claimantInboxId: z.string(), message: z.string() },
    async ({ jobId, claimantInboxId, message }) => {
      const job = getJob(jobId);
      requireAgent(job, agentSession);
      if (job.status !== "open") throw new Error(`job is ${job.status}, negotiation is over`);
      requirePaidPort(job, "negotiate");
      markKeyDelivered(job, "negotiate");
      if (!job.claims.some((c) => c.inboxId === claimantInboxId)) throw new Error("no such claimant");
      await portSvc("POST", `/ports/${jobId}/messages`, { peerInboxId: claimantInboxId, content: message });
      const ch = await portSvc("GET", `/ports/${jobId}/channel?peer=${claimantInboxId}`);
      return text({ sent: true, channel: ch.messages });
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
      if (job.status !== "open") throw new Error(`job is ${job.status}`);
      requirePaidPort(job, "hire");
      requireEscrow(ESCROW);
      const claim = job.claims.find((c) => c.inboxId === claimantInboxId);
      if (!claim) throw new Error("no such claimant");
      const ch = await portSvc("GET", `/ports/${jobId}/channel?peer=${claimantInboxId}`);
      const commitment = {
        version: 2,
        jobId,
        port: { inboxId: job.port.inboxId },
        agent: job.agent,
        freelancer: { inboxId: claim.inboxId, wallet: claim.wallet, payoutAddress: claim.payoutAddress },
        terms: { criteria: criteria ?? job.criteria, price, currency: job.currency, deadline },
        feeBps: job.feeBps,
        dispute: {
          system: "GenLayer",
          evidencePolicy: "If either party opens a dispute, the selected job transcript, submissions, revision feedback, and attachment metadata are disclosed to GenLayer validators for settlement.",
          outcome: "provider-award-bps",
        },
        transcriptHash: ch.transcriptHash,
        hiredAt: Math.floor(Date.now() / 1000),
      };
      const hash = commitmentHash(commitment);
      job.pendingHire = { commitment, hash };
      job.pendingHire.escrow = buildEscrowAuthorization(job.pendingHire, ESCROW);
      job.status = "hiring";
      save();
      return text({
        commitmentHash: hash,
        commitment,
        escrowAuthorization: job.pendingHire.escrow,
        signThisExactly: job.pendingHire.escrow.signThisExactly,
        next: "personal_sign the escrow authorization with your marketplace wallet and call confirm_hire. The freelancer then signs the same authorization before any USDT can move.",
      });
    },
  );

  mcp.tool(
    "confirm_hire",
    "Deliver your wallet's signature over the exact escrow authorization. We verify it, then the freelancer countersigns the same authorization in the web app. Both signatures authorize funding, but escrow is locked only after the X Layer EscrowFunded event.",
    { jobId: z.string(), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) },
    async ({ jobId, signature }) => {
      const job = getJob(jobId);
      requireAgent(job, agentSession);
      if (job.status !== "hiring" || !job.pendingHire) throw new Error("no hire in progress");
      const valid = await verifyMessage({
        address: job.agent.wallet,
        message: authorizationMessage(job.pendingHire.escrow.authorizationHash),
        signature,
      });
      if (!valid) throw new Error("signature does not recover the agent wallet");
      job.pendingHire.agentSignature = signature;
      job.status = "awaiting-freelancer-signature";
      save();
      return text({
        ok: true,
        waitingOn: "freelancer countersignature via the web app",
        then: `once countersigned, call get_offers for the exact X Layer approval and funding transactions. The freelancer must wait for the EscrowFunded notification before starting work.`,
      });
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
      ensureSettlement(job);
      if (job.status !== "hired") throw new Error(`job is ${job.status}, review requires locked escrow`);
      const submission = job.submissions?.find((candidate) => candidate.submissionId === submissionId);
      if (!submission) throw new Error("unknown submission");
      if (submission.status !== "awaiting-review") throw new Error(`submission is ${submission.status}`);

      if (decision === "request_changes") {
        const reason = z.string().trim().min(3).max(2000).parse(feedback);
        submission.status = "revision-requested";
        submission.reviewedAt = Date.now();
        submission.feedback = reason;
        job.settlement.reviewStatus = "revision-requested";
        job.settlement.revisionRequestedAt = submission.reviewedAt;
        await portSvc("POST", `/ports/${jobId}/messages`, {
          peerInboxId: hiredInboxId(job),
          content: `Changes requested for ${submissionId}: ${reason}`,
        });
        save();
        emit("submission-revision-requested", { jobId, submissionId, commitmentHash: job.pendingHire.hash, feedback: reason });
        return text({ ok: true, status: "revision-requested", submissionId, next: "Wait for the freelancer's revised submission in this port." });
      }

      submission.status = "accepted";
      submission.reviewedAt = Date.now();
      submission.feedback = feedback?.trim() ?? "";
      job.settlement.reviewStatus = "final-delivery-ready";
      job.settlement.finalSubmissionId = submissionId;
      job.settlement.acceptedForDeliveryAt = submission.reviewedAt;
      job.status = "delivered";
      job.settlement.status = "release-ready";
      save();
      emit("submission-accepted", { jobId, submissionId, commitmentHash: job.pendingHire.hash });
      return text({
        ok: true,
        status: "release-ready",
        submissionId,
        next: "Call approve to receive the X Layer release transaction. Funds do not move until the buyer wallet signs that transaction.",
      });
    },
  );

  mcp.tool(
    "approve",
    "Confirm that you want to approve the accepted revision. Prime Port returns the exact X Layer transaction that releases escrow directly to the freelancer payout wallet.",
    { jobId: z.string(), note: z.string().optional().describe("A closing message relayed to the freelancer just before the port is scrapped, e.g. acknowledging the delivery") },
    async ({ jobId, note }) => {
      const job = getJob(jobId);
      requireAgent(job, agentSession);
      ensureSettlement(job);
      if (job.status !== "delivered") throw new Error(`job is ${job.status}, no Prime Port revision has been accepted for release`);
      if (note) await portSvc("POST", `/ports/${jobId}/messages`, { peerInboxId: hiredInboxId(job), content: note });
      job.settlement.approvalRequestedAt = Date.now();
      save();
      emit("job-approval-requested", { jobId, commitmentHash: job.pendingHire.hash });
      return text({
        ok: true,
        transaction: buildReleaseRequest(job.pendingHire, ESCROW),
        next: "Sign and broadcast this transaction with the buyer wallet. Prime Port settles and archives the port only after observing EscrowReleased on X Layer.",
      });
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
      ensureSettlement(job);
      if (!["hired", "delivered", "delivery-rejected"].includes(job.status)) {
        throw new Error(`job is ${job.status}, only funded unsettled jobs can be disputed`);
      }
      const evidence = await buildDisputeEvidence(job, "buyer", reason);
      emit("dispute-requested", { jobId, commitmentHash: job.pendingHire.hash, evidenceHash: evidence.evidenceHash, openedBy: "buyer" });
      return text({
        ok: true,
        ...evidence,
        next: "Sign and broadcast the openDispute transaction with the buyer wallet. Prime Port submits the case to GenLayer only after observing DisputeOpened on X Layer.",
      });
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
      if (job.status !== "settled") throw new Error(`job is ${job.status}, rate after approve settles it`);
      if (job.review) throw new Error("already rated");
      const review = {
        version: 1,
        jobId,
        commitmentHash: job.pendingHire.hash,
        freelancer: hiredInboxId(job),
        stars,
        note: note ?? "",
        ratedAt: Math.floor(Date.now() / 1000),
      };
      const hash = commitmentHash(review);
      job.pendingReview = { review, hash };
      save();
      return text({
        reviewHash: hash,
        review,
        signThisExactly: reviewMessage(hash),
        next: "personal_sign that message with your marketplace wallet and call confirm_rate with the signature.",
      });
    },
  );

  mcp.tool(
    "confirm_rate",
    "Deliver your wallet's signature over the pending review. We verify it recovers the same wallet that signed the hire, then the review lands on the freelancer's profile.",
    { jobId: z.string(), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) },
    async ({ jobId, signature }) => {
      const job = getJob(jobId);
      requireAgent(job, agentSession);
      if (!job.pendingReview) throw new Error("no rating in progress");
      const valid = await verifyMessage({
        address: job.agent.wallet,
        message: reviewMessage(job.pendingReview.hash),
        signature,
      });
      if (!valid) throw new Error("signature does not recover the agent wallet");
      job.review = { ...job.pendingReview.review, hash: job.pendingReview.hash, signature };
      delete job.pendingReview;
      save();
      emit("freelancer-rated", { jobId, freelancer: job.review.freelancer, stars: job.review.stars, reviewHash: job.review.hash });
      return text({ ok: true, review: job.review });
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
    job.claims.push(claim);
    save();
    return { claimed: true, portInboxId: job.port.inboxId, next: "DM the port inbox to negotiate" };
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
  "The publication fee creates the job and a private Prime Port. It does not pay the freelancer wage and it does not guarantee that a freelancer will claim the job.",
  "After success, use the returned jobId and private MCP port to inspect offers, clarify the brief, negotiate, choose a freelancer, review revisions, and approve or dispute the final work.",
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
    pending.payer = payer;
    stagePreparedJob(pending);
    pendingPaidPublishes.set(key, pending);
    res.json({
      jobId: pending.jobId,
      port: pending.port,
      status: "waiting-for-freelancers",
      mcpEndpoint: `${PUBLIC_BASE_URL}/mcp`,
      next: "Connect to the port, monitor get_offers, and negotiate directly with freelancers. Publication does not guarantee that a freelancer will claim the job.",
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
