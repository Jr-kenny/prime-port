// End-to-end against the live XMTP dev network, through the service API only:
// mint a port, grant an agent installation via token-authed remote signing,
// negotiate with a freelancer (stand-in key for the production embedded
// wallet), scrap, then verify the agent is locked out and the archive's
// transcript hash reproduces from its own entries.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client, IdentifierKind } from "@xmtp/node-sdk";
import {
  AttachmentCodec,
  ContentTypeRemoteAttachment,
  RemoteAttachmentCodec,
} from "@xmtp/content-type-remote-attachment";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { toBytes } from "viem";
import { transcriptHash } from "../commitment/commitment.mjs";

// The stock codec refuses to encode non-https URLs; local rails serve the
// attachment store over plain http. Same wire format, relaxed scheme check.
class DevRemoteAttachmentCodec extends RemoteAttachmentCodec {
  encode(content) {
    return {
      type: ContentTypeRemoteAttachment,
      parameters: {
        contentDigest: content.contentDigest,
        salt: Buffer.from(content.salt).toString("hex"),
        nonce: Buffer.from(content.nonce).toString("hex"),
        secret: Buffer.from(content.secret).toString("hex"),
        scheme: content.scheme,
        contentLength: String(content.contentLength),
        filename: content.filename,
      },
      content: new TextEncoder().encode(content.url),
    };
  }
}
const codecs = [new DevRemoteAttachmentCodec(), new AttachmentCodec()];

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
const agent = await Client.create(agentSigner, { env: "dev", dbPath: `./data/e2e-agent-${jobId}.db3`, codecs });
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
  { env: "dev", dbPath: `./data/e2e-fl-${jobId}.db3`, codecs },
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

// evidence: freelancer encrypts a deliverable locally, uploads the ciphertext
// to the port's attachment store, and sends the remote-attachment envelope
// through the same DM the negotiation rode.
const deliverable = { filename: "final-cut-15s.mp4", mimeType: "video/mp4", data: new TextEncoder().encode("pretend this is 15 seconds of vertical video") };
const encrypted = await RemoteAttachmentCodec.encodeEncrypted(deliverable, new AttachmentCodec());
const uploadRes = await fetch(`${SVC}/ports/${jobId}/attachments`, { method: "POST", body: encrypted.payload });
const uploaded = await uploadRes.json();
ok("upload stores ciphertext under its own digest", uploadRes.ok && uploaded.contentDigest === encrypted.digest && uploaded.url.endsWith(encrypted.digest));
const remoteAttachment = {
  url: uploaded.url,
  contentDigest: encrypted.digest,
  salt: encrypted.salt,
  nonce: encrypted.nonce,
  secret: encrypted.secret,
  scheme: "https://",
  contentLength: encrypted.payload.length,
  filename: deliverable.filename,
};
await dm.send(remoteAttachment, ContentTypeRemoteAttachment);

// the agent, running as the port via the grant, decrypts the evidence
await agent.conversations.syncAll();
await agentSide.sync();
const evidenceMsg = (await agentSide.messages()).find((m) => m.contentType?.typeId === "remoteStaticAttachment");
ok("agent receives the remote-attachment envelope", !!evidenceMsg && evidenceMsg.content.contentDigest === encrypted.digest);
const loaded = await RemoteAttachmentCodec.load(evidenceMsg.content, { codecFor: () => new AttachmentCodec() });
ok(
  "agent decrypts the deliverable and it matches what was sent",
  loaded.filename === deliverable.filename && Buffer.from(loaded.data).equals(Buffer.from(deliverable.data)),
);

// the channel surface shows the attachment row (this is what get_offers sees)
const ch = await api("GET", `/ports/${jobId}/channel?peer=${fl.inboxId}`);
const attRow = ch.messages.find((m) => m.kind === "attachment");
ok(
  "channel surfaces the attachment with filename and digest",
  !!attRow && attRow.filename === deliverable.filename && attRow.contentDigest === encrypted.digest && !attRow.fromPort,
);

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

// evidence in the archive: the payload rode along, its bytes re-hash to the
// digest the transcript committed to, and the envelope re-hashes to its entry
const attRow2 = convo.plaintext.find((p) => p.attachment);
ok("archive carries the attachment envelope", !!attRow2 && attRow2.attachment.contentDigest === encrypted.digest);
const payloadPath = new URL(`./data/archive/${attRow2.attachment.payload}`, import.meta.url).pathname;
const payloadBytes = readFileSync(payloadPath);
ok(
  "archived payload re-hashes to the committed contentDigest",
  createHash("sha256").update(payloadBytes).digest("hex") === encrypted.digest,
);
const attEntry = convo.entries.find((e) => e.id === attRow2.id);
const canonical = JSON.stringify({
  type: "remote-attachment",
  url: attRow2.attachment.url,
  contentDigest: attRow2.attachment.contentDigest,
  filename: attRow2.attachment.filename,
  contentLength: attRow2.attachment.contentLength,
  secret: attRow2.attachment.secret,
  salt: attRow2.attachment.salt,
  nonce: attRow2.attachment.nonce,
});
ok(
  "attachment envelope re-hashes to its committed entry hash",
  attEntry.contentSha256 === "0x" + createHash("sha256").update(canonical).digest("hex"),
);

// a scrapped port takes no more evidence
const lateUpload = await fetch(`${SVC}/ports/${jobId}/attachments`, { method: "POST", body: encrypted.payload });
ok("upload to a scrapped port is refused", lateUpload.status === 400);

console.log(process.exitCode ? "E2E FAILED" : "E2E PASSED");
process.exit(process.exitCode ?? 0);
