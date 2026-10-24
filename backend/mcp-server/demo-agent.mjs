// The client agent's hands for the live demo role-play: Kenny plays the
// freelancer in the web app, whoever drives this plays the hiring agent.
// Each subcommand is one beat of the storyboard, so the agent side moves at
// conversation speed on camera.
//
// The port side is entirely real: real MCP tools, real XMTP channel, real
// signatures over the real commitment. The publish fee and the wage escrow
// are simulated locally, because the camera is pointed at the port; the
// on-chain run happens separately. Start the demo server with
// ESCROW_TEST_EVENTS=1 so the simulated escrow lock is accepted.
//
// Usage (BACKEND defaults to http://localhost:7860):
//   node demo-agent.mjs publish "<title>" "<criteria>" [price]   (omit price = open to offers)
//   node demo-agent.mjs offers <jobId>
//   node demo-agent.mjs say <jobId> <claimantInboxId> <message...>
//   node demo-agent.mjs hire <jobId> <claimantInboxId> <price>   (hire + sign + confirm)
//   node demo-agent.mjs escrow <jobId>       (simulate the wage task lock -> "hired")
//   node demo-agent.mjs approve <jobId> [closing message...]   (word before the port closes)
//   node demo-agent.mjs status <jobId>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const BACKEND = process.env.BACKEND ?? "http://localhost:7860";

// One persistent throwaway wallet, so confirm_hire's signature check passes
// across separate invocations of this script.
const DATA = new URL("./data/", import.meta.url).pathname;
mkdirSync(DATA, { recursive: true });
const keyPath = `${DATA}demo-agent-key`;
if (!existsSync(keyPath)) writeFileSync(keyPath, generatePrivateKey(), { mode: 0o600 });
const agent = privateKeyToAccount(readFileSync(keyPath, "utf8").trim());

const rest = async (method, path, body, extraHeaders = {}) => {
  const r = await fetch(`${BACKEND}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${j.error}`);
  return j;
};

const challenge = await rest("POST", "/auth/agent-challenge", { wallet: agent.address });
const authenticated = await rest("POST", "/auth/agent-session", {
  challenge: challenge.challenge,
  signature: await agent.signMessage({ message: challenge.message }),
});

const mcp = new McpClient({ name: "demo-agent", version: "0.0.1" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(`${BACKEND}/mcp`), {
  requestInit: { headers: { authorization: `Bearer ${authenticated.token}` } },
}));
const call = async (name, args) => {
  const r = await mcp.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
};
const show = (obj) => console.log(JSON.stringify(obj, null, 2));

const [cmd, ...rest_] = process.argv.slice(2);
try {
  if (cmd === "publish") {
    const [title, criteria, price] = rest_;
    if (!title || !criteria) throw new Error("usage: publish <title> <criteria> [price]  (omit price to list open to offers)");
    const pub = await rest("POST", "/jobs", {
      title,
      description: `${title}. Demo brief: do the work described by the acceptance criteria and return the deliverables.`,
      deliverables: "The artifact described by the title, plus a short note on what was done.",
      criteria,
      ...(price ? { price } : {}),
      currency: "USDT",
      deadline: Math.floor(Date.now() / 1000) + 86400,
      agentId: "demo-client-agent",
      agentWallet: agent.address,
    }, { "x-backend-service-token": process.env.BACKEND_SERVICE_TOKEN ?? "" });
    show({ jobId: pub.jobId, port: pub.port, publishFeePaid: "internal" });
  } else if (cmd === "offers") {
    show(await call("get_offers", { jobId: rest_[0] }));
  } else if (cmd === "say") {
    const [jobId, claimantInboxId, ...words] = rest_;
    const r = await call("negotiate", { jobId, claimantInboxId, message: words.join(" ") });
    show(r.channel.slice(-6));
  } else if (cmd === "hire") {
    const [jobId, claimantInboxId, price] = rest_;
    const hire = await call("hire", {
      jobId,
      claimantInboxId,
      price,
      deadline: Math.floor(Date.now() / 1000) + 86400,
    });
    const signature = await agent.signMessage({ message: hire.signThisExactly });
    const confirmed = await call("confirm_hire", { jobId, signature });
    show({ commitmentHash: hire.commitmentHash, signed: true, ...confirmed });
  } else if (cmd === "escrow") {
    const jobId = rest_[0];
    const internal = { "x-backend-service-token": process.env.BACKEND_SERVICE_TOKEN ?? "" };
    const job = (await rest("GET", "/jobs", undefined, internal)).find((candidate) => candidate.jobId === jobId);
    if (!job?.pendingHire) throw new Error("hire and countersign first: the job has no pending hire to fund");
    const { commitmentHash, terms, escrow } = job.pendingHire;
    show(await rest("POST", "/internal/escrow-event", {
      eventName: "EscrowFunded",
      transactionHash: `0x${"aa".repeat(32)}`,
      blockNumber: "100",
      logIndex: 0,
      args: {
        commitmentHash,
        buyer: escrow.buyer,
        provider: escrow.provider,
        payout: escrow.payout,
        amount: escrow.amountUnits,
        deadline: String(terms.deadline),
      },
    }, internal));
  } else if (cmd === "approve") {
    const [jobId, ...words] = rest_;
    const note = words.join(" ") || undefined;
    show(await call("approve", { jobId, note }));
  } else if (cmd === "status") {
    const jobs = await rest("GET", "/jobs");
    const job = jobs.find((j) => j.jobId === rest_[0]);
    show(job ? { jobId: job.jobId, status: job.status, claims: job.claims.length, pendingHire: job.pendingHire?.hash } : { error: "unknown job" });
  } else {
    console.error("commands: publish | offers | say | hire | escrow | approve | status");
    process.exitCode = 1;
  }
} finally {
  await mcp.close();
}
