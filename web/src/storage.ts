// Claims and chat drafts, local to this device. Honesty rule from the #12
// review: nothing is ever fabricated. No fake message "from the port", no
// auto-sent intro; a thread only contains what the user actually typed, and
// the chat screen labels local-only delivery until #17/#18 land transport.
export type ClaimRecord = { jobId: string; portInboxId: string; claimedAt: number };
export type ChatMessage = { id: string; jobId: string; from: "me"; text: string; at: number };

const CLAIMS = "prime-port.claims.v2";
const chatKey = (jobId: string) => `prime-port.chat.${jobId}.v2`;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export const readClaims = () => read<ClaimRecord[]>(CLAIMS, []);

export function saveClaim(claim: ClaimRecord) {
  const next = [claim, ...readClaims().filter((c) => c.jobId !== claim.jobId)];
  window.localStorage.setItem(CLAIMS, JSON.stringify(next));
  return next;
}

export const readMessages = (jobId: string) => read<ChatMessage[]>(chatKey(jobId), []);

export function appendMessage(message: ChatMessage) {
  const next = [...readMessages(message.jobId), message];
  window.localStorage.setItem(chatKey(message.jobId), JSON.stringify(next));
  return next;
}
