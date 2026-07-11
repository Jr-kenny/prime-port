// Freezes the commitment format. If any of the pinned hashes change, you are
// changing the wire format everyone signed off on: update docs/hire-commitment.md
// in the same PR and get the team's eyes on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, commitmentHash, signingMessage, transcriptHash } from "./commitment.mjs";

const vectorMessages = [
  {
    id: "m1",
    sender: "44b305e579fc000000000000000000000000000000000000000000000000aaaa",
    sentAtNs: "1752278400000000001",
    contentSha256: "0x" + "11".repeat(32),
  },
  {
    id: "m2",
    sender: "4a8b60a536cb000000000000000000000000000000000000000000000000bbbb",
    sentAtNs: "1752278460000000002",
    contentSha256: "0x" + "22".repeat(32),
  },
];

const vectorCommitment = {
  version: 1,
  jobId: "20260711-demo-1",
  port: { inboxId: "4a8b60a536cb000000000000000000000000000000000000000000000000bbbb" },
  agent: {
    agentId: "4711",
    wallet: "0xd40181b8b051077f782fedfb21f7aca7ddeec57c",
  },
  freelancer: {
    inboxId: "44b305e579fc000000000000000000000000000000000000000000000000aaaa",
    wallet: "0x293300ad433c594bcde23e1aacc2914619e12563",
    payoutAddress: "0x293300ad433c594bcde23e1aacc2914619e12563",
  },
  terms: {
    criteria: "Write a 700-word review of the Prime Port docs. Plain English. No em dashes.",
    price: "40",
    currency: "USDT",
    deadline: 1752969600,
  },
  feeBps: 250,
  transcriptHash: transcriptHash(vectorMessages),
  hiredAt: 1752278400,
};

test("canonicalize sorts keys at every level and strips whitespace", () => {
  assert.equal(canonicalize({ b: 1, a: { d: "x", c: [2, 3] } }), '{"a":{"c":[2,3],"d":"x"},"b":1}');
});

test("canonicalize rejects floats and undefined", () => {
  assert.throws(() => canonicalize({ price: 39.5 }), /non-integer/);
  assert.throws(() => canonicalize({ a: undefined }), /undefined/);
});

test("key order does not change the hash", () => {
  const reordered = JSON.parse(JSON.stringify(vectorCommitment));
  const { terms, ...rest } = reordered;
  assert.equal(commitmentHash({ terms, ...rest }), commitmentHash(vectorCommitment));
});

test("pinned transcript hash vector", () => {
  assert.equal(
    transcriptHash(vectorMessages),
    "0xbbb53303bdfffbf64cb2913ed81e7a654a6288fb9dfba8e469da247c09a3e2b8",
  );
});

test("pinned commitment hash vector", () => {
  assert.equal(
    commitmentHash(vectorCommitment),
    "0x09a57708b992c000972d11bc31cbb26e89d84b49005f21a1b372289c34a400c3",
  );
});

test("signing message shape", () => {
  assert.equal(
    signingMessage(commitmentHash(vectorCommitment)),
    "Prime Port hire commitment v1: 0x09a57708b992c000972d11bc31cbb26e89d84b49005f21a1b372289c34a400c3",
  );
});

test("transcript entries validate their field types", () => {
  assert.throws(() => transcriptHash([{ ...vectorMessages[0], sentAtNs: 1 }]), /decimal string/);
  assert.throws(
    () => transcriptHash([{ ...vectorMessages[0], contentSha256: "beef" }]),
    /sha256/,
  );
});
