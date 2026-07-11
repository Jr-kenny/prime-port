import type { DemoIdentity } from "./types";

const IDENTITY_KEY = "prime-port.demo-identity.v1";

function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson<T>(key: string, value: T) {
  window.localStorage.setItem(key, JSON.stringify(value));
}

function randomHex(bytes: number) {
  const value = new Uint8Array(bytes);
  window.crypto.getRandomValues(value);
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function readIdentity() {
  return readJson<DemoIdentity>(IDENTITY_KEY);
}

export function getOrCreateIdentity(input: Pick<DemoIdentity, "name" | "email"> & { payoutAddress?: string }) {
  const existing = readIdentity();
  const wallet = existing?.wallet ?? `0x${randomHex(20)}`;
  const identity: DemoIdentity = {
    inboxId: existing?.inboxId ?? `demo-${randomHex(20)}`,
    wallet,
    payoutAddress: input.payoutAddress?.trim() || existing?.payoutAddress || wallet,
    name: input.name.trim(),
    email: input.email.trim().toLowerCase(),
    createdAt: existing?.createdAt ?? Date.now(),
  };
  writeJson(IDENTITY_KEY, identity);
  return identity;
}
