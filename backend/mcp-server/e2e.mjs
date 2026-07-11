// The demo storyboard as a test, driven through the real surfaces only:
// the agent talks MCP, the freelancer talks REST + XMTP (stand-in key for the
// production embedded wallet), and escrow/marketplace moments show up as
// events. Needs port-service on :8791 and mcp-server on :8792.
import { readFileSync } from "node:fs";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client as Xmtp, IdentifierKind } from "@xmtp/node-sdk";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { toBytes } from "viem";
import { commitmentHash, signingMessage } from "../commitment/commitment.mjs";

const MCP = "http://localhost:8792/mcp";
const REST = "http://localhost:8792";
const ok = (name, cond) => {
  console.log(`${cond ? "ok " : "FAIL"} - ${name}`);
  if (!cond) process.exitCode = 1;
};
const rest = async (method, path, body) => {
  const r = await fetch(`${REST}${path}`, { method, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${j.error}`);
  return j;
};

const mcp = new McpClient({ name: "e2e-agent", version: "0.0.1" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(MCP)));
const call = async (name, args) => {
  const r = await mcp.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
};

// the hiring agent's marketplace wallet (stand-in)
const agentAccount = privateKeyToAccount(generatePrivateKey());

// 1. agent publishes
const pub = await call("publish", {
  title: "Review our docs, 700 words",
  criteria: "Write a 700-word review of the Prime Port docs. Plain English.",
  price: "40",
  currency: "USDT",
  deadline: Math.floor(Date.now() / 1000) + 86400 * 3,
  agentId: "5021-client-demo",
  agentWallet: agentAccount.address,
});
ok("publish returns a job and a port inbox", !!pub.jobId && !!pub.port.inboxId);
const { jobId } = pub;

// 2. freelancer claims via REST, then DMs the port over XMTP
const flAccount = privateKeyToAccount(generatePrivateKey());
const fl = await Xmtp.create(
  {
    type: "EOA",
    getIdentifier: () => ({ identifier: flAccount.address.toLowerCase(), identifierKind: IdentifierKind.Ethereum }),
    signMessage: async (message) => toBytes(await flAccount.signMessage({ message })),
  },
  { env: "dev", dbPath: `./data/e2e-fl-${jobId}.db3` },
);
const claim = await rest("POST", `/jobs/${jobId}/claims`, {
  inboxId: fl.inboxId,
  wallet: flAccount.address,
  name: "Dai the reviewer",
});
ok("claim accepted", claim.claimed && claim.portInboxId === pub.port.inboxId);
const dm = await fl.conversations.newDm(pub.port.inboxId);
await dm.send("claimed. 40 is low for 700 words, I want 55.");

// 3. agent sees the offer and negotiates (server-relayed fallback path)
const offers = await call("get_offers", { jobId });
ok("get_offers shows the claimant and their message", offers.offers.length === 1 && offers.offers[0].channel.messageCount >= 1);
const neg = await call("negotiate", { jobId, claimantInboxId: fl.inboxId, message: "48 and it's a deal." });
ok("negotiate relays and returns the channel", neg.channel.some((m) => m.fromPort && m.content.includes("48")));
await dm.sync();
ok("freelancer receives the port's message", (await dm.messages()).some((m) => typeof m.content === "string" && m.content.includes("48")));
await dm.send("deal at 48.");

// 4. hire at the negotiated price; agent signs; freelancer countersigns
const hire = await call("hire", {
  jobId,
  claimantInboxId: fl.inboxId,
  price: "48",
  deadline: Math.floor(Date.now() / 1000) + 86400 * 3,
});
ok("hire commitment hash matches reference impl", commitmentHash(hire.commitment) === hire.commitmentHash);
ok("hire transcript hash present", /^0x[0-9a-f]{64}$/.test(hire.commitment.transcriptHash));
ok("signing message matches spec", hire.signThisExactly === signingMessage(hire.commitmentHash));

const badSig = await mcp.callTool({
  name: "confirm_hire",
  arguments: { jobId, signature: await flAccount.signMessage({ message: hire.signThisExactly }) },
});
ok("confirm_hire rejects a signature from the wrong wallet", badSig.isError || JSON.parse(badSig.content[0].text).error !== undefined);

const agentSig = await agentAccount.signMessage({ message: hire.signThisExactly });
const confirmed = await call("confirm_hire", { jobId, signature: agentSig });
ok("agent signature verifies", confirmed.ok);

const countersigned = await rest("POST", `/jobs/${jobId}/countersign`, {
  signature: await flAccount.signMessage({ message: hire.signThisExactly }),
});
ok("freelancer countersignature verifies, job is hired", countersigned.hired);

// 5. approve: settle + scrap
const approved = await call("approve", { jobId });
ok("approve settles and archives", approved.settled && approved.archive.transcriptHashes.length === 1);

// 6. events for the other lanes
const events = readFileSync(new URL("./data/events.jsonl", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l))
  .filter((e) => e.jobId === jobId);
const types = events.map((e) => e.type);
ok(
  "event stream carries job-created, hire-committed, job-approved, port-scrapped",
  ["job-created", "hire-committed", "job-approved", "port-scrapped"].every((t) => types.includes(t)),
);
const hireEvt = events.find((e) => e.type === "hire-committed");
ok(
  "hire-committed event carries the register-at-hire payload",
  hireEvt.payoutAddress === flAccount.address.toLowerCase() && hireEvt.feeBps === 250 && hireEvt.commitmentHash === hire.commitmentHash,
);

await mcp.close();
console.log(process.exitCode ? "E2E FAILED" : "E2E PASSED");
process.exit(process.exitCode ?? 0);
