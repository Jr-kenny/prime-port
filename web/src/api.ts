// Thin client over the mcp-server REST surface (proxied at /api by Vite).
export type PublicJob = {
  jobId: string;
  status: "open" | "hiring" | "awaiting-freelancer-signature" | "awaiting-escrow" | "hired" | "delivered" | "delivery-rejected" | "disputed" | "settled" | "failed";
  title: string;
  description?: string;
  deliverables?: string;
  criteria: string;
  // null when the job is listed open to offers: no anchor price, the
  // freelancer names their rate and it's settled in negotiation.
  price: string | null;
  currency: string;
  deadline: number;
  agent?: { agentId: string; wallet: string };
  claims: { inboxId: string; wallet: string; payoutAddress: string; name: string; claimedAt: number }[];
  port: { inboxId: string };
  pendingHire?: {
    hash: string;
    // Mirrors the real commitment shape (docs/hire-commitment.md): the
    // negotiated price and currency live under terms, not at the top level.
    commitment: {
      freelancer: { inboxId: string; wallet: string; payoutAddress: string };
      terms: { price: string; currency: string };
    };
    escrow?: {
      version: 1;
      chainId: number;
      escrowAddress: string;
      tokenAddress: string;
      authorizationHash: string;
      signThisExactly: string;
      amount: string;
      currency: string;
    };
  };
  settlement?: {
    contractAddress: string;
    chainId: number;
    tokenAddress: string;
    commitmentHash: string;
    status: string;
    reviewStatus: "not-submitted" | "awaiting-review" | "revision-requested" | "final-delivery-ready";
    latestSubmissionId?: string;
    finalSubmissionId?: string;
    fundedAt?: number;
    evidenceHash?: string;
    providerBps?: number;
  };
  submissions?: {
    submissionId: string;
    revision: number;
    note: string;
    attachments: { filename: string; contentLength: number; contentDigest: string; url: string }[];
    transcriptHash: string;
    status: "awaiting-review" | "revision-requested" | "accepted";
    feedback?: string;
    submittedAt: number;
    reviewedAt?: number;
  }[];
  createdAt: number;
  publishTask?: {
    marketplaceJobId: string;
    paidAt: number | null;
    keyDeliveredAt: number | null;
  };
};

export type FreelancerProfile = {
  inboxId: string;
  name: string | null;
  jobsClaimed: number;
  jobsHired: number;
  jobsCompleted: number;
  completionRate: number | null;
  avgStars: number | null;
  reviewCount: number;
};

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? `${method} ${path} failed`);
  return j as T;
}

export const listJobs = () =>
  api<PublicJob[]>("GET", "/jobs").then((jobs) => jobs.filter((job) => !job.publishTask || Boolean(job.publishTask.paidAt)));
export const claimJob = (jobId: string, claim: { inboxId: string; wallet: string; payoutAddress?: string; name: string }) =>
  api<{ claimed: boolean; portInboxId: string }>("POST", `/jobs/${jobId}/claims`, claim);
export type EscrowFundingRequest = {
  version: 1;
  network: string;
  chainId: number;
  escrowAddress: string;
  tokenAddress: string;
  commitmentHash: string;
  authorizationHash: string;
  amount: string;
  amountUnits: string;
  currency: string;
  approval: WalletTransaction;
  funding: WalletTransaction;
};
export const countersignHire = (jobId: string, signature: string) =>
  api<{
    committed: boolean;
    commitmentHash: string;
    fundingRequest: EscrowFundingRequest;
  }>("POST", `/jobs/${jobId}/countersign`, { signature });
export const submitForReview = (jobId: string, freelancerInboxId: string, note: string) =>
  api<{ submitted: boolean; submission: NonNullable<PublicJob["submissions"]>[number] }>("POST", `/jobs/${jobId}/submissions`, {
    freelancerInboxId,
    note,
  });
export const getProfile = (inboxId: string) => api<FreelancerProfile>("GET", `/freelancers/${inboxId}/profile`);

export type WalletTransaction = {
  network?: string;
  chainId: number;
  to: string;
  value: string;
  data: string;
  description?: string;
};

export const openDispute = (jobId: string, freelancerInboxId: string, reason: string) =>
  api<{ evidenceHash: string; evidenceUrl: string; transaction: WalletTransaction }>(
    "POST",
    `/jobs/${jobId}/dispute`,
    { freelancerInboxId, reason },
  );

export const refundBuyer = (jobId: string, freelancerInboxId: string) =>
  api<{ transaction: WalletTransaction }>("POST", `/jobs/${jobId}/refund`, { freelancerInboxId });
