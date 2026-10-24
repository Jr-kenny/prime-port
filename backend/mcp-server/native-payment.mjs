// Native-ETH publication payment, verified against the settlement chain.
//
// The publish fee is paid in the chain's native gas token (ETH on Robinhood
// Chain). The payer sends the exact amount to the treasury address and puts a
// 32-byte memo in the transaction data. The memo is what binds a payment to a
// publication: it is single-use, and the job fields are hashed alongside it on
// first use. Verification needs only an RPC.
import { createPublicClient, http, isAddress, parseUnits } from "viem";

export const NATIVE_PAYMENT_MODE = "native-eth";
export const MEMO_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export function nativePaymentConfig(env = process.env) {
  // No neutral default: an unset treasury or RPC is a boot failure, never an
  // unpaid publication.
  const payTo = String(env.PAY_TO_ADDRESS ?? "").trim();
  const priceEth = String(env.PUBLISH_PRICE_ETH ?? "0.001").trim();
  const chainId = Number(env.PUBLISH_CHAIN_ID ?? env.ESCROW_CHAIN_ID ?? 46630);
  const rpcUrl = String(env.PUBLISH_RPC_URL ?? env.ESCROW_RPC_URL ?? "").trim();
  const confirmations = Number(env.PUBLISH_CONFIRMATIONS ?? 1);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("PUBLISH_CHAIN_ID is invalid");
  if (!Number.isSafeInteger(confirmations) || confirmations < 0) throw new Error("PUBLISH_CONFIRMATIONS is invalid");
  if (!isAddress(payTo)) throw new Error("PAY_TO_ADDRESS must be a valid address for native publish payments");
  if (!/^\d+(\.\d{1,18})?$/.test(priceEth)) throw new Error("PUBLISH_PRICE_ETH is not a decimal ETH amount");
  const amountWei = parseUnits(priceEth, 18);
  if (amountWei <= 0n) throw new Error("PUBLISH_PRICE_ETH must be greater than zero");
  if (!rpcUrl) throw new Error("PUBLISH_RPC_URL must be set for native publish payments");
  return { payTo: payTo.toLowerCase(), priceEth, amountWei, chainId, rpcUrl, confirmations };
}

export function nativePaymentRequirements(config) {
  return {
    mode: NATIVE_PAYMENT_MODE,
    currency: "ETH",
    chainId: config.chainId,
    payTo: config.payTo,
    amount: config.priceEth,
    amountWei: config.amountWei.toString(),
    memo: "0x-prefixed 32-byte hex you choose; put it in the transaction data",
    memoPattern: "0x[0-9a-fA-F]{64}",
    confirmations: config.confirmations,
    note: "Send the exact amount to payTo with the memo in the transaction data, then POST the same job fields with the payment-tx and payment-memo headers.",
  };
}

// The payer's memo must appear in the transaction input. Calldata is opaque
// to us by design: the memo can be the whole input or embedded in it, so a
// wallet that also writes a note still settles.
export function memoInTransactionData(data, memo) {
  if (!MEMO_PATTERN.test(String(memo ?? ""))) return false;
  const needle = String(memo).slice(2).toLowerCase();
  return String(data ?? "").toLowerCase().includes(needle);
}

export function validateNativePayment({ tx, receipt, requirement, latestBlockNumber }) {
  if (!tx) throw new Error("payment transaction not found on the configured RPC");
  if (!receipt) throw new Error("payment transaction is not mined yet; wait for a receipt");
  if (String(receipt.status).toLowerCase() !== "success") throw new Error("payment transaction reverted");
  if (String(tx.to ?? "").toLowerCase() !== requirement.payTo) {
    throw new Error(`payment was not sent to the treasury address ${requirement.payTo}`);
  }
  let value = 0n;
  try {
    value = BigInt(tx.value ?? 0);
  } catch {
    throw new Error("payment transaction value is not readable");
  }
  if (value < requirement.amountWei) {
    throw new Error(`payment is short: expected ${requirement.amountWei.toString()} wei, received ${value.toString()} wei`);
  }
  if (!memoInTransactionData(tx.input, requirement.memo)) {
    throw new Error("payment transaction data does not contain the publication memo");
  }
  const minedAt = BigInt(receipt.blockNumber ?? 0);
  const head = BigInt(latestBlockNumber ?? 0);
  const depth = head >= minedAt ? head - minedAt : 0n;
  if (depth < BigInt(requirement.confirmations)) {
    throw new Error(`payment needs ${requirement.confirmations} confirmation(s); it has ${depth.toString()}`);
  }
  return {
    payer: String(tx.from ?? "").toLowerCase(),
    valueWei: value.toString(),
    blockNumber: minedAt.toString(),
  };
}

export async function verifyNativePayment({ txHash, memo, config, client }) {
  const requirement = { ...nativePaymentRequirements(config), memo };
  const rpc = client ?? createPublicClient({ transport: http(config.rpcUrl) });
  const [tx, receipt, latestBlockNumber] = await Promise.all([
    rpc.getTransaction({ hash: txHash }),
    rpc.getTransactionReceipt({ hash: txHash }),
    rpc.getBlockNumber(),
  ]);
  return { ...validateNativePayment({ tx, receipt, requirement, latestBlockNumber }), txHash, memo };
}

export function publicationMemoGuard(jobs, memo) {
  for (const job of Object.values(jobs ?? {})) {
    if (job?.publishTask?.paymentMemo === memo) {
      throw new Error("this publication memo has already been used");
    }
  }
}
