export function normalizeGenLayerVerdict(value) {
  const get = (key) => value instanceof Map ? value.get(key) : value?.[key];
  const resolutionId = get("resolution_id");
  const verdictHash = get("verdict_hash");
  const evidenceHash = get("evidence_hash");
  const providerBps = Number(get("provider_bps"));
  if (!resolutionId && !verdictHash && !evidenceHash) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(resolutionId ?? "")) throw new Error("invalid GenLayer resolution_id");
  if (!/^0x[0-9a-fA-F]{64}$/.test(verdictHash ?? "")) throw new Error("invalid GenLayer verdict_hash");
  if (!/^0x[0-9a-fA-F]{64}$/.test(evidenceHash ?? "")) throw new Error("invalid GenLayer evidence_hash");
  if (!Number.isInteger(providerBps) || providerBps < 0 || providerBps > 10_000) {
    throw new Error("invalid GenLayer provider_bps");
  }
  return {
    resolutionId: resolutionId.toLowerCase(),
    verdictHash: verdictHash.toLowerCase(),
    evidenceHash: evidenceHash.toLowerCase(),
    providerBps,
  };
}

export function disputedJobs(jobs) {
  return jobs.filter((job) =>
    job.status === "disputed"
    && job.pendingHire?.hash
    && job.settlement?.evidenceHash
    && !job.settlement?.resolutionTransactionHash,
  );
}

export function needsGenLayerSubmission(job) {
  return !job.settlement?.genlayerSubmissionHash;
}
