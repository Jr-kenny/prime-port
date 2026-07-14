import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

const port = 18793;
const endpoint = `http://127.0.0.1:${port}`;

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

test("paid publish advertises the exact 1 USDt0 X Layer payment", async (t) => {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_BASE_URL: endpoint,
      X402_OFFLINE_CHALLENGE: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(async () => {
    child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
  });
  await waitUntilReady(child);

  const response = await fetch(`${endpoint}/mcp/publish`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 402);

  const encoded = response.headers.get("payment-required");
  assert.ok(encoded, "PAYMENT-REQUIRED header is present");
  const challenge = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
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
});
