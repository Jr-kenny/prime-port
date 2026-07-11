// The port service: mint / grant / operate / scrap, one port per job.
// Grown out of backend/spike-port-grant with the lessons baked in:
//   - the port wallet key never leaves this process's data dir (vaulting is a
//     deploy concern; the interface already assumes nobody else ever sees it),
//   - grants are authed one-shot signatures gated by a grant token,
//   - scrap is revoke + flush, never revoke alone (see docs/port-mechanics.md),
//   - the archive written at scrap contains exactly the entries that
//     docs/hire-commitment.md's transcriptHash commits to.
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { Client, IdentifierKind } from "@xmtp/node-sdk";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { toBytes } from "viem";
import { transcriptHash } from "../commitment/commitment.mjs";

const ENV = process.env.XMTP_ENV ?? "dev";
const PORT = Number(process.env.PORT ?? 8791);
const DATA = new URL("./data/", import.meta.url).pathname;
const MAX_GRANT_SIGNATURES = 3; // one registration can ask for a couple of sigs
const GRANT_WINDOW_MS = 10 * 60 * 1000;

mkdirSync(`${DATA}keys`, { recursive: true });
mkdirSync(`${DATA}db`, { recursive: true });
mkdirSync(`${DATA}archive`, { recursive: true });

const registryPath = `${DATA}ports.json`;
const registry = existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, "utf8")) : {};
const saveRegistry = () => writeFileSync(registryPath, JSON.stringify(registry, null, 2));
const clients = new Map(); // jobId -> live Client (service's own installation)

function walletSigner(account) {
  return {
    type: "EOA",
    getIdentifier: () => ({
      identifier: account.address.toLowerCase(),
      identifierKind: IdentifierKind.Ethereum,
    }),
    signMessage: async (message) => toBytes(await account.signMessage({ message })),
  };
}

async function portClient(jobId) {
  if (clients.has(jobId)) return clients.get(jobId);
  const rec = registry[jobId];
  const account = privateKeyToAccount(readFileSync(`${DATA}keys/${jobId}.key`, "utf8").trim());
  const client = await Client.create(walletSigner(account), {
    env: ENV,
    dbPath: `${DATA}db/${jobId}.db3`,
  });
  if (rec.inboxId && client.inboxId !== rec.inboxId)
    throw new Error(`inbox mismatch for job ${jobId}`);
  clients.set(jobId, client);
  return client;
}

async function mint(jobId) {
  if (registry[jobId]) throw new Error(`port already exists for job ${jobId}`);
  const key = generatePrivateKey();
  writeFileSync(`${DATA}keys/${jobId}.key`, key, { mode: 0o600 });
  const account = privateKeyToAccount(key);
  registry[jobId] = { status: "minted", address: account.address.toLowerCase() };
  const client = await portClient(jobId);
  registry[jobId] = {
    status: "minted",
    address: account.address.toLowerCase(),
    inboxId: client.inboxId,
    serviceInstallation: client.installationId,
    grantToken: randomBytes(24).toString("hex"),
    grantSignatures: 0,
    grantOpenedAt: null,
    mintedAt: Date.now(),
  };
  saveRegistry();
  return registry[jobId];
}

function grantSign(jobId, token, message) {
  const rec = registry[jobId];
  if (!rec) throw new Error("unknown job");
  if (rec.status === "scrapped") throw new Error("port is scrapped");
  if (token !== rec.grantToken) throw new Error("bad grant token");
  rec.grantOpenedAt ??= Date.now();
  if (Date.now() - rec.grantOpenedAt > GRANT_WINDOW_MS) throw new Error("grant window closed");
  if (rec.grantSignatures >= MAX_GRANT_SIGNATURES) throw new Error("grant signature budget spent");
  rec.grantSignatures += 1;
  rec.status = "granted";
  saveRegistry();
  const account = privateKeyToAccount(readFileSync(`${DATA}keys/${jobId}.key`, "utf8").trim());
  return account.signMessage({ message });
}

// Archive every conversation on the port. Entries are exactly the transcript
// rows the hire commitment hashes over (docs/hire-commitment.md). Text content
// hashes as utf8; non-text content hashes its JSON encoding for now (binary
// attachments ride XMTP remote-attachment types and get their own treatment
// when the evidence pipe lands).
async function archive(jobId, client) {
  await client.conversations.syncAll();
  const convos = await client.conversations.list();
  const out = [];
  for (const c of convos) {
    await c.sync();
    const messages = await c.messages();
    const entries = messages.map((m) => ({
      id: m.id,
      sender: m.senderInboxId,
      sentAtNs: String(m.sentAtNs),
      contentSha256:
        "0x" +
        createHash("sha256")
          .update(typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""))
          .digest("hex"),
    }));
    out.push({
      conversationId: c.id,
      transcriptHash: transcriptHash(entries),
      entries,
      plaintext: messages.map((m) => ({
        id: m.id,
        sender: m.senderInboxId,
        content: typeof m.content === "string" ? m.content : null,
      })),
    });
  }
  const path = `${DATA}archive/${jobId}.json`;
  writeFileSync(path, JSON.stringify({ jobId, archivedAt: Date.now(), conversations: out }, null, 2));
  return { path, conversations: out.length, hashes: out.map((c) => c.transcriptHash) };
}

// Scrap = revoke every installation that isn't ours, THEN archive and flush.
// Order matters: the service client must sync each conversation for the first
// time after the revocation, so it rebuilds membership from the latest
// identity state and its closing send commits the eviction (rotates the
// epoch). Syncing before the revoke leaves the old membership cached and the
// flush commits nothing (found the hard way; see docs/port-mechanics.md).
async function scrap(jobId) {
  const rec = registry[jobId];
  if (!rec) throw new Error("unknown job");
  if (rec.status === "scrapped") throw new Error("already scrapped");

  const state = await Client.inboxStateFromInboxIds([rec.inboxId], ENV);
  const foreign = state[0].installations
    .map((i) => i.id)
    .filter((id) => id !== rec.serviceInstallation);
  if (foreign.length > 0) {
    const account = privateKeyToAccount(readFileSync(`${DATA}keys/${jobId}.key`, "utf8").trim());
    await Client.revokeInstallations(
      walletSigner(account),
      rec.inboxId,
      foreign.map((id) => Buffer.from(id, "hex")),
      ENV,
    );
  }

  const client = await portClient(jobId);
  const archived = await archive(jobId, client);
  for (const c of await client.conversations.list()) {
    await c.send("[port closed]");
  }

  rmSync(`${DATA}keys/${jobId}.key`);
  clients.delete(jobId);
  rec.status = "scrapped";
  rec.scrappedAt = Date.now();
  rec.revokedInstallations = foreign;
  rec.archive = { path: archived.path, transcriptHashes: archived.hashes };
  delete rec.grantToken;
  saveRegistry();
  return rec;
}

const routes = {
  "POST /ports": async (body) => {
    const { jobId } = body;
    if (!jobId || !/^[\w.-]+$/.test(jobId)) throw new Error("jobId required (word chars only)");
    const rec = await mint(jobId);
    return { jobId, inboxId: rec.inboxId, address: rec.address, grantToken: rec.grantToken };
  },
  "POST /ports/:jobId/grant/sign": async (body, { jobId }, req) => {
    const sig = await grantSign(jobId, req.headers["x-grant-token"], body.message);
    return { signature: sig };
  },
  "POST /ports/:jobId/scrap": async (_body, { jobId }) => scrap(jobId),
  "GET /ports/:jobId": async (_body, { jobId }) => {
    const rec = registry[jobId];
    if (!rec) throw new Error("unknown job");
    const { grantToken, ...publicRec } = rec;
    return { jobId, ...publicRec };
  },
};

createServer(async (req, res) => {
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
    const m = req.url.match(/^\/ports\/([\w.-]+)(\/[\w/]+)?$/);
    const key = m ? `${req.method} /ports/:jobId${m[2] ?? ""}` : `${req.method} ${req.url}`;
    const handler = routes[key];
    if (!handler) return reply(404, { error: `no route ${key}` });
    reply(200, await handler(body, { jobId: m?.[1] }, req));
  } catch (e) {
    console.error(`[port-service] ${req.method} ${req.url}:`, e.message);
    reply(400, { error: e.message });
  }
}).listen(PORT, () => console.log(`[port-service] listening on :${PORT} (env ${ENV})`));
