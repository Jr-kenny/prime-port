import type { ChatMessage, ClaimRecord, PublicJob } from "./types";

const CLAIMS_KEY = "prime-port.claims.v1";
const chatKey = (jobId: string) => `prime-port.chat.${jobId}.v1`;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T) {
  window.localStorage.setItem(key, JSON.stringify(value));
}

export function readClaims() {
  return readJson<ClaimRecord[]>(CLAIMS_KEY, []);
}

export function saveClaim(claim: ClaimRecord) {
  const claims = readClaims();
  const next = [claim, ...claims.filter((item) => item.jobId !== claim.jobId)];
  writeJson(CLAIMS_KEY, next);
  return next;
}

export function readMessages(jobId: string) {
  return readJson<ChatMessage[]>(chatKey(jobId), []);
}

export function appendMessage(message: ChatMessage) {
  const next = [...readMessages(message.jobId), message];
  writeJson(chatKey(message.jobId), next);
  return next;
}

export function seedConversation(job: PublicJob, claim: ClaimRecord) {
  if (readMessages(job.jobId).length > 0) return;
  appendMessage({
    id: window.crypto.randomUUID(),
    jobId: job.jobId,
    sender: "port",
    content: `Your private port for "${job.title}" is open.`,
    createdAt: Date.now(),
  });
  appendMessage({
    id: window.crypto.randomUUID(),
    jobId: job.jobId,
    sender: "freelancer",
    content: `Hi, I'm ${claim.name}. I claimed this job and I'm ready to discuss the scope.`,
    createdAt: Date.now() + 1,
  });
}
