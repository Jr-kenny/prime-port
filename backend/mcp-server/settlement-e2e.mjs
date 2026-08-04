// Deterministic settlement lifecycle check. It replaces only the external
// XMTP transport with a tiny in-memory port; all Prime Port MCP and REST
// handlers, signatures, routing checks, revision states, and settlement
// transitions run through the real server process.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const readJson = (req) => new Promise((resolve, reject) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
  });
});
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));

const portMessages = [];
const fakePort = createServer(async (req, res) => {
  if (req.headers.authorization !== "Bearer settlement-e2e-port-token") {
    return json(res, 401, { error: "internal service authentication required" });
  }
  const path = new URL(req.url, "http://local").pathname;
  const body = await readJson(req);
  if (req.method === "POST" && path === "/ports") {
    return json(res, 200, { inboxId: "port-inbox-test", address: "0x0000000000000000000000000000000000000001", grantToken: "test-grant" });
  }
  if (req.method === "GET" && /^\/ports\/[^/]+\/channel$/.test(path)) {
    return json(res, 200, { messages: [], transcriptHash: `0x${"11".repeat(32)}` });
  }
  if (req.method === "GET" && /^\/ports\/[^/]+\/conversations$/.test(path)) {
    return json(res, 200, {
      conversations: [{ peerInboxId: "freelancer-inbox-test", messageCount: 0, attachmentCount: 0, lastMessage: null }],
    });
  }
  if (req.method === "POST" && /^\/ports\/[^/]+\/messages$/.test(path)) {
    portMessages.push(body);
    return json(res, 200, { sent: true });
  }
  if (req.method === "POST" && /^\/ports\/[^/]+\/scrap$/.test(path)) {
    return json(res, 200, { archive: { transcriptHashes: [`0x${"11".repeat(32)}`] } });
  }
  return json(res, 404, { error: `no fake port route ${req.method} ${path}` });
});

const portServicePort = await listen(fakePort);
const probe = createServer();
const mcpPort = await listen(probe);
await close(probe);
const dataDir = await mkdtemp(join(tmpdir(), "prime-port-settlement-e2e-"));
const escrowAddress = "0x1111111111111111111111111111111111111111";
const server = spawn(process.execPath, [new URL("./server.mjs", import.meta.url).pathname], {
  env: {
    ...process.env,
    PORT: String(mcpPort),
    PORT_SVC: `http://127.0.0.1:${portServicePort}`,
    MCP_DATA_DIR: dataDir,
    ESCROW_ADDRESS: escrowAddress,
    ESCROW_WATCHER_DISABLED: "1",
    ESCROW_TEST_EVENTS: "1",
    RELAYER_TOKEN: "settlement-e2e-relayer-token",
    BACKEND_SERVICE_TOKEN: "settlement-e2e-backend-token",
    SESSION_SECRET: "settlement-e2e-session-secret-32-bytes-minimum",
    PORT_SERVICE_TOKEN: "settlement-e2e-port-token",
    X402_OFFLINE_CHALLENGE: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLogs = "";
server.stdout.on("data", (chunk) => (serverLogs += chunk));
server.stderr.on("data", (chunk) => (serverLogs += chunk));

const base = `http://127.0.0.1:${mcpPort}`;
const rest = async (method, path, body, extraHeaders = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json", ...extraHeaders } : extraHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${result.error}`);
  return result;
};

let mcp;
try {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { await rest("GET", "/jobs"); break; } catch {
      if (server.exitCode !== null) throw new Error(`server exited early\n${serverLogs}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const buyer = privateKeyToAccount(generatePrivateKey());
  const freelancer = privateKeyToAccount(generatePrivateKey());
  const agentChallenge = await rest("POST", "/auth/agent-challenge", { wallet: buyer.address });
  const agentAuthenticated = await rest("POST", "/auth/agent-session", {
    challenge: agentChallenge.challenge,
    signature: await buyer.signMessage({ message: agentChallenge.message }),
  });
  mcp = new McpClient({ name: "settlement-e2e", version: "1.0.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${agentAuthenticated.token}` } },
  }));
  const call = async (name, args) => {
    const response = await mcp.callTool({ name, arguments: args });
    if (response.isError) throw new Error(`${name}: ${response.content[0].text}`);
    return JSON.parse(response.content[0].text);
  };

  const challenge = await rest("POST", "/auth/challenge", {
    wallet: freelancer.address,
    inboxId: "freelancer-inbox-test",
  });
  const authenticated = await rest("POST", "/auth/session", {
    challenge: challenge.challenge,
    signature: await freelancer.signMessage({ message: challenge.message }),
  });
  const freelancerHeaders = { authorization: `Bearer ${authenticated.token}` };
  const internalHeaders = { "x-backend-service-token": "settlement-e2e-backend-token" };
  const publishTask = "paid-public-port-test";
  const published = await call("publish", {
    publishToken: "settlement-e2e-backend-token",
    title: "Write a deterministic settlement test",
    description: "Write and revise a short result so Prime Port can verify the complete settlement lifecycle.",
    deliverables: "A reviewed written result with one revision.",
    criteria: "The buyer must explicitly accept the final revision.",
    price: "12.5",
    currency: "USDT",
    deadline: Math.floor(Date.now() / 1000) + 3600,
    agentId: "buyer-42",
    agentWallet: buyer.address,
    marketplaceJobId: publishTask,
  });
  const { jobId } = published;
  await rest("POST", `/jobs/${jobId}/publish-task/paid`, { marketplaceJobId: publishTask });
  const publicListing = (await rest("GET", "/jobs")).find((candidate) => candidate.jobId === jobId);
  assert.deepEqual(publicListing.claims, []);
  assert.equal(publicListing.port, undefined);
  assert.equal(publicListing.agent, undefined);
  assert.equal(publicListing.agentToken, undefined);
  const anonymousClaim = await fetch(`${base}/jobs/${jobId}/claims`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Impersonator" }),
  });
  assert.equal(anonymousClaim.status, 401);
  const anonymousMcp = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(anonymousMcp.status, 401);
  const claimed = await rest("POST", `/jobs/${jobId}/claims`, {
    payoutAddress: freelancer.address,
    name: "Test Freelancer",
  }, freelancerHeaders);
  assert.equal(claimed.candidateId, "C1");

  const leased = await rest("POST", "/internal/a2a/outbox/lease", { limit: 10 }, internalHeaders);
  assert.deepEqual(new Set(leased.items.map((item) => item.eventId)), new Set([
    `welcome:v1:${jobId}`,
    "candidate-joined:C1",
  ]));
  for (const item of leased.items) {
    await rest("POST", "/internal/a2a/outbox/ack", {
      eventId: item.eventId,
      leaseToken: item.leaseToken,
      success: true,
      messageId: `a2a-${item.eventId}`,
      resolvedA2AJobId: publishTask,
    }, internalHeaders);
  }

  const a2aAction = (action, args = {}) => rest("POST", "/internal/a2a/action", {
    conversationJobId: publishTask,
    buyerAgentId: "buyer-42",
    action,
    args,
  }, internalHeaders);
  const conversationContext = await a2aAction("context");
  assert.equal(conversationContext.candidates[0].candidateId, "C1");
  assert.equal(conversationContext.candidates[0].inboxId, undefined);
  await a2aAction("shortlist", { candidateIds: ["C1"] });

  const cancellableDeadline = Math.floor(Date.now() / 1000) + 3600;
  const cancellable = await a2aAction("hire", {
    candidateId: "C1",
    price: "12.5",
    deadline: cancellableDeadline,
  });
  await a2aAction("confirm-hire", {
    signature: await buyer.signMessage({ message: cancellable.signThisExactly }),
  });
  const cancelled = await a2aAction("cancel-hire");
  assert.equal(cancelled.status, "open");
  assert.match(cancelled.safety, /had not countersigned/);
  assert.equal((await a2aAction("context")).candidates[0].selectionStatus, "shortlisted");
  assert.match(portMessages[0].content, /^\[prime-port:hire-cancelled\]/);

  const hireDeadline = Math.floor(Date.now() / 1000) + 3600;
  const hire = await call("hire", {
    jobId,
    claimantInboxId: "freelancer-inbox-test",
    price: "12.5",
    deadline: hireDeadline,
  });
  await call("confirm_hire", { jobId, signature: await buyer.signMessage({ message: hire.signThisExactly }) });
  const committed = await rest("POST", `/jobs/${jobId}/countersign`, {
    signature: await freelancer.signMessage({ message: hire.signThisExactly }),
  }, freelancerHeaders);
  assert.equal(committed.fundingRequest.escrowAddress, escrowAddress);
  assert.equal(committed.fundingRequest.amountUnits, "12500000");
  assert.match(committed.fundingRequest.approval.data, /^0x/);
  assert.match(committed.fundingRequest.funding.data, /^0x/);
  const unsafeCancel = await fetch(`${base}/internal/a2a/action`, {
    method: "POST",
    headers: { "content-type": "application/json", ...internalHeaders },
    body: JSON.stringify({
      conversationJobId: publishTask,
      buyerAgentId: "buyer-42",
      action: "cancel-hire",
      args: {},
    }),
  });
  assert.equal(unsafeCancel.status, 400);
  assert.match((await unsafeCancel.json()).error, /both signatures already exist/);

  await rest("POST", "/internal/escrow-event", {
    eventName: "EscrowFunded",
    transactionHash: `0x${"aa".repeat(32)}`,
    blockNumber: "100",
    logIndex: 0,
    args: {
      commitmentHash: hire.commitmentHash,
      buyer: buyer.address,
      provider: freelancer.address,
      payout: freelancer.address,
      amount: "12500000",
      deadline: String(hireDeadline),
    },
  });
  assert.match(portMessages[1].content, /^\[prime-port:escrow-funding-ready\]/);
  assert.match(portMessages[2].content, /^\[prime-port:escrow-locked\]/);

  const revision1 = await rest("POST", `/jobs/${jobId}/submissions`, {
    note: "First version.",
  }, freelancerHeaders);
  await call("review_submission", {
    jobId,
    submissionId: revision1.submission.submissionId,
    decision: "request_changes",
    feedback: "Add the missing verification result.",
  });
  const revision2 = await rest("POST", `/jobs/${jobId}/submissions`, {
    note: "Revised version with verification result.",
  }, freelancerHeaders);
  await call("review_submission", {
    jobId,
    submissionId: revision2.submission.submissionId,
    decision: "accept",
  });
  const deliveryContext = await a2aAction("context");
  assert.equal(deliveryContext.submissions[0].candidateId, "C1");
  assert.equal(deliveryContext.submissions[0].freelancerInboxId, undefined);
  const approval = await call("approve", { jobId, note: "Approved final revision." });
  assert.equal(approval.transaction.to, escrowAddress);
  assert.match(approval.transaction.data, /^0x/);
  await rest("POST", "/internal/escrow-event", {
    eventName: "EscrowReleased",
    transactionHash: `0x${"bb".repeat(32)}`,
    blockNumber: "101",
    logIndex: 0,
    args: {
      commitmentHash: hire.commitmentHash,
      payout: freelancer.address,
      amount: "12500000",
    },
  });

  const job = (await rest("GET", "/jobs", undefined, internalHeaders)).find((candidate) => candidate.jobId === jobId);
  assert.equal(job.status, "settled");
  assert.equal(job.settlement.status, "released");
  assert.equal(job.settlement.finalSubmissionId, revision2.submission.submissionId);
  assert.deepEqual(job.submissions.map((submission) => submission.status), ["revision-requested", "accepted"]);
  assert.equal(portMessages.length, 6);
  assert.match(portMessages.at(-1).content, /^\[prime-port:escrow-released\]/);

  const disputedPublish = await call("publish", {
    publishToken: "settlement-e2e-backend-token",
    title: "Test GenLayer dispute settlement",
    description: "Create a second funded job whose disagreement is resolved through the GenLayer verdict path.",
    deliverables: "A written result that can be evaluated against signed criteria.",
    criteria: "The result must include the requested verification evidence.",
    price: "0.0001",
    currency: "USDT",
    deadline: Math.floor(Date.now() / 1000) + 7200,
    agentId: "buyer-42",
    agentWallet: buyer.address,
    marketplaceJobId: "paid-public-dispute-test",
  });
  const disputedJobId = disputedPublish.jobId;
  await rest("POST", `/jobs/${disputedJobId}/publish-task/paid`, { marketplaceJobId: "paid-public-dispute-test" });
  await rest("POST", `/jobs/${disputedJobId}/claims`, {
    payoutAddress: freelancer.address,
    name: "Test Freelancer",
  }, freelancerHeaders);
  const disputedDeadline = Math.floor(Date.now() / 1000) + 7200;
  const disputedHire = await call("hire", {
    jobId: disputedJobId,
    claimantInboxId: "freelancer-inbox-test",
    price: "0.0001",
    deadline: disputedDeadline,
  });
  await call("confirm_hire", {
    jobId: disputedJobId,
    signature: await buyer.signMessage({ message: disputedHire.signThisExactly }),
  });
  await rest("POST", `/jobs/${disputedJobId}/countersign`, {
    signature: await freelancer.signMessage({ message: disputedHire.signThisExactly }),
  }, freelancerHeaders);
  await rest("POST", "/internal/escrow-event", {
    eventName: "EscrowFunded",
    transactionHash: `0x${"cc".repeat(32)}`,
    blockNumber: "102",
    logIndex: 0,
    args: {
      commitmentHash: disputedHire.commitmentHash,
      buyer: buyer.address,
      provider: freelancer.address,
      payout: freelancer.address,
      amount: "100",
      deadline: String(disputedDeadline),
    },
  });
  const dispute = await rest("POST", `/jobs/${disputedJobId}/dispute`, {
    reason: "The buyer and provider cannot agree whether the requested verification evidence was delivered.",
  }, freelancerHeaders);
  assert.match(dispute.evidenceHash, /^0x[0-9a-f]{64}$/);
  assert.equal(dispute.transaction.to, escrowAddress);
  const evidenceResponse = await fetch(`${base}/evidence/${dispute.evidenceHash}`);
  assert.equal(evidenceResponse.status, 200);
  const evidence = await evidenceResponse.json();
  assert.equal(evidence.commitmentHash, disputedHire.commitmentHash);
  assert.equal(JSON.stringify(evidence).includes('"secret"'), false);

  await rest("POST", "/internal/escrow-event", {
    eventName: "DisputeOpened",
    transactionHash: `0x${"dd".repeat(32)}`,
    blockNumber: "103",
    logIndex: 0,
    args: {
      commitmentHash: disputedHire.commitmentHash,
      openedBy: freelancer.address,
      evidenceHash: dispute.evidenceHash,
    },
  });
  const genLayerSubmissionHash = `0x${"66".repeat(32)}`;
  await rest("POST", `/jobs/${disputedJobId}/genlayer-submitted`, {
    transactionHash: genLayerSubmissionHash,
  }, { "x-relayer-token": "settlement-e2e-relayer-token" });
  const submittedJob = (await rest("GET", "/jobs", undefined, internalHeaders)).find((candidate) => candidate.jobId === disputedJobId);
  assert.equal(submittedJob.settlement.genlayerSubmissionHash, genLayerSubmissionHash);
  await rest("POST", "/internal/escrow-event", {
    eventName: "DisputeResolved",
    transactionHash: `0x${"ee".repeat(32)}`,
    blockNumber: "104",
    logIndex: 0,
    args: {
      commitmentHash: disputedHire.commitmentHash,
      resolutionId: `0x${"44".repeat(32)}`,
      verdictHash: `0x${"55".repeat(32)}`,
      providerBps: "7500",
      providerAmount: "75",
      buyerAmount: "25",
    },
  });
  const disputedJob = (await rest("GET", "/jobs", undefined, internalHeaders)).find((candidate) => candidate.jobId === disputedJobId);
  assert.equal(disputedJob.status, "settled");
  assert.equal(disputedJob.settlement.status, "resolved");
  assert.equal(disputedJob.settlement.providerBps, 7500);
  console.log("ok - X Layer escrow lifecycle, revision loop, and direct release");
  console.log("ok - dispute evidence, GenLayer verdict, and split settlement lifecycle");
  console.log(`state: ${dataDir}`);
} finally {
  if (mcp) await mcp.close().catch(() => {});
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  await close(fakePort);
}
