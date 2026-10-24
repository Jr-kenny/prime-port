import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

const port = 18795;
const rpcPort = 18796;
const portServicePort = 18797;
const endpoint = `http://127.0.0.1:${port}`;

const PAY_TO = "0x7ab4daee18a449eb76a8a7d66cb02cf34a28563e";
const PAYER = "0x1111111111111111111111111111111111111111";
const MEMO = `0x${"ab".repeat(32)}`;
const TX_OK = `0x${"01".repeat(32)}`;
const TX_SHORT = `0x${"02".repeat(32)}`;
const TX_ALT = `0x${"03".repeat(32)}`;
const ALT_MEMO = `0x${"cd".repeat(32)}`;
const AMOUNT_WEI = 1_000_000_000_000_000n;

const txFor = (hash, valueWei, memo = MEMO) => ({
  hash,
  blockHash: `0x${"11".repeat(32)}`,
  blockNumber: "0x65",
  transactionIndex: "0x0",
  from: PAYER,
  to: PAY_TO,
  value: `0x${valueWei.toString(16)}`,
  gas: "0x5208",
  gasPrice: "0x1",
  input: memo,
  nonce: "0x1",
  type: "0x0",
  chainId: "0xb626",
  v: "0x1b",
  r: `0x${"22".repeat(32)}`,
  s: `0x${"33".repeat(32)}`,
});
const receiptFor = (hash) => ({
  transactionHash: hash,
  transactionIndex: "0x0",
  blockHash: `0x${"11".repeat(32)}`,
  blockNumber: "0x65",
  from: PAYER,
  to: PAY_TO,
  cumulativeGasUsed: "0x5208",
  gasUsed: "0x5208",
  contractAddress: null,
  logs: [],
  logsBloom: `0x${"00".repeat(256)}`,
  status: "0x1",
  effectiveGasPrice: "0x1",
  type: "0x0",
});

function jsonRpcServer() {
  return createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const call = JSON.parse(body || "{}");
    const reply = (result) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
    };
    if (call.method === "eth_getTransactionByHash") {
      if (call.params?.[0] === TX_SHORT) return reply(txFor(TX_SHORT, AMOUNT_WEI - 1n));
      if (call.params?.[0] === TX_ALT) return reply(txFor(TX_ALT, AMOUNT_WEI, ALT_MEMO));
      return reply(txFor(TX_OK, AMOUNT_WEI));
    }
    if (call.method === "eth_getTransactionReceipt") return reply(receiptFor(call.params?.[0]));
    if (call.method === "eth_blockNumber") return reply("0x66");
    return reply(null);
  });
}

async function waitUntilReady(child, getStderr) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/jobs`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start: ${getStderr()}`);
}

test("native-ETH publish prices the port in ETH, binds the memo, and opens a direct port", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "prime-port-native-test-"));
  const rpc = jsonRpcServer();
  rpc.listen(rpcPort, "127.0.0.1");
  await once(rpc, "listening");

  const portService = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/ports") {
      for await (const _ of req) void _;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        inboxId: "native-port-inbox",
        address: "0x2222222222222222222222222222222222222222",
        grantToken: "native-grant-token",
      }));
      return;
    }
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "not found" }));
  });
  portService.listen(portServicePort, "127.0.0.1");
  await once(portService, "listening");

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
      PAY_TO_ADDRESS: PAY_TO,
      PUBLISH_PRICE_ETH: "0.001",
      PUBLISH_CHAIN_ID: "46630",
      PUBLISH_RPC_URL: `http://127.0.0.1:${rpcPort}`,
      PUBLISH_CONFIRMATIONS: "1",
      ESCROW_CHAIN_ID: "46630",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
    portService.closeAllConnections?.();
    rpc.closeAllConnections?.();
    const closed = [once(portService, "close"), once(rpc, "close")];
    portService.close();
    rpc.close();
    await Promise.all(closed);
    rmSync(dataDir, { recursive: true, force: true });
  });
  await waitUntilReady(child, () => stderr);

  const discovery = await fetch(`${endpoint}/mcp/publish`, { headers: { accept: "application/json" } });
  assert.equal(discovery.status, 402);
  const challenge = await discovery.json();
  assert.equal(challenge.payment.mode, "native-eth");
  assert.equal(challenge.payment.currency, "ETH");
  assert.equal(challenge.payment.chainId, 46630);
  assert.equal(challenge.payment.amountWei, "1000000000000000");
  assert.equal(challenge.payment.payTo, PAY_TO);

  const fields = {
    title: "Photograph a Lagos storefront",
    description: "Take a daylight photo of the storefront at the given address and return the original image.",
    criteria: "Store name and entrance must be visible and legible.",
    deliverables: "One original JPEG photo, unedited.",
    deadline: 1999999999,
    agentWallet: PAYER,
    price: "40",
  };
  const post = (headers, overrides = {}) => fetch(`${endpoint}/mcp/publish`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ ...fields, ...overrides }),
  });

  const unpaid = await post({});
  assert.equal(unpaid.status, 402);
  assert.equal((await unpaid.json()).payment.mode, "native-eth");

  const short = await post({ "payment-tx": TX_SHORT, "payment-memo": MEMO });
  assert.equal(short.status, 402);
  assert.match((await short.json()).error, /short/);

  const paid = await post({ "payment-tx": TX_OK, "payment-memo": MEMO });
  assert.equal(paid.status, 200);
  const paidBody = await paid.json();
  assert.ok(paidBody.jobId);
  assert.equal(paidBody.payment.transaction, TX_OK);
  assert.equal(paidBody.payment.amount, "0.001");
  assert.equal(paidBody.conversation, undefined, "a standalone publish does not promise a third-party conversation");
  assert.equal(paidBody.inbox.interface, "HTTP");
  assert.match(paidBody.next, /over the inbox/);

  const stored = JSON.parse(readFileSync(join(dataDir, "jobs.json"), "utf8"))[paidBody.jobId];
  assert.equal(stored.a2a, undefined, "no relay state is written");
  assert.equal(stored.publishTask.paymentMode, "native-eth");
  assert.equal(stored.publishTask.paymentMemo, MEMO);
  assert.ok(stored.publishTask.paidAt);
  assert.equal(stored.agent.agentId, PAYER, "the paying wallet is the agent identity when no id is supplied");

  const replay = await post({ "payment-tx": TX_OK, "payment-memo": MEMO });
  assert.equal(replay.status, 409, "a memo cannot buy a second publication");

  const impostor = await post(
    { "payment-tx": TX_ALT, "payment-memo": ALT_MEMO },
    { agentWallet: "0x9999999999999999999999999999999999999999" },
  );
  assert.equal(impostor.status, 403, "the declared wallet must be the payer");
});
