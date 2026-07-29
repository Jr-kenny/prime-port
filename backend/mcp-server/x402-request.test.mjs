import assert from "node:assert/strict";
import test from "node:test";
import { encodePaymentSignatureHeader } from "@okxweb3/x402-core/http";
import {
  paymentPayloadKey,
  paymentPayerFromHeader,
  paymentSignatureHeader,
} from "./x402-request.mjs";

const payer = "0x1111111111111111111111111111111111111111";
const payload = {
  x402Version: 2,
  payload: {
    authorization: {
      from: payer,
      to: "0x2222222222222222222222222222222222222222",
      value: "1000000",
      validAfter: "0",
      validBefore: "9999999999",
      nonce: `0x${"33".repeat(32)}`,
    },
    signature: `0x${"44".repeat(65)}`,
  },
};

test("extracts and normalizes the verified EIP-3009 payer", () => {
  const header = encodePaymentSignatureHeader(payload);
  const decoded = paymentPayerFromHeader(header);
  assert.equal(decoded.payer, payer);
  assert.equal(paymentPayloadKey(decoded.paymentPayload), payload.payload.authorization.nonce);
});

test("accepts the legacy x-payment header", () => {
  const request = {
    get(name) {
      return name === "x-payment" ? "legacy-header" : undefined;
    },
  };
  assert.equal(paymentSignatureHeader(request), "legacy-header");
});

test("rejects a payment payload without an EVM payer", () => {
  const header = encodePaymentSignatureHeader({
    x402Version: 2,
    payload: { signature: `0x${"44".repeat(65)}` },
  });
  assert.throws(() => paymentPayerFromHeader(header), /valid EVM payer/);
});
