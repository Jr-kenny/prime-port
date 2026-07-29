import { decodePaymentSignatureHeader } from "@okxweb3/x402-core/http";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function paymentSignatureHeader(req) {
  return req.get("payment-signature") ?? req.get("x-payment") ?? null;
}

export function paymentPayloadKey(paymentPayload) {
  const nonce = paymentPayload?.payload?.authorization?.nonce;
  const signature = paymentPayload?.payload?.signature;
  const key = nonce ?? signature;
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("x402 payment payload has no replay-safe identifier");
  }
  return key.toLowerCase();
}

export function paymentPayerFromHeader(header) {
  if (typeof header !== "string" || header.length === 0) {
    throw new Error("x402 payment signature required");
  }
  const paymentPayload = decodePaymentSignatureHeader(header);
  const payer = paymentPayload?.payload?.authorization?.from;
  if (typeof payer !== "string" || !EVM_ADDRESS.test(payer)) {
    throw new Error("x402 payment payload has no valid EVM payer");
  }
  return { payer: payer.toLowerCase(), paymentPayload };
}
