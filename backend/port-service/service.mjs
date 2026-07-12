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
import { AttachmentCodec, RemoteAttachmentCodec } from "@xmtp/content-type-remote-attachment";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { toBytes } from "viem";
import { transcriptHash } from "../commitment/commitment.mjs";

const ENV = process.env.XMTP_ENV ?? "dev";
const PORT = Number(process.env.PORT ?? 8791);
const DATA = new URL("./data/", import.meta.url).pathname;
const MAX_GRANT_SIGNATURES = 3; // one registration can ask for a couple of sigs
const GRANT_WINDOW_MS = 10 * 60 * 1000;
// Evidence payloads are encrypted client-side before they get here; we only
// ever hold ciphertext. 50 MB comfortably fits a short deliverable video.
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
// Base for the URLs baked into remote-attachment messages. Every reader of
// the channel (agent client, web app, archive verifier) fetches from here.
const ATTACH_BASE = process.env.ATTACH_BASE ?? `http://localhost:${PORT}`;

mkdirSync(`${DATA}keys`, { recursive: true });
mkdirSync(`${DATA}db`, { recursive: true });
mkdirSync(`${DATA}archive`, { recursive: true });
mkdirSync(`${DATA}attachments`, { recursive: true });

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
    // Evidence rides XMTP remote attachments (#18): without these codecs the
    // port would see fallback text instead of the attachment envelope.
    codecs: [new RemoteAttachmentCodec(), new AttachmentCodec()],
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
  // The scrapper: a second installation minted now and then kept cold. It
  // collects welcomes from every conversation (it exists before any DM can),
  // but never syncs until scrap. Its first sync therefore happens after the
  // revocation, so it rebuilds membership from post-revoke identity state and
  // its closing send commits the eviction, regardless of what the working
  // installation synced in between (hire and get_offers sync constantly).
  const scrapper = await Client.create(walletSigner(account), {
    env: ENV,
    dbPath: `${DATA}db/${jobId}.scrap.db3`,
  });
  registry[jobId] = {
    status: "minted",
    address: account.address.toLowerCase(),
    inboxId: client.inboxId,
    serviceInstallation: client.installationId,
    scrapInstallation: scrapper.installationId,
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

// Evidence messages (#18): a remote attachment is a small envelope — URL of
// the encrypted payload, the digest that pins those bytes, and the key
// material to decrypt them. The payload itself lives in our attachment store.
const isRemoteAttachment = (m) =>
  m.contentType?.typeId === "remoteStaticAttachment" && !!m.content?.contentDigest;
const hex = (u8) => Buffer.from(u8).toString("hex");

// Canonical bytes an entry hash commits to. Text hashes as utf8. A remote
// attachment hashes a stable JSON of its envelope: contentDigest inside binds
// the encrypted payload bytes, and the key material inside means whoever
// holds the archive can decrypt the deliverable it commits to. Everything
// else hashes its JSON encoding, as before.
function canonicalContent(m) {
  if (typeof m.content === "string") return m.content;
  if (isRemoteAttachment(m)) {
    const a = m.content;
    return JSON.stringify({
      type: "remote-attachment",
      url: a.url,
      contentDigest: a.contentDigest,
      filename: a.filename ?? "",
      contentLength: a.contentLength ?? 0,
      secret: hex(a.secret),
      salt: hex(a.salt),
      nonce: hex(a.nonce),
    });
  }
  return JSON.stringify(m.content ?? "");
}
const contentSha256 = (m) => "0x" + createHash("sha256").update(canonicalContent(m)).digest("hex");

// The public row shape for one message on a channel surface (/channel,
// /conversations, and through them the agent's get_offers). Attachment rows
// carry the whole envelope, key material included: agents on the relayed
// fallback path have no XMTP client of their own, and these surfaces already
// hand out the channel's plaintext, so the envelope hides nothing extra.
const messageRow = (m, portInboxId) =>
  typeof m.content === "string"
    ? { fromPort: m.senderInboxId === portInboxId, kind: "text", content: m.content }
    : {
        fromPort: m.senderInboxId === portInboxId,
        kind: "attachment",
        filename: m.content.filename ?? "",
        contentLength: m.content.contentLength ?? 0,
        contentDigest: m.content.contentDigest,
        url: m.content.url,
        secret: hex(m.content.secret),
        salt: hex(m.content.salt),
        nonce: hex(m.content.nonce),
      };
const isVisible = (m) => typeof m.content === "string" || isRemoteAttachment(m);

// At scrap, an attachment's payload moves into the archive next to the
// transcript that commits to it: verify the stored ciphertext against the
// digest the entry hash pinned, then copy it. The envelope (with key
// material) goes into the plaintext row so the deliverable stays readable
// after the port and its store are gone.
function archiveAttachment(jobId, a) {
  const meta = {
    filename: a.filename ?? "",
    contentLength: a.contentLength ?? 0,
    contentDigest: a.contentDigest,
    url: a.url,
    secret: hex(a.secret),
    salt: hex(a.salt),
    nonce: hex(a.nonce),
  };
  const src = `${DATA}attachments/${jobId}/${a.contentDigest}`;
  if (!existsSync(src)) return { ...meta, payload: null, note: "payload not hosted here" };
  const payload = readFileSync(src);
  if (createHash("sha256").update(payload).digest("hex") !== a.contentDigest)
    return { ...meta, payload: null, note: "stored payload does not match contentDigest" };
  mkdirSync(`${DATA}archive/${jobId}.attachments`, { recursive: true });
  writeFileSync(`${DATA}archive/${jobId}.attachments/${a.contentDigest}`, payload);
  return { ...meta, payload: `${jobId}.attachments/${a.contentDigest}` };
}

// Archive every conversation on the port. Entries are exactly the transcript
// rows the hire commitment hashes over (docs/hire-commitment.md); see
// canonicalContent for what each entry hash commits to.
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
      contentSha256: contentSha256(m),
    }));
    out.push({
      conversationId: c.id,
      transcriptHash: transcriptHash(entries),
      entries,
      plaintext: messages.map((m) => ({
        id: m.id,
        sender: m.senderInboxId,
        content: typeof m.content === "string" ? m.content : null,
        ...(isRemoteAttachment(m) ? { attachment: archiveAttachment(jobId, m.content) } : {}),
      })),
    });
  }
  const path = `${DATA}archive/${jobId}.json`;
  writeFileSync(path, JSON.stringify({ jobId, archivedAt: Date.now(), conversations: out }, null, 2));
  return { path, conversations: out.length, hashes: out.map((c) => c.transcriptHash) };
}

// Scrap = revoke every installation except the scrapper, THEN archive and
// flush from the scrapper. Order matters: the closing send only commits the
// eviction (rotates the epoch) when the sending client syncs each
// conversation for the first time AFTER the revocation, rebuilding
// membership from the latest identity state. A client that synced before the
// revoke keeps the old membership cached and its flush commits nothing
// (found the hard way; see docs/port-mechanics.md) — and the working
// installation has always synced by scrap time on a real job, because hire
// reads /channel. Hence the cold scrapper installation minted alongside the
// port. The working installation is revoked with the rest; the port dies
// entirely.
async function scrap(jobId) {
  const rec = registry[jobId];
  if (!rec) throw new Error("unknown job");
  if (rec.status === "scrapped") throw new Error("already scrapped");

  const account = privateKeyToAccount(readFileSync(`${DATA}keys/${jobId}.key`, "utf8").trim());
  // Ports minted before the scrapper existed fall back to the working
  // installation, keeping the old (pre-synced, weaker) flush behavior.
  const keeper = rec.scrapInstallation ?? rec.serviceInstallation;
  const state = await Client.inboxStateFromInboxIds([rec.inboxId], ENV);
  const foreign = state[0].installations
    .map((i) => i.id)
    .filter((id) => id !== keeper);
  if (foreign.length > 0) {
    await Client.revokeInstallations(
      walletSigner(account),
      rec.inboxId,
      foreign.map((id) => Buffer.from(id, "hex")),
      ENV,
    );
  }

  const scrapClient = rec.scrapInstallation
    ? await Client.create(walletSigner(account), {
        env: ENV,
        dbPath: `${DATA}db/${jobId}.scrap.db3`,
        codecs: [new RemoteAttachmentCodec(), new AttachmentCodec()],
      })
    : await portClient(jobId);
  if (rec.scrapInstallation && scrapClient.installationId !== rec.scrapInstallation)
    throw new Error(`scrap installation mismatch for job ${jobId}`);

  const archived = await archive(jobId, scrapClient);
  for (const c of await scrapClient.conversations.list()) {
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

// Live transcript entries for one peer's channel, same row shape the hire
// commitment hashes over. Used by hire() to compute the transcript hash at
// the commitment moment, and by the MCP fallback path to read the port.
async function channel(jobId, peerInboxId) {
  const rec = registry[jobId];
  if (!rec) throw new Error("unknown job");
  if (rec.status === "scrapped") throw new Error("port is scrapped");
  const client = await portClient(jobId);
  await client.conversations.syncAll();
  for (const c of await client.conversations.list()) {
    if (c.peerInboxId === peerInboxId) {
      await c.sync();
      return c;
    }
  }
  throw new Error(`no channel with ${peerInboxId}`);
}

// Accept one encrypted evidence payload for a live port. The blob is named
// by the sha256 of its bytes, so the URL we hand back is self-authenticating:
// RemoteAttachmentCodec.load re-hashes on download and the archive re-hashes
// at scrap, both against the same digest. Re-uploading the same bytes is a
// no-op. Anyone who knows a live jobId can upload (same bar as claiming);
// the size cap is the abuse guard that matters here.
async function acceptUpload(req, jobId) {
  const rec = registry[jobId];
  if (!rec) throw new Error("unknown job");
  if (rec.status === "scrapped") throw new Error("port is scrapped");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_ATTACHMENT_BYTES) throw new Error(`attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
    chunks.push(chunk);
  }
  if (size === 0) throw new Error("empty upload");
  const payload = Buffer.concat(chunks);
  const digest = createHash("sha256").update(payload).digest("hex");
  mkdirSync(`${DATA}attachments/${jobId}`, { recursive: true });
  writeFileSync(`${DATA}attachments/${jobId}/${digest}`, payload);
  return { contentDigest: digest, contentLength: size, url: `${ATTACH_BASE}/attachments/${jobId}/${digest}` };
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
  "GET /ports/:jobId/conversations": async (_body, { jobId }) => {
    const rec = registry[jobId];
    if (!rec) throw new Error("unknown job");
    if (rec.status === "scrapped") throw new Error("port is scrapped");
    const client = await portClient(jobId);
    await client.conversations.syncAll();
    const out = [];
    for (const c of await client.conversations.list()) {
      await c.sync();
      const messages = await c.messages();
      const visible = messages.filter(isVisible);
      out.push({
        peerInboxId: c.peerInboxId,
        messageCount: visible.length,
        attachmentCount: visible.filter((m) => typeof m.content !== "string").length,
        lastMessage: visible.at(-1) ? messageRow(visible.at(-1), rec.inboxId) : null,
      });
    }
    return { jobId, conversations: out };
  },
  "GET /ports/:jobId/channel": async (_body, { jobId }, req) => {
    const peer = new URL(req.url, "http://x").searchParams.get("peer");
    const c = await channel(jobId, peer);
    const rec = registry[jobId];
    const messages = await c.messages();
    return {
      jobId,
      peerInboxId: peer,
      transcriptHash: transcriptHash(
        messages.map((m) => ({
          id: m.id,
          sender: m.senderInboxId,
          sentAtNs: String(m.sentAtNs),
          contentSha256: contentSha256(m),
        })),
      ),
      messages: messages.filter(isVisible).map((m) => messageRow(m, rec.inboxId)),
    };
  },
  "POST /ports/:jobId/messages": async (body, { jobId }) => {
    const c = await channel(jobId, body.peerInboxId);
    await c.send(body.content);
    return { sent: true };
  },
  "GET /ports/:jobId": async (_body, { jobId }) => {
    const rec = registry[jobId];
    if (!rec) throw new Error("unknown job");
    const { grantToken, ...publicRec } = rec;
    return { jobId, ...publicRec };
  },
};

createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  // The browser app uploads evidence straight here and readers fetch payloads
  // back cross-origin. Blobs are ciphertext behind capability URLs, so a
  // permissive origin gives nothing away.
  res.setHeader("access-control-allow-origin", "*");
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-grant-token",
    });
    return res.end();
  }
  const reply = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  try {
    // Binary surfaces first: these must not go through the JSON body read.
    const serve = path.match(/^\/attachments\/([\w.-]+)\/([0-9a-f]{64})$/);
    if (serve && req.method === "GET") {
      const file = `${DATA}attachments/${serve[1]}/${serve[2]}`;
      if (!existsSync(file)) return reply(404, { error: "no such attachment" });
      const payload = readFileSync(file);
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": payload.length });
      return res.end(payload);
    }
    const upload = path.match(/^\/ports\/([\w.-]+)\/attachments$/);
    if (upload && req.method === "POST") return reply(200, await acceptUpload(req, upload[1]));

    const body = await new Promise((r) => {
      let d = "";
      req.on("data", (c) => (d += c));
      req.on("end", () => r(d ? JSON.parse(d) : {}));
    });
    const m = path.match(/^\/ports\/([\w.-]+)(\/[\w/]+)?$/);
    const key = m ? `${req.method} /ports/:jobId${m[2] ?? ""}` : `${req.method} ${path}`;
    const handler = routes[key];
    if (!handler) return reply(404, { error: `no route ${key}` });
    reply(200, await handler(body, { jobId: m?.[1] }, req));
  } catch (e) {
    console.error(`[port-service] ${req.method} ${req.url}:`, e.message);
    reply(400, { error: e.message });
  }
}).listen(PORT, () => console.log(`[port-service] listening on :${PORT} (env ${ENV})`));
