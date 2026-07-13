// Thin client over the mcp-server REST surface (proxied at /api by Vite).
export type PublicJob = {
  jobId: string;
  status: "open" | "hiring" | "awaiting-freelancer-signature" | "awaiting-escrow" | "hired" | "approved" | "settled";
  title: string;
  criteria: string;
  price: string;
  currency: string;
  deadline: number;
  agent?: { agentId: string; wallet: string };
  claims: { inboxId: string; wallet: string; payoutAddress: string; name: string; claimedAt: number }[];
  port: { inboxId: string };
  pendingHire?: {
    hash: string;
    commitment: {
      freelancer: { inboxId: string; wallet: string; payoutAddress: string };
      price: string;
      currency: string;
    };
  };
  createdAt: number;
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
  const r = await fetch(`/api${path}`, { method, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? `${method} ${path} failed`);
  return j as T;
}

export const listJobs = () => api<PublicJob[]>("GET", "/jobs");
export const claimJob = (jobId: string, claim: { inboxId: string; wallet: string; payoutAddress?: string; name: string }) =>
  api<{ claimed: boolean; portInboxId: string }>("POST", `/jobs/${jobId}/claims`, claim);
export const countersignHire = (jobId: string, signature: string) =>
  api<{ committed: boolean; commitmentHash: string }>("POST", `/jobs/${jobId}/countersign`, { signature });
export const getProfile = (inboxId: string) => api<FreelancerProfile>("GET", `/freelancers/${inboxId}/profile`);
