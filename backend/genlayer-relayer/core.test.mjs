import assert from "node:assert/strict";
import test from "node:test";
import { disputedJobs, needsGenLayerSubmission, normalizeGenLayerVerdict } from "./core.mjs";

test("normalizes finalized GenLayer verdict maps", () => {
  const verdict = normalizeGenLayerVerdict(new Map([
    ["resolution_id", `0x${"11".repeat(32)}`],
    ["verdict_hash", `0x${"22".repeat(32)}`],
    ["evidence_hash", `0x${"33".repeat(32)}`],
    ["provider_bps", 7500n],
  ]));
  assert.equal(verdict.providerBps, 7500);
});

test("selects only unresolved on-chain disputes", () => {
  const selected = disputedJobs([
    { status: "hired" },
    { status: "disputed", pendingHire: { hash: "0x1" }, settlement: { evidenceHash: "0x2" } },
    { status: "disputed", pendingHire: { hash: "0x3" }, settlement: { evidenceHash: "0x4", resolutionTransactionHash: "0x5" } },
  ]);
  assert.equal(selected.length, 1);
});

test("does not resubmit a GenLayer case after its transaction is recorded", () => {
  assert.equal(needsGenLayerSubmission({ settlement: {} }), true);
  assert.equal(needsGenLayerSubmission({ settlement: { genlayerSubmissionHash: `0x${"44".repeat(32)}` } }), false);
});
