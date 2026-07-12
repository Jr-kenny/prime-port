// Local identity with a real keypair: the wallet can genuinely personal_sign
// (countersign works against the backend's verifyMessage), but the inboxId is
// still a placeholder until the embedded wallet + real XMTP identity land
// (#17). The UI labels this state honestly wherever it shows.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

export type Identity = {
  name: string;
  email: string;
  inboxId: string;
  wallet: string;
  walletPrivateKey: Hex;
  payoutAddress: string;
  createdAt: number;
};

const KEY = "prime-port.identity.v2";

export function readIdentity(): Identity | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Identity) : null;
  } catch {
    return null;
  }
}

export function createIdentity(input: { name: string; email: string }): Identity {
  const existing = readIdentity();
  const walletPrivateKey = existing?.walletPrivateKey ?? generatePrivateKey();
  const account = privateKeyToAccount(walletPrivateKey);
  const inboxId = existing?.inboxId ?? `preview-${walletPrivateKey.slice(2, 42)}`;
  const identity: Identity = {
    name: input.name.trim(),
    email: input.email.trim().toLowerCase(),
    inboxId,
    wallet: account.address,
    walletPrivateKey,
    payoutAddress: existing?.payoutAddress ?? account.address,
    createdAt: existing?.createdAt ?? Date.now(),
  };
  window.localStorage.setItem(KEY, JSON.stringify(identity));
  return identity;
}

export function savePayoutAddress(address: string) {
  const identity = readIdentity();
  if (!identity) return null;
  const next = { ...identity, payoutAddress: address };
  window.localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export async function signMessage(identity: Identity, message: string) {
  return privateKeyToAccount(identity.walletPrivateKey).signMessage({ message });
}

export function clearIdentity() {
  window.localStorage.removeItem(KEY);
}

export const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
