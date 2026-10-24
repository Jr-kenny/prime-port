import assert from "node:assert/strict";
import test from "node:test";
import {
  memoInTransactionData,
  nativePaymentConfig,
  nativePaymentRequirements,
  publicationMemoGuard,
  validateNativePayment,
} from "./native-payment.mjs";

const MEMO = `0x${"cd".repeat(32)}`;
const PAY_TO = "0x7ab4daee18a449eb76a8a7d66cb02cf34a28563e";

const config = () => nativePaymentConfig({
  PAY_TO_ADDRESS: PAY_TO,
  PUBLISH_PRICE_ETH: "0.001",
  PUBLISH_CHAIN_ID: "46630",
  PUBLISH_RPC_URL: "http://127.0.0.1:1",
  PUBLISH_CONFIRMATIONS: "1",
});

const tx = (overrides = {}) => ({
  to: PAY_TO,
  from: "0x00000000000000000000000000000000000000aa",
  value: 1_000_000_000_000_000n,
  input: `0x${MEMO.slice(2)}`,
  ...overrides,
});
const receipt = (overrides = {}) => ({ status: "success", blockNumber: 100n, ...overrides });

test("native config prices the publish fee in ETH and keeps the chain id", () => {
  const c = config();
  assert.equal(c.amountWei, 1_000_000_000_000_000n);
  assert.equal(c.priceEth, "0.001");
  assert.equal(c.chainId, 46630);
  const requirements = nativePaymentRequirements(c);
  assert.equal(requirements.currency, "ETH");
  assert.equal(requirements.amountWei, "1000000000000000");
  assert.equal(requirements.payTo, PAY_TO);
});

test("native config refuses a missing treasury address and an invalid price", () => {
  assert.throws(() => nativePaymentConfig({}), /PAY_TO_ADDRESS/);
  assert.throws(
    () => nativePaymentConfig({ PAY_TO_ADDRESS: PAY_TO, PUBLISH_PRICE_ETH: "0" }),
    /greater than zero/,
  );
  // A fee that cannot be verified is worse than a boot failure: there is no
  // default node to fall back to.
  assert.throws(
    () => nativePaymentConfig({ PAY_TO_ADDRESS: PAY_TO, PUBLISH_PRICE_ETH: "0.001" }),
    /PUBLISH_RPC_URL/,
  );
});

test("the memo must appear in the transaction data", () => {
  assert.equal(memoInTransactionData(`0x${MEMO.slice(2)}`, MEMO), true);
  assert.equal(memoInTransactionData(`0xdeadbeef${MEMO.slice(2)}cafe`, MEMO), true);
  assert.equal(memoInTransactionData("0xdeadbeef", MEMO), false);
  assert.equal(memoInTransactionData(`0x${MEMO.slice(2)}`, "not-a-memo"), false);
});

test("a correct payment validates and returns the payer", () => {
  const result = validateNativePayment({
    tx: tx(),
    receipt: receipt(),
    requirement: { ...nativePaymentRequirements(config()), memo: MEMO },
    latestBlockNumber: 101n,
  });
  assert.equal(result.payer, "0x00000000000000000000000000000000000000aa");
  assert.equal(result.valueWei, "1000000000000000");
});

test("underpayment, wrong recipient, missing memo and reverted transfers are rejected", () => {
  const requirement = { ...nativePaymentRequirements(config()), memo: MEMO };
  const cases = [
    [{ tx: tx({ value: 999_999_999_999_999n }), receipt: receipt() }, /short/],
    [{ tx: tx({ to: "0x00000000000000000000000000000000000000bb" }), receipt: receipt() }, /treasury/],
    [{ tx: tx({ input: "0x" }), receipt: receipt() }, /memo/],
    [{ tx: tx(), receipt: receipt({ status: "reverted" }) }, /reverted/],
    [{ tx: null, receipt: receipt() }, /not found/],
    [{ tx: tx(), receipt: null }, /not mined/],
  ];
  for (const [input, expected] of cases) {
    assert.throws(
      () => validateNativePayment({ ...input, requirement, latestBlockNumber: 101n }),
      expected,
    );
  }
});

test("an unmatured payment is held until the required confirmations", () => {
  const requirement = { ...nativePaymentRequirements(config()), memo: MEMO };
  assert.throws(
    () => validateNativePayment({ tx: tx(), receipt: receipt({ blockNumber: 101n }), requirement, latestBlockNumber: 101n }),
    /confirmation/,
  );
});

test("a memo can only be spent once", () => {
  const jobs = { "job-1": { jobId: "job-1", publishTask: { paymentMemo: MEMO } } };
  assert.throws(() => publicationMemoGuard(jobs, MEMO), /already been used/);
  assert.doesNotThrow(() => publicationMemoGuard(jobs, `0x${"ee".repeat(32)}`));
});
