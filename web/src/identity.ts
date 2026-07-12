// Real identity for #17. Privy's email/Google sign-in creates (or restores)
// the embedded wallet, that wallet personal_signs XMTP's registration so our
// inboxId is a real reachable inbox, and the same signing path countersigns
// the hire commitment. No key ever touches this code: signing happens inside
// Privy's wallet iframe, we only ever see signatures.
import { useEffect, useState } from "react";
import { useLogout, usePrivy, useWallets } from "@privy-io/react-auth";
import type { ConnectedWallet } from "@privy-io/react-auth";
import { Client } from "@xmtp/browser-sdk";
import { toBytes } from "viem";

export type Identity = {
  name: string;
  email: string;
  provider: "google" | "email";
  inboxId: string;
  wallet: string; // embedded wallet address, lowercase
  payoutAddress: string; // defaults to the embedded wallet, overridable in Settings
};

export type Session = {
  // loading: Privy still booting. connecting: signed in, wallet/XMTP being
  // set up. ready: identity usable for claims, chat and countersigning.
  status: "loading" | "signed-out" | "connecting" | "ready" | "error";
  error?: string;
  identity: Identity | null;
  xmtp: Client | null;
  signMessage: (message: string) => Promise<string>;
  setPayoutAddress: (address: string) => void;
  signOut: () => Promise<void>;
};

// Must match the port service (XMTP_ENV, default "dev").
const XMTP_ENV = (import.meta.env.VITE_XMTP_ENV ?? "dev") as "dev" | "production" | "local";

const payoutKey = (wallet: string) => `prime-port.payout.${wallet}`;

async function personalSign(wallet: ConnectedWallet, message: string): Promise<string> {
  const provider = await wallet.getEthereumProvider();
  return (await provider.request({
    method: "personal_sign",
    params: [message, wallet.address],
  })) as string;
}

// One XMTP client per wallet per page load: StrictMode double-mounts and
// re-renders must not race a second Client.create against the same local db.
const xmtpCache = new Map<string, Promise<Client>>();

function xmtpFor(wallet: ConnectedWallet): Promise<Client> {
  const address = wallet.address.toLowerCase();
  let cached = xmtpCache.get(address);
  if (!cached) {
    const signer = {
      type: "EOA" as const,
      getIdentifier: () => ({ identifier: address, identifierKind: "Ethereum" as const }),
      signMessage: async (message: string) => toBytes(await personalSign(wallet, message)),
    };
    cached = Client.create(signer, { env: XMTP_ENV });
    xmtpCache.set(address, cached);
    cached.catch(() => xmtpCache.delete(address));
  }
  return cached;
}

export function useIdentity(): Session {
  const { ready, authenticated, user } = usePrivy();
  const { logout } = useLogout();
  const { wallets } = useWallets();
  const [xmtp, setXmtp] = useState<Client | null>(null);
  const [error, setError] = useState<string>();
  const [payoutOverride, setPayoutOverride] = useState<string | null>(null);

  const embedded = wallets.find((w) => w.walletClientType === "privy");
  const walletAddr = embedded?.address.toLowerCase();

  useEffect(() => {
    if (!ready || !authenticated || !embedded) return;
    let stale = false;
    setPayoutOverride(window.localStorage.getItem(payoutKey(walletAddr!)));
    xmtpFor(embedded).then(
      (client) => !stale && setXmtp(client),
      (e) => !stale && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      stale = true;
    };
  }, [ready, authenticated, walletAddr]);

  const email = user?.email?.address ?? user?.google?.email ?? "";
  const identity: Identity | null =
    authenticated && embedded && xmtp?.inboxId
      ? {
          name: user?.google?.name ?? (email ? email.split("@")[0] : "Freelancer"),
          email,
          provider: user?.google ? "google" : "email",
          inboxId: xmtp.inboxId,
          wallet: walletAddr!,
          payoutAddress: payoutOverride ?? walletAddr!,
        }
      : null;

  return {
    status: !ready ? "loading" : !authenticated ? "signed-out" : error ? "error" : identity ? "ready" : "connecting",
    error,
    identity,
    xmtp,
    signMessage: (message) => {
      if (!embedded) throw new Error("no embedded wallet, sign in first");
      return personalSign(embedded, message);
    },
    setPayoutAddress: (address) => {
      if (!walletAddr) return;
      window.localStorage.setItem(payoutKey(walletAddr), address.toLowerCase());
      setPayoutOverride(address.toLowerCase());
    },
    signOut: async () => {
      await logout();
      setXmtp(null);
      setError(undefined);
    },
  };
}

export const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
