// Candidate labels for one job: C1, C2, C3.
//
// The alias is a stable, non-identifying handle the buyer can address, so a
// candidate's wallet never has to be handed around and no identity is leaked
// into message text.
const CANDIDATE_ID = /^C([1-9]\d*)$/i;

export const normalizeCandidateId = (value) => {
  const match = String(value ?? "").trim().match(CANDIDATE_ID);
  return match ? `C${Number(match[1])}` : null;
};

export function ensureCandidateAliases(job) {
  const claims = Array.isArray(job?.claims) ? job.claims : [];
  const used = new Set();
  let changed = false;

  for (const claim of claims) {
    const candidateId = normalizeCandidateId(claim.candidateId);
    if (!candidateId || used.has(candidateId)) {
      if (claim.candidateId != null) {
        delete claim.candidateId;
        changed = true;
      }
      continue;
    }
    if (claim.candidateId !== candidateId) {
      claim.candidateId = candidateId;
      changed = true;
    }
    used.add(candidateId);
  }

  let next = 1;
  for (const claim of claims) {
    if (claim.candidateId) continue;
    while (used.has(`C${next}`)) next += 1;
    claim.candidateId = `C${next}`;
    claim.selectionStatus ??= "available";
    used.add(claim.candidateId);
    next += 1;
    changed = true;
  }

  for (const claim of claims) {
    if (!claim.selectionStatus) {
      claim.selectionStatus = "available";
      changed = true;
    }
  }
  return changed;
}

export function assignCandidateAlias(job, claim) {
  ensureCandidateAliases(job);
  const used = new Set((job.claims ?? []).map((candidate) => candidate.candidateId).filter(Boolean));
  let next = 1;
  while (used.has(`C${next}`)) next += 1;
  claim.candidateId = `C${next}`;
  claim.selectionStatus = "available";
  return claim.candidateId;
}

export function findCandidate(job, value) {
  ensureCandidateAliases(job);
  const candidateId = normalizeCandidateId(value);
  if (!candidateId) throw new Error("candidate must be a stable id such as C1");
  const claim = job.claims.find((candidate) => candidate.candidateId === candidateId);
  if (!claim) throw new Error(`unknown candidate ${candidateId}`);
  return claim;
}
