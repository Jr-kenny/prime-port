import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData } from "viem";
import {
  authorizationMessage,
  buildEscrowAuthorization,
  buildFundingRequest,
  escrowAbi,
  escrowConfig,
} from "./escrow.mjs";

const config = escrowConfig({
  ESCROW_ADDRESS: "0x1111111111111111111111111111111111111111",
  USDT_ADDRESS: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
  ESCROW_CHAIN_ID: "196",
});
const pendingHire = {
  hash: `0x${"ab".repeat(32)}`,
  commitment: {
    agent: { wallet: "0x2222222222222222222222222222222222222222" },
    freelancer: {
      wallet: "0x3333333333333333333333333333333333333333",
      payoutAddress: "0x4444444444444444444444444444444444444444",
    },
    terms: { price: "12.5", currency: "USDT", deadline: 1_800_000_000 },
  },
};

test("authorization binds commitment, parties, amount, chain and escrow", () => {
  const authorization = buildEscrowAuthorization(pendingHire, config);
  assert.equal(authorization.amountUnits, "12500000");
  assert.equal(authorization.signThisExactly, authorizationMessage(authorization.authorizationHash));
  assert.match(authorization.authorizationHash, /^0x[0-9a-f]{64}$/);
});

test("funding request contains exact approve and fund calldata", () => {
  const escrow = buildEscrowAuthorization(pendingHire, config);
  const request = buildFundingRequest({
    ...pendingHire,
    escrow,
    agentSignature: `0x${"11".repeat(65)}`,
    freelancerSignature: `0x${"22".repeat(65)}`,
  }, config);
  const decoded = decodeFunctionData({ abi: escrowAbi, data: request.funding.data });
  assert.equal(decoded.functionName, "fund");
  assert.equal(decoded.args[0], pendingHire.hash);
  assert.equal(decoded.args[4], 12_500_000n);
  assert.equal(request.approval.to, config.token);
});
