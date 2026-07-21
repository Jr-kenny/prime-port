import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSettlementDeliverable,
  extractCommitmentHash,
  matchSettlementTask,
  normalizeDecimal,
} from "./settlement-routing.mjs";

const HASH = `0x${"ab".repeat(32)}`;
const baseJob = {
  jobId: "job-1",
  status: "awaiting-escrow",
  agent: { agentId: "5941" },
  pendingHire: { hash: HASH, commitment: { terms: { price: "48.00", currency: "USDT" } } },
};
const baseTask = {
  jobId: "market-1",
  myAgentId: "6592",
  counterpartyAgentId: "5941",
  title: `Prime Port settlement ${HASH}`,
  description: "Private wage escrow for a signed Prime Port hire.",
  tokenAmount: "48",
  tokenSymbol: "USD₮0",
};

test("extracts a commitment hash from title or description", () => {
  assert.equal(extractCommitmentHash(baseTask), HASH);
  assert.equal(extractCommitmentHash({ description: `commitment ${HASH.toUpperCase()}` }), HASH);
  assert.equal(extractCommitmentHash({ title: "no hash" }), null);
});

test("compares decimal prices without floating point", () => {
  assert.equal(normalizeDecimal("00048.0000"), "48");
  assert.equal(normalizeDecimal("0.000100"), "0.0001");
  assert.equal(normalizeDecimal("48 USDT"), null);
});

test("routes only an exact private settlement task", () => {
  const match = matchSettlementTask(baseTask, [baseJob], "6592");
  assert.equal(match.ok, true);
  assert.equal(match.job.jobId, "job-1");
  assert.equal(match.amount, "48");
});

test("rejects unmatched, wrong-buyer, and wrong-price tasks", () => {
  assert.match(matchSettlementTask({ ...baseTask, title: "generic task" }, [baseJob], "6592").reason, /missing/);
  assert.match(matchSettlementTask({ ...baseTask, counterpartyAgentId: "9999" }, [baseJob], "6592").reason, /buyer/);
  assert.match(matchSettlementTask({ ...baseTask, tokenAmount: "47.99" }, [baseJob], "6592").reason, /amount/);
});

test("builds the official deliverable only from an accepted submission", () => {
  const submission = {
    submissionId: "submission-1",
    revision: 2,
    status: "accepted",
    note: "Final revised cut",
    transcriptHash: HASH,
    attachments: [{ filename: "cut.mp4", contentDigest: "deadbeef" }],
  };
  const job = {
    ...baseJob,
    settlement: { finalSubmissionId: submission.submissionId },
    submissions: [submission],
  };
  assert.match(buildSettlementDeliverable(job), /Final revised cut/);
  assert.equal(buildSettlementDeliverable({ ...job, submissions: [{ ...submission, status: "awaiting-review" }] }), null);
});
