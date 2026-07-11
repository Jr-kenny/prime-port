import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
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

function createLocalWallet() {
  const walletPrivateKey = generatePrivateKey();
  const account = privateKeyToAccount(walletPrivateKey);
  return {
    wallet: account.address.toLowerCase(),
    walletPrivateKey,
  };
}

function normalizeIdentity(identity: DemoIdentity) {
  if (!identity.walletPrivateKey) {
    const { wallet, walletPrivateKey } = createLocalWallet();
    return {
      ...identity,
      wallet,
      walletPrivateKey,
      payoutAddress:
        identity.payoutAddress && identity.payoutAddress.toLowerCase() !== identity.wallet.toLowerCase()
          ? identity.payoutAddress.toLowerCase()
          : wallet,
    };
  }

  const account = privateKeyToAccount(identity.walletPrivateKey as Hex);
  const wallet = account.address.toLowerCase();
  return {
    ...identity,
    wallet,
    payoutAddress: identity.payoutAddress ? identity.payoutAddress.toLowerCase() : wallet,
  };
}

export function readIdentity() {
  const identity = readJson<DemoIdentity>(IDENTITY_KEY);
  if (!identity) return null;
  const normalized = normalizeIdentity(identity);
  if (JSON.stringify(identity) !== JSON.stringify(normalized)) {
    writeJson(IDENTITY_KEY, normalized);
  }
  return normalized;
}

export function saveIdentity(identity: DemoIdentity) {
  const normalized = normalizeIdentity(identity);
  writeJson(IDENTITY_KEY, normalized);
  return normalized;
}

export function getOrCreateIdentity(input: Pick<DemoIdentity, "name" | "email"> & { payoutAddress?: string }) {
  const existing = readIdentity();
  const walletBundle = existing ? { wallet: existing.wallet, walletPrivateKey: existing.walletPrivateKey } : createLocalWallet();
  const identity: DemoIdentity = {
    inboxId: existing?.inboxId ?? `demo-${randomHex(20)}`,
    wallet: walletBundle.wallet,
    walletPrivateKey: walletBundle.walletPrivateKey,
    payoutAddress: input.payoutAddress?.trim().toLowerCase() || existing?.payoutAddress || walletBundle.wallet,
    name: input.name.trim(),
    email: input.email.trim().toLowerCase(),
    createdAt: existing?.createdAt ?? Date.now(),
  };
  writeJson(IDENTITY_KEY, identity);
  return identity;
}

export async function signIdentityMessage(identity: DemoIdentity, message: string) {
  const account = privateKeyToAccount(identity.walletPrivateKey as Hex);
  return account.signMessage({ message });
}

export function clearIdentity() {
  window.localStorage.removeItem(IDENTITY_KEY);
}
