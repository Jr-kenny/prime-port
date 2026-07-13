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
//     hire-committed, job-task-linked, job-task-escrowed, job-approved). The
//     marketplace escrow calls hang off those same events; wiring them to
//     onchainos is the next lane deliverable and marked MARKETPLACE below.
import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { verifyMessage } from "viem";
import { commitmentHash, signingMessage } from "../commitment/commitment.mjs";

const PORT = Number(process.env.PORT ?? 8792);
const PORT_SVC = process.env.PORT_SVC ?? "http://localhost:8791";
const FEE_BPS = Number(process.env.FEE_BPS ?? 250);
const DATA = new URL("./data/", import.meta.url).pathname;
mkdirSync(DATA, { recursive: true });

const jobsPath = `${DATA}jobs.json`;
const jobs = existsSync(jobsPath) ? JSON.parse(readFileSync(jobsPath, "utf8")) : {};
const save = () => writeFileSync(jobsPath, JSON.stringify(jobs, null, 2));
const emit = (type, payload) =>
  appendFileSync(`${DATA}events.jsonl`, JSON.stringify({ type, at: Date.now(), ...payload }) + "\n");

const portSvc = async (method, path, body) => {
  const r = await fetch(`${PORT_SVC}${path}`, { method, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`port-service ${path}: ${j.error}`);
  return j;
};

const getJob = (jobId) => {
  const job = jobs[jobId];
  if (!job) throw new Error(`unknown job ${jobId}`);
  return job;
};

// The two-task payment model, enforced. Every port is paid for by a publish
// task on the marketplace (the flat service fee); the wage rides a second
// job task opened after the hire commitment is dual-signed. The port-
// operating verbs refuse to run until the publish escrow is locked, so a
// port nobody bought is a listing you can look at and nothing more.
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
const requireWatcher = (req) => {
  if (WATCHER_TOKEN && req.headers["x-watcher-token"] !== WATCHER_TOKEN)
    throw new Error("watcher token required");
};
const text = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });

// The exact string the agent wallet personal_signs over a review hash. Same
// shape as the hire commitment message so verifiers treat both alike.
const reviewMessage = (hash) => `Prime Port freelancer review v1: ${hash}`;

const hiredInboxId = (job) => job.pendingHire?.commitment.freelancer.inboxId;

// Reputation is computed from the jobs file every time, never stored: the
// jobs are the ledger, the profile is just a view over it.
function reputation(inboxId) {
  const all = Object.values(jobs);
  const claimed = all.filter((j) => j.claims.some((c) => c.inboxId === inboxId));
  const hired = all.filter((j) => hiredInboxId(j) === inboxId && ["hired", "approved", "settled"].includes(j.status));
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
  criteria: z.string(),
  price: z.string().regex(/^\d+(\.\d{1,6})?$/),
  currency: z.literal("USDT").default("USDT"),
  deadline: z.number().int(),
  agentId: z.string(),
  agentWallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  title: z.string().max(120),
  marketplaceJobId: z.string().optional(),
});

async function publishJob(args) {
  const jobId = `job-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const port = await portSvc("POST", "/ports", { jobId });
  jobs[jobId] = {
    jobId,
    status: "open",
    title: args.title,
    criteria: args.criteria,
    price: args.price,
    currency: args.currency,
    deadline: args.deadline,
    agent: { agentId: args.agentId, wallet: args.agentWallet.toLowerCase() },
    feeBps: FEE_BPS,
    port: { inboxId: port.inboxId, address: port.address, grantToken: port.grantToken },
    claims: [],
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
  save();
  emit("job-created", { jobId, title: args.title, price: args.price, deadline: args.deadline, marketplaceJobId: args.marketplaceJobId });
  return { jobId, port: { inboxId: port.inboxId } };
}

function buildServer() {
  const mcp = new McpServer({ name: "prime-port", version: "0.1.0" });

  mcp.tool(
    "publish",
    "Publish a job for human freelancers. Mints a private port (XMTP endpoint) for this job and returns it. No funds move yet; escrow locks only at hire.",
    {
      criteria: z.string().describe("Acceptance criteria, plain text. This exact text goes into the signed hire commitment."),
      price: z.string().regex(/^\d+(\.\d{1,6})?$/).describe("Offered price as a decimal string, e.g. '40'"),
      currency: z.literal("USDT").default("USDT"),
      deadline: z.number().int().describe("Unix seconds UTC"),
      agentId: z.string().describe("Your OKX marketplace agent id"),
      agentWallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("Your marketplace wallet; it will sign the hire commitment"),
      title: z.string().max(120),
      marketplaceJobId: z.string().optional().describe("The OKX task id of the publish task you opened against our 'Job publishing' service. Without it the listing goes up, but port_connect, negotiate and hire stay locked: the publish fee pays for the port."),
    },
    async (args) => {
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
      requirePaidPort(job, "port_connect");
      markKeyDelivered(job, "port_connect");
      return text({
        inboxId: job.port.inboxId,
        identity: job.port.address,
        grantEndpoint: `${PORT_SVC}/ports/${jobId}/grant/sign`,
        grantTokenHeader: { "x-grant-token": job.port.grantToken },
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
      return text({ jobId, status: job.status, offers });
    },
  );

  mcp.tool(
    "negotiate",
    "Send a message to one claimant through the port (server-relayed fallback; prefer port_connect to speak on your own power). Returns the channel so far.",
    { jobId: z.string(), claimantInboxId: z.string(), message: z.string() },
    async ({ jobId, claimantInboxId, message }) => {
      const job = getJob(jobId);
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
    "Commit to one claimant at the negotiated terms. Builds the hire commitment (criteria, price, deadline, payout address, transcript hash of this channel) and returns the exact message your wallet must personal_sign. Nothing locks until confirm_hire.",
    {
      jobId: z.string(),
      claimantInboxId: z.string(),
      price: z.string().regex(/^\d+(\.\d{1,6})?$/).describe("Final negotiated price"),
      deadline: z.number().int(),
      criteria: z.string().optional().describe("Final criteria if they changed during negotiation; defaults to the published criteria"),
    },
    async ({ jobId, claimantInboxId, price, deadline, criteria }) => {
      const job = getJob(jobId);
      if (job.status !== "open") throw new Error(`job is ${job.status}`);
      requirePaidPort(job, "hire");
      const claim = job.claims.find((c) => c.inboxId === claimantInboxId);
      if (!claim) throw new Error("no such claimant");
      const ch = await portSvc("GET", `/ports/${jobId}/channel?peer=${claimantInboxId}`);
      const commitment = {
        version: 1,
        jobId,
        port: { inboxId: job.port.inboxId },
        agent: job.agent,
        freelancer: { inboxId: claim.inboxId, wallet: claim.wallet, payoutAddress: claim.payoutAddress },
        terms: { criteria: criteria ?? job.criteria, price, currency: job.currency, deadline },
        feeBps: job.feeBps,
        transcriptHash: ch.transcriptHash,
        hiredAt: Math.floor(Date.now() / 1000),
      };
      const hash = commitmentHash(commitment);
      job.pendingHire = { commitment, hash };
      job.status = "hiring";
      save();
      return text({
        commitmentHash: hash,
        commitment,
        signThisExactly: signingMessage(hash),
        next: "personal_sign that message with your marketplace wallet and call confirm_hire with the signature.",
      });
    },
  );

  mcp.tool(
    "confirm_hire",
    "Deliver your wallet's signature over the hire commitment. We verify it, then the freelancer countersigns in the web app; escrow locks when both signatures are in.",
    { jobId: z.string(), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) },
    async ({ jobId, signature }) => {
      const job = getJob(jobId);
      if (job.status !== "hiring" || !job.pendingHire) throw new Error("no hire in progress");
      const valid = await verifyMessage({
        address: job.agent.wallet,
        message: signingMessage(job.pendingHire.hash),
        signature,
      });
      if (!valid) throw new Error("signature does not recover the agent wallet");
      job.pendingHire.agentSignature = signature;
      job.status = "awaiting-freelancer-signature";
      save();
      return text({
        ok: true,
        waitingOn: "freelancer countersignature via the web app",
        then: `once countersigned, open a job task on the marketplace against our 'Freelancer hiring' service at the committed price (${job.pendingHire.commitment.terms.price} ${job.pendingHire.commitment.terms.currency}) with this commitment hash in the task title or description: ${job.pendingHire.hash}. Escrow locking on that task is what moves the job to hired.`,
      });
    },
  );

  mcp.tool(
    "approve",
    "Approve the delivered work. Releases escrow on the marketplace and closes the port after the quiet window.",
    { jobId: z.string() },
    async ({ jobId }) => {
      const job = getJob(jobId);
      if (job.status !== "hired") throw new Error(`job is ${job.status}, nothing to approve`);
      job.status = "approved";
      save();
      // MARKETPLACE: agent confirms complete on OKX (escrow release on the
      // job task) — wired in the onchainos integration deliverable. The
      // forwarding contract watcher picks up the release from this event.
      emit("job-approved", { jobId, commitmentHash: job.pendingHire.hash, marketplaceJobId: job.jobTask?.marketplaceJobId });
      const scrapped = await portSvc("POST", `/ports/${jobId}/scrap`, {});
      job.status = "settled";
      job.archive = scrapped.archive;
      save();
      emit("port-scrapped", { jobId, transcriptHashes: scrapped.archive.transcriptHashes });
      return text({ ok: true, settled: true, archive: scrapped.archive });
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
  "POST /jobs": async (body) => publishJob(publishShape.parse(body)),
  "GET /jobs": async () =>
    Object.values(jobs).map(({ port, pendingHire, pendingReview, ...pub }) => ({
      ...pub,
      port: { inboxId: port.inboxId },
      pendingHire: pendingHire ? { hash: pendingHire.hash, commitment: pendingHire.commitment } : undefined,
    })),
  "POST /jobs/:jobId/claims": async (body, jobId) => {
    const job = getJob(jobId);
    if (job.status !== "open") throw new Error(`job is ${job.status}`);
    const claim = {
      inboxId: z.string().min(10).parse(body.inboxId),
      wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/).parse(body.wallet).toLowerCase(),
      payoutAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).parse(body.payoutAddress ?? body.wallet).toLowerCase(),
      name: z.string().max(60).parse(body.name),
      claimedAt: Date.now(),
    };
    if (job.claims.some((c) => c.inboxId === claim.inboxId)) throw new Error("already claimed");
    job.claims.push(claim);
    save();
    return { claimed: true, portInboxId: job.port.inboxId, next: "DM the port inbox to negotiate" };
  },
  "POST /jobs/:jobId/countersign": async (body, jobId) => {
    const job = getJob(jobId);
    if (job.status !== "awaiting-freelancer-signature") throw new Error(`job is ${job.status}`);
    const { commitment, hash } = job.pendingHire;
    const valid = await verifyMessage({
      address: commitment.freelancer.wallet,
      message: signingMessage(hash),
      signature: body.signature,
    });
    if (!valid) throw new Error("signature does not recover the freelancer wallet");
    job.pendingHire.freelancerSignature = body.signature;
    // Both signatures are in: the deal is committed, but nobody's money has
    // moved. The agent now opens the job task on the marketplace at the
    // committed price; the watcher links it by commitment hash and reports
    // its escrow lock, which is what flips the job to hired. Register-at-hire
    // (forwarding contract) keys off this event: the payout address is final
    // from the moment both signatures exist.
    job.status = "awaiting-escrow";
    save();
    emit("hire-committed", {
      jobId,
      commitmentHash: hash,
      payoutAddress: commitment.freelancer.payoutAddress,
      feeBps: commitment.feeBps,
    });
    return { committed: true, commitmentHash: hash, waitingOn: "job task escrow on the marketplace" };
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
  "POST /jobs/:jobId/job-task": async (body, jobId, req) => {
    requireWatcher(req);
    const job = getJob(jobId);
    if (job.status !== "awaiting-escrow")
      throw new Error(`job is ${job.status}, a job task links only after both hire signatures`);
    const marketplaceJobId = z.string().min(1).parse(body.marketplaceJobId);
    if (job.jobTask && job.jobTask.marketplaceJobId !== marketplaceJobId)
      throw new Error("a different job task is already linked");
    if (!job.jobTask) {
      job.jobTask = { marketplaceJobId, linkedAt: Date.now(), paidAt: null };
      save();
      emit("job-task-linked", { jobId, marketplaceJobId, commitmentHash: job.pendingHire.hash });
    }
    return { linked: true, price: job.pendingHire.commitment.terms.price, currency: job.pendingHire.commitment.terms.currency };
  },
  "POST /jobs/:jobId/job-task/paid": async (body, jobId, req) => {
    requireWatcher(req);
    const job = getJob(jobId);
    if (!job.jobTask) throw new Error("no job task linked");
    if (body.marketplaceJobId !== job.jobTask.marketplaceJobId)
      throw new Error("marketplaceJobId does not match the linked job task");
    if (!job.jobTask.paidAt) {
      job.jobTask.paidAt = Date.now();
      job.status = "hired";
      save();
      // MARKETPLACE: this is the acceptance moment — the wage is in escrow.
      // The freelancer UI shows "start work" from here.
      emit("job-task-escrowed", { jobId, marketplaceJobId: job.jobTask.marketplaceJobId, commitmentHash: job.pendingHire.hash });
    }
    return { paid: true, status: job.status };
  },
  "GET /freelancers/:inboxId/profile": async (_body, inboxId) => reputation(inboxId),
};

createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/mcp") {
    // Stateless MCP: fresh server + transport per request.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close());
    await buildServer().connect(transport);
    let body = "";
    for await (const c of req) body += c;
    return transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  }
  const body = await new Promise((r) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => r(d ? JSON.parse(d) : {}));
  });
  const reply = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  try {
    const m = path.match(/^\/(jobs|freelancers)(?:\/([\w.-]+)\/([\w/-]+))?$/);
    const key = m
      ? m[2]
        ? `${req.method} /${m[1]}/:${m[1] === "jobs" ? "jobId" : "inboxId"}/${m[3]}`
        : `${req.method} /${m[1]}`
      : `${req.method} ${path}`;
    const handler = rest[key];
    if (!handler) return reply(404, { error: `no route ${key}` });
    reply(200, await handler(body, m?.[2], req));
  } catch (e) {
    console.error(`[mcp-server] ${req.method} ${path}:`, e.message);
    reply(400, { error: e.message });
  }
}).listen(PORT, () => console.log(`[mcp-server] MCP on :${PORT}/mcp, REST on :${PORT}/jobs`));
