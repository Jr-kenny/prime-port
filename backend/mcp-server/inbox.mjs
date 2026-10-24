// The job inbox: the one place a buyer agent reads and writes conversation.
//
// It is deliberately a log, not a relay. The server never composes, rewrites,
// prefixes, or reorders a message; it records what each side sent, assigns a
// monotonic sequence number, and serves the slice after a caller's cursor.
// Candidate aliases (C1, C2) are addressing labels owned by this module, so a
// rejected candidate's wallet is never handed to the buyer.
//
// The same log is the dispute record. That is the reason it exists: GenLayer
// can only adjudicate a job if there is one transcript both sides agree was
// not written after the fact.

import { findCandidate } from "./candidates.mjs";

const MAX_MESSAGES = 2_000;

export function ensureInbox(job) {
  if (!job.inbox) job.inbox = { nextSeq: 1, messages: [], seen: {}, lastSyncedAt: null };
  if (!Array.isArray(job.inbox.messages)) job.inbox.messages = [];
  if (!job.inbox.seen) job.inbox.seen = {};
  if (!Number.isFinite(job.inbox.nextSeq) || job.inbox.nextSeq < 1) job.inbox.nextSeq = 1;
  return job.inbox;
}

export function inboxHas(job, messageId) {
  return Boolean(messageId && job.inbox?.seen?.[messageId]);
}

export function appendInboxMessage(job, { candidateId, from, body, kind = "text", at, messageId, clientId = null, attachment = null }) {
  const inbox = ensureInbox(job);
  if (messageId && inbox.seen[messageId]) return null;
  const entry = {
    seq: inbox.nextSeq,
    candidateId: candidateId ?? null,
    from,
    kind,
    body: String(body ?? "").slice(0, 8_000),
    at: Number(at) || Date.now(),
  };
  if (attachment) entry.attachment = attachment;
  if (messageId) entry.messageId = messageId;
  if (clientId) entry.clientId = String(clientId).slice(0, 100);
  inbox.nextSeq += 1;
  inbox.messages.push(entry);
  if (messageId) inbox.seen[messageId] = entry.seq;
  if (inbox.messages.length > MAX_MESSAGES) {
    const dropped = inbox.messages.splice(0, inbox.messages.length - MAX_MESSAGES);
    for (const message of dropped) if (message.messageId) delete inbox.seen[message.messageId];
  }
  return entry;
}

export const inboxAfter = (job, after = 0) => {
  const messages = job.inbox?.messages ?? [];
  const cursor = Number(after) || 0;
  return messages.filter((message) => message.seq > cursor);
};

// A retried POST must not become two messages to a human. Callers that care
// send a clientId and get the original result back.
export const inboxByClientId = (job, clientId) => {
  if (!clientId) return null;
  return (job.inbox?.messages ?? []).find((message) => message.clientId === clientId) ?? null;
};

export const inboxCursor = (job) => Math.max(0, (job.inbox?.nextSeq ?? 1) - 1);

// Per-candidate summary for the buyer: who is in the room and what they last
// said. The wallet address is intentionally absent.
export function inboxThreads(job) {
  const claims = job.claims ?? [];
  return claims.map((claim) => {
    const messages = (job.inbox?.messages ?? []).filter((m) => m.candidateId === claim.candidateId);
    const last = messages.at(-1) ?? null;
    const hired = job.pendingHire?.commitment?.freelancer?.inboxId === claim.inboxId
      || job.hire?.freelancer?.inboxId === claim.inboxId;
    return {
      candidateId: claim.candidateId,
      status: claim.selectionStatus ?? "available",
      selected: Boolean(hired),
      claimedAt: claim.claimedAt ?? null,
      messageCount: messages.length,
      lastMessageAt: last?.at ?? null,
      lastMessage: last ? { from: last.from, body: last.body, at: last.at } : null,
    };
  });
}

// The paying wallet is the only buyer identity that can read or write here.
export function requireBuyer(job, wallet) {
  if (!wallet || String(job.agent?.wallet ?? "").toLowerCase() !== String(wallet).toLowerCase()) {
    throw new Error("job agent authorization required");
  }
}

// Pick the lane a write is addressed to. An explicit C1/C2 always wins; with
// exactly one candidate it is implied; otherwise the caller must choose, so a
// message can never land in the wrong lane by accident.
export function resolveThread(job, candidateId) {
  const claims = job.claims ?? [];
  if (candidateId) return findCandidate(job, candidateId);
  if (claims.length === 1) return claims[0];
  const hiredInboxId = job.pendingHire?.commitment?.freelancer?.inboxId;
  const hired = hiredInboxId ? claims.find((claim) => claim.inboxId === hiredInboxId) : null;
  if (hired) return hired;
  if (!claims.length) throw new Error("no candidate has claimed this job yet");
  const ids = claims.map((claim) => claim.candidateId).join(", ");
  throw new Error(`candidateId is required when a job has several candidates (${ids})`);
}
