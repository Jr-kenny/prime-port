import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { encodePaymentSignatureHeader } from "@okxweb3/x402-core/http";

const port = 18793;
const endpoint = `http://127.0.0.1:${port}`;
const portServicePort = 18791;

async function waitUntilReady(child) {
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/jobs`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start: ${stderr}`);
}

test("paid publish advertises the exact 1 USDt0 payment and its POST input schema", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "prime-port-x402-test-"));
  const portService = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/ports") {
      for await (const _chunk of req) {}
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        inboxId: "test-port-inbox-id",
        address: "0x2222222222222222222222222222222222222222",
        grantToken: "test-grant-token",
      }));
      return;
    }
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "not found" }));
  });
  portService.listen(portServicePort, "127.0.0.1");
  await once(portService, "listening");
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_BASE_URL: endpoint,
      NODE_ENV: "test",
      X402_TEST_SETTLEMENT: "1",
      MCP_DATA_DIR: dataDir,
      PORT_SVC: `http://127.0.0.1:${portServicePort}`,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(async () => {
    child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
    portService.close();
    await once(portService, "close");
    rmSync(dataDir, { recursive: true, force: true });
  });
  await waitUntilReady(child);

  const discoveryResponse = await fetch(`${endpoint}/mcp/publish`, {
    headers: { accept: "application/json" },
  });
  assert.equal(discoveryResponse.status, 402);

  const discoveryEncoded = discoveryResponse.headers.get("payment-required");
  assert.ok(discoveryEncoded, "GET discovery includes the PAYMENT-REQUIRED header");
  const discoveryChallenge = JSON.parse(Buffer.from(discoveryEncoded, "base64").toString("utf8"));
  const discoveryBody = await discoveryResponse.json();
  assert.equal(discoveryBody.x402Version, discoveryChallenge.x402Version);
  assert.deepEqual(discoveryBody.resource, discoveryChallenge.resource);
  assert.deepEqual(discoveryBody.accepts, discoveryChallenge.accepts);
  assert.match(discoveryBody.resource.description, /calling buyer agent/);
  assert.match(discoveryBody.resource.description, /real human/);
  assert.match(discoveryBody.resource.description, /private Prime Port/);

  const response = await fetch(`${endpoint}/mcp/publish`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 402);

  const unpaidBody = await response.json();
  assert.equal(unpaidBody.x402Version, 2);
  assert.deepEqual(unpaidBody.resource, discoveryChallenge.resource);
  assert.deepEqual(unpaidBody.accepts, discoveryChallenge.accepts);
  assert.equal(unpaidBody.outputSchema.method, "POST");
  assert.match(unpaidBody.outputSchema.description, /calling buyer agent/);
  assert.equal(unpaidBody.outputSchema.input.title.carrier, "body");
  assert.equal(unpaidBody.outputSchema.input.title.required, true);
  assert.equal(unpaidBody.outputSchema.input.title.type, "string");
  assert.equal(unpaidBody.outputSchema.input.title.minLength, 8);
  assert.match(unpaidBody.outputSchema.input.title.description, /actual human task/);
  assert.equal(unpaidBody.outputSchema.input.deadline.carrier, "body");
  assert.equal(unpaidBody.outputSchema.input.deadline.required, true);
  assert.equal(unpaidBody.outputSchema.input.deadline.type, "integer");
  assert.match(unpaidBody.outputSchema.input.deadline.description, /future/);
  assert.match(unpaidBody.outputSchema.input.agentWallet.description, /x402 payer/);
  assert.equal(unpaidBody.outputSchema.input.price.required, false);

  const encoded = response.headers.get("payment-required");
  assert.ok(encoded, "PAYMENT-REQUIRED header is present");
  const challenge = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  assert.deepEqual(discoveryChallenge, challenge);
  assert.equal(challenge.x402Version, 2);
  assert.equal(challenge.resource.url, `${endpoint}/mcp/publish`);
  assert.deepEqual(challenge.accepts.map(({ scheme, network, amount, asset, payTo }) => ({
    scheme, network, amount, asset, payTo,
  })), [{
    scheme: "exact",
    network: "eip155:196",
    amount: "1000000",
    asset: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
    payTo: "0x7ab4daee18a449eb76a8a7d66cb02cf34a28563e",
  }]);

  const signedWithoutInputs = await fetch(`${endpoint}/mcp/publish`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "payment-signature": "diagnostic-placeholder",
    },
    body: JSON.stringify({}),
  });
  assert.equal(signedWithoutInputs.status, 400);
  const inputRequired = await signedWithoutInputs.json();
  assert.equal(inputRequired.status, "input_required");
  assert.ok(inputRequired.requiredArgs.includes("title"));
  assert.ok(inputRequired.fields.some((field) => field.name === "agentWallet"));

  const payer = "0x1111111111111111111111111111111111111111";
  const paymentSignature = encodePaymentSignatureHeader({
    x402Version: 2,
    resource: challenge.resource,
    accepted: challenge.accepts[0],
    payload: {
      authorization: {
        from: payer,
        to: challenge.accepts[0].payTo,
        value: challenge.accepts[0].amount,
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${"33".repeat(32)}`,
      },
      signature: `0x${"44".repeat(65)}`,
    },
  });
  const paid = await fetch(`${endpoint}/mcp/publish`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "payment-signature": paymentSignature,
    },
    body: JSON.stringify({
      title: "Photograph a Lagos storefront",
      description: "Take a current daylight photograph of a specified Lagos storefront.",
      criteria: "Store name and entrance must both be visible.",
      deliverables: "One original JPEG photograph with timestamp metadata.",
      deadline: 1999999999,
      agentId: "5941",
      agentWallet: payer,
    }),
  });
  assert.equal(paid.status, 200);
  assert.ok(paid.headers.get("payment-response"));
  const paidBody = await paid.json();
  assert.match(paidBody.jobId, /^job-/);

  const jobsResponse = await fetch(`${endpoint}/jobs`);
  assert.equal(jobsResponse.status, 200);
  const jobs = await jobsResponse.json();
  const published = jobs.find((job) => job.jobId === paidBody.jobId);
  assert.ok(published, "settled publication is visible");
  const storedJobs = JSON.parse(readFileSync(join(dataDir, "jobs.json"), "utf8"));
  assert.ok(storedJobs[paidBody.jobId].publishTask.paidAt, "paidAt is written after settlement");
  assert.equal(storedJobs[paidBody.jobId].publishTask.settlement.transaction, `0x${"ab".repeat(32)}`);
});
