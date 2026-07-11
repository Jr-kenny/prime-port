export type JobStatus =
  | "open"
  | "hiring"
  | "awaiting-freelancer-signature"
  | "hired"
  | "approved"
  | "settled";

export type PublicJob = {
  jobId: string;
  status: JobStatus;
  title: string;
  criteria: string;
  price: string;
  currency: "USDT" | string;
  deadline: number;
  createdAt?: number;
  feeBps?: number;
  port?: {
    inboxId: string;
  };
  claims?: Array<{
    inboxId: string;
    wallet: string;
    payoutAddress: string;
    name: string;
    claimedAt: number;
  }>;
  pendingHire?: {
    hash: string;
    commitment: unknown;
  };
};

export type ClaimRequest = {
  inboxId: string;
  wallet: string;
  payoutAddress: string;
  name: string;
};

export type ClaimResponse = {
  claimed: boolean;
  portInboxId: string;
  next: string;
};

export type DemoIdentity = {
  inboxId: string;
  wallet: string;
  payoutAddress: string;
  name: string;
  email: string;
  createdAt: number;
};

export type ClaimRecord = DemoIdentity & {
  jobId: string;
  portInboxId: string;
  claimedAt: number;
};

export type ChatMessage = {
  id: string;
  jobId: string;
  sender: "freelancer" | "port";
  content: string;
  createdAt: number;
};
