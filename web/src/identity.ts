// Real identity for #17. Privy's email/Google sign-in creates (or restores)
// the embedded wallet, that wallet personal_signs XMTP's registration so our
// inboxId is a real reachable inbox, and the same signing path countersigns
// the hire commitment. No key ever touches this code: signing happens inside
// Privy's wallet iframe, we only ever see signatures.
import { useEffect, useRef, useState } from "react";
import { useCreateWallet, useLogout, usePrivy, useWallets } from "@privy-io/react-auth";
import type { ConnectedWallet } from "@privy-io/react-auth";
import { Client } from "@xmtp/browser-sdk";
import type { GroupUpdated } from "@xmtp/content-type-group-updated";
import type { Attachment, RemoteAttachment } from "@xmtp/content-type-remote-attachment";
import { toBytes } from "viem";
import { attachmentCodecs } from "./attachments";
import type { WalletTransaction } from "./api";

// The client's content types once the evidence codecs are registered.
export type XmtpClient = Client<string | GroupUpdated | RemoteAttachment | Attachment>;

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
  // While connecting: which arrow of the chain we're waiting on.
  stage?: "wallet" | "inbox";
  error?: string;
  identity: Identity | null;
  xmtp: XmtpClient | null;
  signMessage: (message: string) => Promise<string>;
  sendTransaction: (transaction: WalletTransaction) => Promise<string>;
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

async function sendWalletTransaction(wallet: ConnectedWallet, transaction: WalletTransaction): Promise<string> {
  const provider = await wallet.getEthereumProvider();
  const chainId = `0x${transaction.chainId.toString(16)}`;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code !== 4902 || transaction.chainId !== 196) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId,
        chainName: "X Layer",
        nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
        rpcUrls: ["https://rpc.xlayer.tech"],
        blockExplorerUrls: ["https://www.oklink.com/xlayer"],
      }],
    });
  }
  return (await provider.request({
    method: "eth_sendTransaction",
    params: [{
      from: wallet.address,
      to: transaction.to,
      data: transaction.data,
      value: `0x${BigInt(transaction.value || "0").toString(16)}`,
    }],
  })) as string;
}

// One XMTP client per wallet per page load: StrictMode double-mounts and
// re-renders must not race a second Client.create against the same local db.
const xmtpCache = new Map<string, Promise<XmtpClient>>();

function xmtpFor(wallet: ConnectedWallet): Promise<XmtpClient> {
  const address = wallet.address.toLowerCase();
  let cached = xmtpCache.get(address);
  if (!cached) {
    const signer = {
      type: "EOA" as const,
      getIdentifier: () => ({ identifier: address, identifierKind: "Ethereum" as const }),
      signMessage: async (message: string) => toBytes(await personalSign(wallet, message)),
    };
    const started = Date.now();
    // Codecs make evidence attachments decode into their envelope instead of
    // the "can't display" fallback text (see attachments.ts).
    cached = Client.create(signer, { env: XMTP_ENV, codecs: attachmentCodecs });
    xmtpCache.set(address, cached);
    cached.then(
      (c) => console.info(`[identity] xmtp inbox ${c.inboxId} ready in ${Date.now() - started}ms`),
      () => xmtpCache.delete(address),
    );
  }
  return cached;
}

export function useIdentity(): Session {
  const { ready, authenticated, user } = usePrivy();
  const { logout } = useLogout();
  const { wallets, ready: walletsReady } = useWallets();
  const { createWallet } = useCreateWallet();
  const creatingWallet = useRef(false);
  const [xmtp, setXmtp] = useState<XmtpClient | null>(null);
  const [error, setError] = useState<string>();
  const [payoutOverride, setPayoutOverride] = useState<string | null>(null);

  const embedded = wallets.find((w) => w.walletClientType === "privy");
  const walletAddr = embedded?.address.toLowerCase();

  // createOnLogin only fires during an actual login event. A user whose Privy
  // account already exists but never finished wallet creation (interrupted
  // first visit, session restored from another tab) would otherwise wait here
  // forever, so if the wallet list settles without an embedded wallet, ask
  // for one explicitly.
  useEffect(() => {
    if (!ready || !authenticated || !walletsReady || embedded || creatingWallet.current) return;
    creatingWallet.current = true;
    console.info("[identity] no embedded wallet after login, creating one");
    createWallet().catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      // "already has an embedded wallet" means it's about to surface via useWallets
      if (!/already has/i.test(msg)) setError(msg);
    });
  }, [ready, authenticated, walletsReady, walletAddr]);

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
    stage: !embedded ? "wallet" : "inbox",
    error,
    identity,
    xmtp,
    signMessage: (message) => {
      if (!embedded) throw new Error("no embedded wallet, sign in first");
      return personalSign(embedded, message);
    },
    sendTransaction: (transaction) => {
      if (!embedded) throw new Error("no embedded wallet, sign in first");
      return sendWalletTransaction(embedded, transaction);
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
