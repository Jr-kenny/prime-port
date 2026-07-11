// End-to-end against the live XMTP dev network, through the service API only:
// mint a port, grant an agent installation via token-authed remote signing,
// negotiate with a freelancer (stand-in key for the production embedded
// wallet), scrap, then verify the agent is locked out and the archive's
// transcript hash reproduces from its own entries.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client, IdentifierKind } from "@xmtp/node-sdk";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { toBytes } from "viem";
import { transcriptHash } from "../commitment/commitment.mjs";

const SVC = "http://localhost:8791";
const jobId = `e2e-${Date.now()}`;
const api = async (method, path, body, headers = {}) => {
  const r = await fetch(`${SVC}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${j.error}`);
  return j;
};
const ok = (name, cond) => {
  console.log(`${cond ? "ok " : "FAIL"} - ${name}`);
  if (!cond) process.exitCode = 1;
};

// mint
const port = await api("POST", "/ports", { jobId });
ok("mint returns inbox + grant token", !!port.inboxId && !!port.grantToken);

// grant: agent registers its own installation through the authed endpoint
const agentSigner = {
  type: "EOA",
  getIdentifier: () => ({ identifier: port.address, identifierKind: IdentifierKind.Ethereum }),
  signMessage: async (message) =>
    toBytes(
      (
        await api("POST", `/ports/${jobId}/grant/sign`, { message }, { "x-grant-token": port.grantToken })
      ).signature,
    ),
};
const agent = await Client.create(agentSigner, { env: "dev", dbPath: `./data/e2e-agent-${jobId}.db3` });
ok("agent installation lands on port inbox", agent.inboxId === port.inboxId);

// wrong token must fail
const denied = await fetch(`${SVC}/ports/${jobId}/grant/sign`, {
  method: "POST",
  headers: { "x-grant-token": "nope" },
  body: JSON.stringify({ message: "gimme" }),
});
ok("grant rejects bad token", denied.status === 400);

// operate: freelancer stand-in negotiates with the port
const flAccount = privateKeyToAccount(generatePrivateKey());
const fl = await Client.create(
  {
    type: "EOA",
    getIdentifier: () => ({ identifier: flAccount.address.toLowerCase(), identifierKind: IdentifierKind.Ethereum }),
    signMessage: async (message) => toBytes(await flAccount.signMessage({ message })),
  },
  { env: "dev", dbPath: `./data/e2e-fl-${jobId}.db3` },
);
const dm = await fl.conversations.newDm(port.inboxId);
await dm.send("claiming this job. 40 USDT is low, I want 55.");
await agent.conversations.syncAll();
const agentSide = (await agent.conversations.list())[0];
await agentSide.sync();
await agentSide.send("meet me at 48 and it's a deal.");
await dm.sync();
const reply = (await dm.messages()).find((m) => m.senderInboxId === port.inboxId && typeof m.content === "string");
ok("freelancer sees agent's reply as the port", !!reply);

// scrap through the API
const scrapped = await api("POST", `/ports/${jobId}/scrap`, {});
ok("scrap revoked the agent installation", scrapped.revokedInstallations.includes(agent.installationId));
ok("scrap archived a transcript hash", scrapped.archive.transcriptHashes.length === 1);

// Lockout invariant: once the agent's client processes the flush commit, its
// sends fail hard. (A client that refuses to sync can still inject into the
// short MLS past-epoch window; the archive is taken at scrap, so nothing after
// the closing marker can ever become evidence. See docs/port-mechanics.md.)
let lockedOut = false;
for (let i = 0; i < 10 && !lockedOut; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  try {
    await agent.conversations.syncAll();
    await agentSide.sync();
    await agentSide.send(`still here? (attempt ${i})`);
  } catch {
    lockedOut = true;
  }
}
ok("agent send fails hard once its client syncs the scrap commit", lockedOut);

// port status shows scrapped, token gone
const status = await api("GET", `/ports/${jobId}`);
ok("status is scrapped and grant token withheld", status.status === "scrapped" && !status.grantToken);

// archive integrity: hash reproduces from entries, and entries match plaintext
const archivePath = new URL(`./data/archive/${jobId}.json`, import.meta.url).pathname;
const arch = JSON.parse(readFileSync(archivePath, "utf8"));
const convo = arch.conversations[0];
ok("archive hash reproduces from its own entries", transcriptHash(convo.entries) === convo.transcriptHash);
const textRows = convo.plaintext.filter((p) => p.content !== null);
const rehash = textRows.every((p) => {
  const entry = convo.entries.find((e) => e.id === p.id);
  return entry.contentSha256 === "0x" + createHash("sha256").update(p.content).digest("hex");
});
ok("plaintext re-hashes to the committed entry hashes", rehash);

console.log(process.exitCode ? "E2E FAILED" : "E2E PASSED");
process.exit(process.exitCode ?? 0);
