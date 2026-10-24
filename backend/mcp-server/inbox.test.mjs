// The job inbox is the only buyer-facing conversation surface after the A2A
// bridge was removed, so it gets the same treatment as the publish path: a
// real server process, a fake transport, and assertions on the wire contract.
//
// What matters here is the contract an agent codes against:
//   - a stable cursor (`after`/`cursor`) rather than a full transcript each poll
//   - `wait` as a long-poll, so an agent can block instead of hammering
//   - the buyer's own message appears once, not twice (send + transport echo)
//   - a candidate reply from the transport lands on the right lane
//   - a job with several candidates refuses an unaddressed write
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const port = 18805;
const portServicePort = 18807;
const endpoint = `http://127.0.0.1:${port}`;

const readJson = async (req) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
};
const reply = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};

test("the job inbox is an append-only, cursor-based conversation over plain HTTP", async (t) => {
  const buyer = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
  const jobId = "job-inbox-test";

  // Messages the "transport" currently holds, keyed by peer inbox id. The test
  // appends to these to simulate a candidate replying over XMTP.
  const channels = new Map([
    ["freelancer-1", []],
    ["freelancer-2", []],
  ]);
  const outbound = [];

  const portService = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/ports") {
      await readJson(req);
      return reply(res, 200, {
        inboxId: "port-inbox",
        address: "0x0000000000000000000000000000000000000001",
        grantToken: "grant",
      });
    }
    const url = new URL(req.url, "http://x");
    const channelMatch = url.pathname.match(/^\/ports\/([^/]+)\/channel$/);
    if (req.method === "GET" && channelMatch) {
      const peer = url.searchParams.get("peer");
      return reply(res, 200, {
        messages: channels.get(peer) ?? [],
        transcriptHash: `0x${"11".repeat(32)}`,
      });
    }
    const messagesMatch = url.pathname.match(/^\/ports\/([^/]+)\/messages$/);
    if (req.method === "POST" && messagesMatch) {
      const body = await readJson(req);
      outbound.push(body);
      return reply(res, 200, { sent: true, messageId: `transport-out-${outbound.length}` });
    }
    const conversationsMatch = url.pathname.match(/^\/ports\/([^/]+)\/conversations$/);
    if (req.method === "GET" && conversationsMatch) {
      return reply(res, 200, {
        conversations: [...channels].map(([peerInboxId, messages]) => ({
          peerInboxId,
          messageCount: messages.length,
          attachmentCount: 0,
          lastMessage: messages.at(-1) ?? null,
        })),
      });
    }
    return reply(res, 404, { error: `no fake port route ${req.method} ${url.pathname}` });
  });
  portService.listen(portServicePort, "127.0.0.1");
  await once(portService, "listening");

  const dataDir = mkdtempSync(join(tmpdir(), "prime-port-inbox-test-"));
  writeFileSync(join(dataDir, "jobs.json"), JSON.stringify({
    [jobId]: {
      jobId,
      status: "open",
      title: "Photograph a Lagos storefront",
      description: "Take a current daylight photograph of a specified Lagos storefront.",
      deliverables: "One original JPEG photograph with timestamp metadata.",
      criteria: "Store name and entrance must both be visible.",
      price: null,
      currency: "USDT",
      deadline: 1999999999,
      agent: { agentId: buyer.address, wallet: buyer.address },
      port: { inboxId: "port-inbox", address: "0x0000000000000000000000000000000000000001", grantToken: "grant" },
      claims: [
        { inboxId: "freelancer-1", name: "Ada", payoutAddress: "0x00000000000000000000000000000000000000aa", claimedAt: 1 },
        { inboxId: "freelancer-2", name: "Bola", payoutAddress: "0x00000000000000000000000000000000000000bb", claimedAt: 2 },
      ],
      submissions: [],
      publishTask: { paidAt: 1, paymentMode: "native-eth", publishId: "memo-test" },
      createdAt: 1,
    },
  }));

  let stderr = "";
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_BASE_URL: endpoint,
      NODE_ENV: "test",
      MCP_DATA_DIR: dataDir,
      PORT_SVC: `http://127.0.0.1:${portServicePort}`,
      PAY_TO_ADDRESS: "0x7ab4daee18a449eb76a8a7d66cb02cf34a28563e",
      PUBLISH_PRICE_ETH: "0.001",
      PUBLISH_CHAIN_ID: "46630",
      PUBLISH_RPC_URL: "http://127.0.0.1:1",
      ESCROW_CHAIN_ID: "46630",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
    portService.closeAllConnections?.();
    const closed = once(portService, "close");
    portService.close();
    await closed;
    rmSync(dataDir, { recursive: true, force: true });
  });

  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/jobs`);
      if (response.ok) break;
    } catch {}
    if (child.exitCode !== null) throw new Error(`server exited early\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const session = async (account) => {
    const challenge = await (await fetch(`${endpoint}/auth/agent-challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: account.address }),
    })).json();
    const signed = await (await fetch(`${endpoint}/auth/agent-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challenge: challenge.challenge,
        signature: await account.signMessage({ message: challenge.message }),
      }),
    })).json();
    return { authorization: `Bearer ${signed.token}` };
  };

  const buyerHeaders = await session(buyer);
  const get = (path, headers = buyerHeaders) => fetch(`${endpoint}${path}`, { headers });
  const post = (path, body, headers = buyerHeaders) => fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

  // Threads are the candidate list, addressed by alias only.
  const threads = await (await get(`/jobs/${jobId}/threads`)).json();
  assert.deepEqual(threads.threads.map((thread) => thread.candidateId), ["C1", "C2"]);
  assert.equal(JSON.stringify(threads).includes("freelancer-1"), false, "the inbox never exposes a candidate inbox id");

  const empty = await (await get(`/jobs/${jobId}/inbox`)).json();
  assert.deepEqual(empty.messages, []);
  assert.equal(empty.cursor, 0);

  // Two candidates means a write must say which lane it belongs to.
  const ambiguous = await post(`/jobs/${jobId}/messages`, { body: "Hello" });
  assert.equal(ambiguous.status, 400);
  assert.match((await ambiguous.json()).error, /candidateId is required/);

  // The buyer's own message: accepted, recorded once, and relayed verbatim.
  const sent = await post(`/jobs/${jobId}/messages`, { candidateId: "C1", body: "Hi Ada, can you shoot at 9am?", clientId: "intro-1" });
  assert.equal(sent.status, 200);
  const sentBody = await sent.json();
  assert.equal(sentBody.candidateId, "C1");
  assert.equal(sentBody.seq, 1);
  assert.equal(sentBody.cursor, 1);
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].peerInboxId, "freelancer-1");
  assert.equal(outbound[0].content, "Hi Ada, can you shoot at 9am?", "the relay must not rewrite the message");

  // A retry with the same clientId returns the original result, not a second
  // message to the human.
  const retriedSend = await post(`/jobs/${jobId}/messages`, { candidateId: "C1", body: "Hi Ada, can you shoot at 9am?", clientId: "intro-1" });
  assert.equal(retriedSend.status, 200);
  const retriedBody = await retriedSend.json();
  assert.equal(retriedBody.duplicate, true);
  assert.equal(retriedBody.seq, 1);
  assert.equal(outbound.length, 1, "a retried send does not reach the human twice");

  const afterSend = await (await get(`/jobs/${jobId}/inbox?after=0`)).json();
  assert.equal(afterSend.messages.length, 1);
  assert.equal(afterSend.messages[0].from, "buyer");
  assert.equal(afterSend.messages[0].body, "Hi Ada, can you shoot at 9am?");

  // The transport echoes the buyer's own message back. Same id, so no duplicate.
  channels.get("freelancer-1").push({
    messageId: "transport-out-1",
    sentAtNs: "1700000000000000000",
    fromPort: true,
    kind: "text",
    content: "Hi Ada, can you shoot at 9am?",
  });

  // A candidate replies on the other lane.
  channels.get("freelancer-2").push({
    messageId: "transport-in-1",
    sentAtNs: "1700000001000000000",
    fromPort: false,
    kind: "text",
    content: "I can do 9am, sending a sample.",
  });

  const afterReply = await (await get(`/jobs/${jobId}/inbox?after=1`)).json();
  assert.equal(afterReply.messages.length, 1, "the buyer's own echo is not re-appended");
  assert.equal(afterReply.messages[0].seq, 2);
  assert.equal(afterReply.messages[0].candidateId, "C2");
  assert.equal(afterReply.messages[0].from, "candidate");
  assert.equal(afterReply.messages[0].at, 1_700_000_001_000);
  assert.equal(afterReply.cursor, 2);

  // Long poll: nothing now, then a candidate reply arrives mid-wait.
  const waiting = get(`/jobs/${jobId}/inbox?after=2&wait=10`).then((response) => response.json());
  await new Promise((resolve) => setTimeout(resolve, 250));
  channels.get("freelancer-1").push({
    messageId: "transport-in-2",
    sentAtNs: "1700000002000000000",
    fromPort: false,
    kind: "text",
    content: "9am confirmed.",
  });
  const longPolled = await waiting;
  assert.equal(longPolled.messages.length, 1);
  assert.equal(longPolled.messages[0].seq, 3);
  assert.equal(longPolled.messages[0].candidateId, "C1");
  assert.equal(longPolled.messages[0].body, "9am confirmed.");

  // Someone else's wallet cannot read the lane.
  const strangerHeaders = await session(stranger);
  const forbidden = await get(`/jobs/${jobId}/inbox`, strangerHeaders);
  assert.equal(forbidden.status, 403);

  const anonymous = await fetch(`${endpoint}/jobs/${jobId}/inbox`);
  assert.equal(anonymous.status, 403);
});
