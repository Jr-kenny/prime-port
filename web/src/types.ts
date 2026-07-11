export type JobStatus =
  | "open"
  | "hiring"
  | "awaiting-freelancer-signature"
  | "hired"
  | "approved"
  | "settled";

export type HireCommitment = {
  version: number;
  jobId: string;
  port: {
    inboxId: string;
  };
  agent: {
    agentId: string;
    wallet: string;
  };
  freelancer: {
    inboxId: string;
    wallet: string;
    payoutAddress: string;
  };
  terms: {
    criteria: string;
    price: string;
    currency: string;
    deadline: number;
  };
  feeBps?: number;
  transcriptHash: string;
  hiredAt: number;
};

export type PendingHire = {
  hash: string;
  commitment: HireCommitment;
};

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
  agent?: {
    agentId: string;
    wallet: string;
  };
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
  pendingHire?: PendingHire;
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

export type CountersignResponse = {
  hired: boolean;
  commitmentHash: string;
};

export type DemoIdentity = {
  inboxId: string;
  wallet: string;
  walletPrivateKey: string;
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

export type EvidenceAttachment = {
  name: string;
  size: number;
  mimeType: string;
  kind: "file" | "media";
};

export type EvidenceSubmission = {
  id: string;
  jobId: string;
  note: string;
  links: string[];
  txHashes: string[];
  attachments: EvidenceAttachment[];
  createdAt: number;
};
