// Pure routing policy for the single, shared Prime Port settlement ASP.
// The model may explain tasks in natural language, but this module is the
// authority for deciding whether a private OKX task belongs to a signed hire.

const COMMITMENT_HASH = /0x[0-9a-f]{64}/i;

export function extractCommitmentHash(task) {
  return `${task?.title ?? ""} ${task?.description ?? ""}`
    .match(COMMITMENT_HASH)?.[0]
    ?.toLowerCase() ?? null;
}

export function normalizeDecimal(value) {
  const match = String(value ?? "").trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const whole = match[1].replace(/^0+(?=\d)/, "");
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function normalizeSettlementToken(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  if (symbol === "USDT" || symbol === "USD₮0") return "USDT";
  return symbol;
}

export function matchSettlementTask(task, boardJobs, workerAgentId) {
  if (String(task?.myAgentId ?? "") !== String(workerAgentId ?? "")) {
    return { ok: false, reason: "wrong settlement agent" };
  }

  const commitmentHash = extractCommitmentHash(task);
  if (!commitmentHash) return { ok: false, reason: "missing Prime Port commitment hash" };

  const job = boardJobs.find?.(
    (candidate) =>
      candidate.status === "awaiting-escrow" &&
      candidate.pendingHire?.hash?.toLowerCase() === commitmentHash,
  );
  if (!job) return { ok: false, commitmentHash, reason: "no matching signed hire awaiting escrow" };

  if (String(task.counterpartyAgentId ?? "") !== String(job.agent?.agentId ?? "")) {
    return { ok: false, commitmentHash, job, reason: "buyer agent does not match the hire commitment" };
  }

  const expectedAmount = normalizeDecimal(job.pendingHire.commitment.terms.price);
  const taskAmount = normalizeDecimal(task.tokenAmount);
  if (!expectedAmount || taskAmount !== expectedAmount) {
    return {
      ok: false,
      commitmentHash,
      job,
      reason: `task amount does not match the signed price (${expectedAmount ?? "invalid"})`,
    };
  }

  const expectedToken = normalizeSettlementToken(job.pendingHire.commitment.terms.currency);
  const taskToken = normalizeSettlementToken(task.tokenSymbol);
  if (taskToken !== expectedToken) {
    return {
      ok: false,
      commitmentHash,
      job,
      reason: `task token does not match the signed currency (${expectedToken})`,
    };
  }

  return { ok: true, commitmentHash, job, amount: expectedAmount, currency: expectedToken };
}

export function buildSettlementDeliverable(job) {
  const finalId = job?.settlement?.finalSubmissionId;
  const submission = job?.submissions?.find?.((candidate) => candidate.submissionId === finalId);
  if (!submission || submission.status !== "accepted") return null;

  const attachmentSummary = submission.attachments.length
    ? submission.attachments.map((attachment) => `${attachment.filename || "attachment"} (${attachment.contentDigest})`).join(", ")
    : "none";
  return [
    `Prime Port final delivery for ${job.jobId}.`,
    `Hire commitment: ${job.pendingHire.hash}.`,
    `Submission: ${submission.submissionId}, revision ${submission.revision}.`,
    `Freelancer note: ${submission.note || "(no note)"}`,
    `Encrypted attachments: ${attachmentSummary}.`,
    `Submission transcript: ${submission.transcriptHash}.`,
  ].join(" ");
}
