import { startTransition, useEffect, useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import {
  AlertCircle,
  ArrowLeft,
  BadgeCheck,
  BriefcaseBusiness,
  CheckCircle2,
  Clock3,
  CreditCard,
  FileImage,
  FileText,
  FileUp,
  Hash,
  Inbox,
  Link2,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Mail,
  MessageCircle,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  UserRound,
  WalletCards,
} from "lucide-react";
import { ApiError, claimJob, countersignHire, listJobs } from "./api";
import { clearIdentity, getOrCreateIdentity, readIdentity, saveIdentity, signIdentityMessage } from "./identity";
import { GlideGroup, InteractiveShell, MagneticButton, Reveal } from "./interaction";
import { appendMessage, readClaims, readEvidence, readMessages, saveClaim, saveEvidenceSubmission, seedConversation } from "./storage";
import type {
  ChatMessage,
  ClaimRecord,
  DemoIdentity,
  EvidenceAttachment,
  EvidenceSubmission,
  JobStatus,
  PublicJob,
} from "./types";

type Route =
  | { name: "landing" }
  | { name: "home" }
  | { name: "jobs" }
  | { name: "job"; jobId: string }
  | { name: "chats" }
  | { name: "chat"; jobId: string }
  | { name: "signin" }
  | { name: "settings" };

type LoadState = "loading" | "ready" | "error";

type Conversation = {
  claim: ClaimRecord;
  job: PublicJob;
  messages: ChatMessage[];
};

const CATEGORY_CHIPS = ["All", "Video", "Design", "Copywriting", "Data", "Translation", "Research", "Support", "General"];

function parseRoute(): Route {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  const [, first, second] = path.split("/");
  if (first === "jobs" && second) return { name: "job", jobId: decodeURIComponent(second) };
  if (first === "jobs") return { name: "jobs" };
  if (first === "home") return { name: "home" };
  if (first === "chats" && second) return { name: "chat", jobId: decodeURIComponent(second) };
  if (first === "chats") return { name: "chats" };
  if (first === "signin") return { name: "signin" };
  if (first === "settings") return { name: "settings" };
  return { name: "landing" };
}

function formatDeadline(deadline: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(deadline * 1000));
}

function formatDate(date: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(date));
}

function formatTime(time: number) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(time));
}

function formatAmount(value: string | number, currency = "USDT") {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return `${numeric.toLocaleString(undefined, {
      minimumFractionDigits: Number.isInteger(numeric) ? 0 : 2,
      maximumFractionDigits: 2,
    })} ${currency}`;
  }
  return `${value} ${currency}`;
}

function amountAsNumber(value: string) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function shortAddress(value: string) {
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function statusCopy(status: JobStatus) {
  const copy: Record<JobStatus, string> = {
    open: "Open",
    hiring: "Hiring",
    "awaiting-freelancer-signature": "Awaiting your signature",
    hired: "Escrow locked",
    approved: "Approved",
    settled: "Paid out",
  };
  return copy[status] ?? status;
}

function isEscrowLocked(status: JobStatus) {
  return status === "hired" || status === "approved" || status === "settled";
}

function isPendingPayment(status: JobStatus) {
  return status === "hired" || status === "approved";
}

function normalizeWords(value: string) {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function parseCriteriaList(criteria: string) {
  const cleaned = criteria.replace(/\s+/g, " ").trim();
  const sentenceParts = cleaned
    .split(/[.;]\s+/)
    .map((part) => normalizeWords(part))
    .filter(Boolean);
  if (sentenceParts.length > 1) return sentenceParts.slice(0, 4);

  const clauseParts = cleaned
    .split(/,\s+|\s+and\s+/i)
    .map((part) => normalizeWords(part))
    .filter(Boolean);
  if (clauseParts.length > 1) return clauseParts.slice(0, 4);

  return [normalizeWords(cleaned)];
}

function inferCategory(job: PublicJob) {
  const source = `${job.title} ${job.criteria}`.toLowerCase();
  if (/(video|edit|editing|reel|youtube|shorts|motion)/.test(source)) return "Video";
  if (/(design|figma|brand|ui|ux|graphic|landing page)/.test(source)) return "Design";
  if (/(copy|content|write|writing|review|brief|message)/.test(source)) return "Copywriting";
  if (/(data|sheet|spreadsheet|research|scrape|analysis)/.test(source)) return "Data";
  if (/(translate|translation|localized|language)/.test(source)) return "Translation";
  if (/(research|audit|benchmark|interview)/.test(source)) return "Research";
  if (/(support|moderation|assistant|ops|operations)/.test(source)) return "Support";
  return "General";
}

function lifecycleCopy(job: PublicJob, messages: ChatMessage[]) {
  if (job.status === "settled") return `Payment released · ${formatAmount(job.price, job.currency)}`;
  if (job.status === "approved") return `Approval recorded · ${formatAmount(job.price, job.currency)}`;
  if (job.status === "hired") return `Escrow locked · ${formatAmount(job.price, job.currency)}`;
  if (job.status === "awaiting-freelancer-signature") return "Draft ready to sign";
  if (job.status === "hiring") return "Agent is preparing hire terms";
  if (messages.length <= 2) return "Draft ready to send";
  return "Conversation active";
}

function escrowLine(job: PublicJob) {
  if (job.status === "settled") return "Payment released. This port is now part of your final work record.";
  if (job.status === "approved") return "Work approved. Payment is being released to your payout wallet.";
  if (job.status === "hired") return "Escrow locked. Work can safely begin.";
  if (job.status === "awaiting-freelancer-signature") return "The agent has signed. Your confirmation is the next step.";
  return "Escrow is not locked yet. Use chat to agree on terms before work starts.";
}

function signingMessage(hash: string) {
  return `Prime Port hire commitment v1: ${hash}`;
}

function isSelectedForHire(job: PublicJob, claim: ClaimRecord) {
  return job.pendingHire?.commitment.freelancer.inboxId === claim.inboxId;
}

function isNonSelectedConversation(job: PublicJob, claim: ClaimRecord) {
  if (!job.pendingHire) return false;
  return job.pendingHire.commitment.freelancer.inboxId !== claim.inboxId;
}

function isConversationReadOnly(job: PublicJob, claim: ClaimRecord) {
  if (job.status === "approved" || job.status === "settled") return true;
  if ((job.status === "hiring" || job.status === "awaiting-freelancer-signature" || job.status === "hired") && isNonSelectedConversation(job, claim)) {
    return true;
  }
  return false;
}

function conversationLockCopy(job: PublicJob, claim: ClaimRecord) {
  if (job.status === "approved" || job.status === "settled") {
    return "This port is now archived. Payment and transcript history are preserved, but new messages are closed.";
  }
  if (isNonSelectedConversation(job, claim)) {
    return "The agent moved forward with another freelancer. This port is now read-only.";
  }
  return "";
}

function formatFileSize(size: number) {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

function summarizeEvidence(submission: EvidenceSubmission) {
  const parts = [
    submission.links.length > 0 ? `${submission.links.length} link${submission.links.length === 1 ? "" : "s"}` : "",
    submission.txHashes.length > 0 ? `${submission.txHashes.length} tx hash${submission.txHashes.length === 1 ? "" : "es"}` : "",
    submission.attachments.length > 0 ? `${submission.attachments.length} attachment${submission.attachments.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(", ") : "note only";
}

function conversationsFrom(jobs: PublicJob[], claims: ClaimRecord[]) {
  return claims
    .map((claim) => {
      const job = jobs.find((item) => item.jobId === claim.jobId);
      if (!job) return undefined;
      return { claim, job, messages: readMessages(claim.jobId) };
    })
    .filter((item): item is Conversation => Boolean(item))
    .sort((left, right) => {
      const leftTime = left.messages.at(-1)?.createdAt ?? left.claim.claimedAt;
      const rightTime = right.messages.at(-1)?.createdAt ?? right.claim.claimedAt;
      return rightTime - leftTime;
    });
}

function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <section className="empty-state card">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </section>
  );
}

function InlineNotice({ icon, text, tone = "default" }: { icon: ReactNode; text: string; tone?: "default" | "error" }) {
  return (
    <div className={`inline-notice ${tone}`}>
      {icon}
      <span>{text}</span>
    </div>
  );
}

function StatusPill({ status }: { status: JobStatus }) {
  return <span className={`status-pill status-${status}`}>{statusCopy(status)}</span>;
}

function EvidenceTimeline({ submissions }: { submissions: EvidenceSubmission[] }) {
  if (submissions.length === 0) {
    return <p className="support-copy">No evidence has been submitted in this port yet.</p>;
  }

  return (
    <div className="evidence-list">
      {submissions
        .slice()
        .reverse()
        .map((submission) => (
          <article className="evidence-card" key={submission.id}>
            <div className="evidence-header">
              <div>
                <strong>Submission sent</strong>
                <small>{summarizeEvidence(submission)}</small>
              </div>
              <time>{formatDate(submission.createdAt)}</time>
            </div>

            {submission.note && <p className="evidence-note">{submission.note}</p>}

            {submission.links.length > 0 && (
              <div className="evidence-group">
                <span className="evidence-label">
                  <Link2 size={15} />
                  URLs
                </span>
                <div className="evidence-token-list">
                  {submission.links.map((link) => (
                    <a className="evidence-link" href={link} key={link} rel="noreferrer" target="_blank">
                      {link}
                    </a>
                  ))}
                </div>
              </div>
            )}

            {submission.txHashes.length > 0 && (
              <div className="evidence-group">
                <span className="evidence-label">
                  <Hash size={15} />
                  Tx hashes
                </span>
                <div className="evidence-token-list">
                  {submission.txHashes.map((hash) => (
                    <span className="evidence-token" key={hash}>
                      {shortAddress(hash)}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {submission.attachments.length > 0 && (
              <div className="evidence-group">
                <span className="evidence-label">
                  <FileUp size={15} />
                  Files and media
                </span>
                <div className="attachment-list">
                  {submission.attachments.map((attachment) => (
                    <div className="attachment-chip" key={`${submission.id}-${attachment.name}-${attachment.size}`}>
                      {attachment.kind === "media" ? <FileImage size={15} /> : <FileText size={15} />}
                      <span>
                        <strong>{attachment.name}</strong>
                        <small>
                          {attachment.mimeType || "file"} · {formatFileSize(attachment.size)}
                        </small>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </article>
        ))}
    </div>
  );
}

function HireDraftPanel({
  job,
  identity,
  onRefreshJobs,
  onCountersigned,
  onNavigate,
}: {
  job: PublicJob;
  identity: DemoIdentity;
  onRefreshJobs: () => Promise<void> | void;
  onCountersigned: (messages: ChatMessage[]) => void;
  onNavigate: (path: string) => void;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const commitment = job.pendingHire?.commitment;

  if (!commitment) return null;

  const walletMismatch = commitment.freelancer.wallet.toLowerCase() !== identity.wallet.toLowerCase();
  const payoutChanged = commitment.freelancer.payoutAddress.toLowerCase() !== identity.payoutAddress.toLowerCase();

  async function handleCountersign() {
    if (walletMismatch || !job.pendingHire) return;

    setError("");
    setIsSubmitting(true);
    try {
      const signature = await signIdentityMessage(identity, signingMessage(job.pendingHire.hash));
      await countersignHire(job.jobId, signature);
      const nextMessages = appendMessage({
        id: window.crypto.randomUUID(),
        jobId: job.jobId,
        sender: "port",
        content: "Your countersignature is recorded. Escrow is locked and work can begin.",
        createdAt: Date.now(),
      });
      onCountersigned(nextMessages);
      await onRefreshJobs();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not countersign this hire");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="workflow-panel workflow-panel-accent">
      <div className="workflow-heading">
        <p className="eyebrow">Hire draft</p>
        <h2>Review and confirm the committed hire.</h2>
        <p className="support-copy">Funds lock only after you countersign this exact draft.</p>
      </div>

      <div className="workflow-facts">
        <article>
          <span>Final price</span>
          <strong>{formatAmount(commitment.terms.price, commitment.terms.currency)}</strong>
        </article>
        <article>
          <span>Deadline</span>
          <strong>{formatDeadline(commitment.terms.deadline)}</strong>
        </article>
        <article>
          <span>Payout wallet</span>
          <strong>{shortAddress(commitment.freelancer.payoutAddress)}</strong>
        </article>
        <article>
          <span>Transcript hash</span>
          <strong>{shortAddress(commitment.transcriptHash)}</strong>
        </article>
      </div>

      <div className="workflow-copy">
        <strong>Final criteria</strong>
        <p>{commitment.terms.criteria}</p>
      </div>

      {payoutChanged && (
        <InlineNotice
          icon={<AlertCircle size={17} />}
          text={`This draft will pay ${shortAddress(commitment.freelancer.payoutAddress)}. If you need a different payout wallet, update it in settings and ask the agent to refresh the draft before you sign.`}
        />
      )}

      {walletMismatch && (
        <InlineNotice
          tone="error"
          icon={<AlertCircle size={17} />}
          text="This hire draft was created for a different wallet than your current local signer, so it cannot be countersigned from this session."
        />
      )}

      {error && <InlineNotice tone="error" icon={<AlertCircle size={17} />} text={error} />}

      <div className="workflow-actions">
        <MagneticButton className="primary-button" type="button" disabled={isSubmitting || walletMismatch} onClick={handleCountersign}>
          {isSubmitting ? <LoaderCircle className="spin" size={18} /> : <BadgeCheck size={18} />}
          Confirm and lock escrow
        </MagneticButton>
        <button className="secondary-button" type="button" onClick={() => onNavigate("/settings")}>
          Review payout wallet
        </button>
      </div>
    </section>
  );
}

function AppHeader({
  route,
  identity,
  chatCount,
  onNavigate,
}: {
  route: Route;
  identity: DemoIdentity | null;
  chatCount: number;
  onNavigate: (path: string) => void;
}) {
  const section =
    route.name === "jobs" || route.name === "job"
      ? "jobs"
      : route.name === "chats" || route.name === "chat"
        ? "chats"
        : route.name === "settings"
          ? "settings"
        : route.name === "signin"
            ? "signin"
            : "home";
  const navItems = [
    { key: "home", label: "Home", active: section === "home", onClick: () => onNavigate("/home") },
    { key: "jobs", label: "Jobs", active: section === "jobs", onClick: () => onNavigate("/jobs") },
    {
      key: "chats",
      label: "Chats",
      active: section === "chats",
      onClick: () => onNavigate("/chats"),
      badge: chatCount > 0 ? <b>{chatCount}</b> : undefined,
    },
    { key: "settings", label: "Settings", active: section === "settings", onClick: () => onNavigate("/settings") },
  ];

  return (
    <header className="app-header card">
      <button className="brand-button" type="button" onClick={() => onNavigate("/home")}>
        <span className="brand-mark">
          <ShieldCheck size={18} />
        </span>
        <span className="brand-copy">
          <strong>Prime Port</strong>
          <small>Freelancer web app</small>
        </span>
      </button>

      <nav aria-label="Primary">
        <GlideGroup className="top-tabs" items={navItems} />
      </nav>

      <div className="header-actions">
        {identity ? (
          <button className="profile-chip" type="button" onClick={() => onNavigate("/settings")}>
            <span className="avatar">
              <UserRound size={16} />
            </span>
            <span>
              <strong>{identity.name}</strong>
              <small>{identity.email}</small>
            </span>
          </button>
        ) : (
          <MagneticButton className="primary-button" type="button" onClick={() => onNavigate("/signin")}>
            Sign in
          </MagneticButton>
        )}
      </div>
    </header>
  );
}

function LandingPage({
  jobs,
  claims,
  identity,
  onNavigate,
}: {
  jobs: PublicJob[];
  claims: ClaimRecord[];
  identity: DemoIdentity | null;
  onNavigate: (path: string) => void;
}) {
  const openJobs = jobs.filter((job) => job.status === "open").length;
  const lockedJobs = jobs.filter((job) => isEscrowLocked(job.status)).length;
  const landingLinks = [
    { key: "how", label: "How it works", href: "#how-it-works" },
    { key: "safe", label: "Why it feels safe", href: "#fairness" },
  ];

  return (
    <main className="landing-page">
      <Reveal>
        <nav className="landing-nav card" aria-label="Landing navigation">
          <button className="brand-button" type="button" onClick={() => onNavigate("/")}>
            <span className="brand-mark">
              <ShieldCheck size={18} />
            </span>
            <span className="brand-copy">
              <strong>Prime Port</strong>
              <small>Job board plus chat</small>
            </span>
          </button>

          <GlideGroup className="landing-links" items={landingLinks} />

          <MagneticButton className="primary-button" type="button" onClick={() => onNavigate(identity ? "/jobs" : "/signin")}>
            {identity ? "Browse jobs" : "Sign in"}
          </MagneticButton>
        </nav>
      </Reveal>

      <Reveal>
        <InteractiveShell as="section" className="landing-hero card" spotlight>
          <div className="hero-copy">
            <p className="eyebrow">Freelancer marketplace</p>
            <h1>Own the conversation. Get paid for it.</h1>
            <p className="hero-text">
              Prime Port keeps the freelancer experience familiar: browse open jobs, claim your own private port, agree on
              terms in chat, and get paid through secure escrow without learning wallet setup on day one.
            </p>

            <div className="trust-chips" aria-label="Trust signals">
              <span>Escrow-backed</span>
              <span>Private port per hire</span>
              <span>Signed unforgeable chat</span>
            </div>

            <div className="hero-actions">
              <MagneticButton className="primary-button" type="button" onClick={() => onNavigate("/jobs")}>
                <BriefcaseBusiness size={18} />
                Open jobs
              </MagneticButton>
              <button className="secondary-button" type="button" onClick={() => onNavigate(identity ? "/home" : "/signin")}>
                <Mail size={18} />
                {identity ? "Open dashboard" : "Create freelancer account"}
              </button>
            </div>
          </div>

          <div className="hero-panel">
            <InteractiveShell as="article" className="hero-metric card-soft" spotlight>
              <span>Open jobs</span>
              <strong>{openJobs}</strong>
              <small>Browse from social links or directly in the marketplace.</small>
            </InteractiveShell>
            <InteractiveShell as="article" className="hero-metric card-soft" spotlight>
              <span>Private chats</span>
              <strong>{claims.length}</strong>
              <small>Each claim becomes its own one-to-one port with the agent.</small>
            </InteractiveShell>
            <InteractiveShell as="article" className="hero-metric card-soft" spotlight>
              <span>Escrow locked</span>
              <strong>{lockedJobs}</strong>
              <small>Work starts after terms are signed and funds are committed.</small>
            </InteractiveShell>
          </div>
        </InteractiveShell>
      </Reveal>

      <div className="sticky-stage" id="how-it-works">
        <Reveal className="sticky-shell">
          <section className="card section-card">
            <div className="section-heading">
              <p className="eyebrow">How it works</p>
              <h2>Built to feel familiar from the first click.</h2>
            </div>
            <div className="steps-grid">
              {[
                ["Claim", "Pick an open job and claim your own private port."],
                ["Chat privately", "Use a dedicated conversation instead of public replies or shared group noise."],
                ["Agree on terms", "Review the scope, timing, and acceptance criteria before work begins."],
                ["Get paid", "Escrow and signed chat history protect the work that was agreed."],
              ].map(([title, body], index) => (
                <InteractiveShell as="article" className="step-card" key={title}>
                  <span>{index + 1}</span>
                  <strong>{title}</strong>
                  <p>{body}</p>
                </InteractiveShell>
              ))}
            </div>
          </section>
        </Reveal>
      </div>

      <Reveal>
        <section className="card section-card" id="fairness">
          <div className="section-heading">
            <p className="eyebrow">You&apos;re always paid fairly</p>
            <h2>The rules are visible before work starts.</h2>
          </div>
          <div className="fairness-grid">
            <InteractiveShell as="article" className="fairness-card" key="funds">
              <strong>Funds lock first</strong>
              <p>The agreement only moves into active work after payment commitment is in place.</p>
            </InteractiveShell>
            <InteractiveShell as="article" className="fairness-card" key="silence">
              <strong>Silence still pays</strong>
              <p>Your chat record and commitment state keep the job from disappearing into ambiguity.</p>
            </InteractiveShell>
            <InteractiveShell as="article" className="fairness-card" key="neutral">
              <strong>Neutral disputes</strong>
              <p>Terms stay visible to both sides, which makes disagreements about scope easier to resolve.</p>
            </InteractiveShell>
            <InteractiveShell as="article" className="fairness-card" key="history">
              <strong>No editable history</strong>
              <p>The signed thread becomes durable proof of what was asked, agreed, and delivered.</p>
            </InteractiveShell>
          </div>
        </section>
      </Reveal>

      <Reveal>
        <footer className="landing-footer card">
          <div>
            <strong>Prime Port</strong>
            <p>Freelancer-friendly job discovery, private negotiation, and secure payout routing in one flow.</p>
          </div>
          <button className="secondary-button" type="button" onClick={() => onNavigate("/jobs")}>
            Browse marketplace
          </button>
        </footer>
      </Reveal>
    </main>
  );
}

function HomeView({
  jobs,
  claims,
  identity,
  onNavigate,
}: {
  jobs: PublicJob[];
  claims: ClaimRecord[];
  identity: DemoIdentity | null;
  onNavigate: (path: string) => void;
}) {
  const openJobs = jobs.filter((job) => job.status === "open");
  const conversations = conversationsFrom(jobs, claims);
  const availableBalance = conversations
    .filter(({ job }) => job.status === "settled")
    .reduce((sum, { job }) => sum + amountAsNumber(job.price), 0);

  if (!identity) {
    return (
      <main className="page-grid">
        <EmptyState
          icon={<Mail size={26} />}
          title="Sign in to make this feel like your workspace."
          body="Your identity, payout wallet, claimed chats, and payment history all live behind a simple account setup."
          action={
            <MagneticButton className="primary-button" type="button" onClick={() => onNavigate("/signin")}>
              Create account
            </MagneticButton>
          }
        />
      </main>
    );
  }

  return (
    <main className="page-grid">
      <Reveal>
        <InteractiveShell as="section" className="page-hero card" spotlight>
          <div>
            <p className="eyebrow">Home</p>
            <h1>Welcome back, {identity.name}.</h1>
            <p className="page-intro">
              Keep an eye on new work, active chats, and the payouts already moving to your default wallet.
            </p>
          </div>
          <button className="secondary-button" type="button" onClick={() => onNavigate("/jobs")}>
            <BriefcaseBusiness size={18} />
            Browse jobs
          </button>
        </InteractiveShell>
      </Reveal>

      <Reveal>
        <section className="stats-row">
          <InteractiveShell as="article" className="stat-card card">
            <span>Open jobs</span>
            <strong>{openJobs.length}</strong>
            <small>New opportunities ready to claim</small>
          </InteractiveShell>
          <InteractiveShell as="article" className="stat-card card">
            <span>Active chats</span>
            <strong>{conversations.length}</strong>
            <small>Private conversations with hiring agents</small>
          </InteractiveShell>
          <InteractiveShell as="article" className="stat-card card">
            <span>Available balance</span>
            <strong>{formatAmount(availableBalance)}</strong>
            <small>Ready for withdrawal from settled jobs</small>
          </InteractiveShell>
        </section>
      </Reveal>

      <div className="content-grid">
        <Reveal className="grid-reveal">
          <section className="card section-card">
            <div className="section-heading inline">
              <div>
                <p className="eyebrow">Recent chats</p>
                <h2>Your inbox at a glance</h2>
              </div>
              <button className="text-button" type="button" onClick={() => onNavigate("/chats")}>
                Open chats
              </button>
            </div>
            {conversations.length === 0 ? (
              <EmptyState
                icon={<MessageCircle size={24} />}
                title="No claimed chats yet"
                body="Your private conversations will appear here after you claim a job."
              />
            ) : (
              <div className="stack-list">
                {conversations.slice(0, 3).map(({ claim, job, messages }) => (
                  <button className="list-row" key={claim.jobId} type="button" onClick={() => onNavigate(`/chats/${job.jobId}`)}>
                    <div>
                      <strong>{job.title}</strong>
                      <small>{lifecycleCopy(job, messages)}</small>
                    </div>
                    <span>{formatTime(messages.at(-1)?.createdAt ?? claim.claimedAt)}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </Reveal>

        <Reveal className="grid-reveal">
          <section className="card section-card">
            <div className="section-heading inline">
              <div>
                <p className="eyebrow">Marketplace</p>
                <h2>Fresh jobs to review</h2>
              </div>
            </div>
            <div className="job-list dense preview-list">
              {openJobs.slice(0, 3).map((job) => (
                <JobCard job={job} key={job.jobId} onNavigate={onNavigate} />
              ))}
            </div>
          </section>
        </Reveal>
      </div>
    </main>
  );
}

function JobCard({ job, onNavigate }: { job: PublicJob; onNavigate: (path: string) => void }) {
  return (
    <InteractiveShell className="job-card-shell" spotlight>
      <button className="job-card card" type="button" onClick={() => onNavigate(`/jobs/${job.jobId}`)}>
        <div className="job-card-top">
          <span className="category-chip">{inferCategory(job)}</span>
          <span className="job-budget">{formatAmount(job.price, job.currency)}</span>
        </div>
        <strong>{job.title}</strong>
        <p className="job-preview">{job.criteria}</p>
        <div className="job-meta">
          <span>
            <Clock3 size={14} />
            Due {formatDeadline(job.deadline)}
          </span>
          <span>
            <ShieldCheck size={14} />
            {job.agent?.agentId ?? "Posting agent"}
          </span>
        </div>
      </button>
    </InteractiveShell>
  );
}

function JobsView({
  jobs,
  loadState,
  error,
  onRefresh,
  onNavigate,
}: {
  jobs: PublicJob[];
  loadState: LoadState;
  error: string;
  onRefresh: () => void;
  onNavigate: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const filterItems = CATEGORY_CHIPS.map((chip) => ({
    key: chip,
    label: chip,
    active: chip === category,
    onClick: () => setCategory(chip),
  }));

  const filteredJobs = jobs.filter((job) => {
    const matchesQuery = `${job.title} ${job.criteria} ${job.agent?.agentId ?? ""}`.toLowerCase().includes(query.toLowerCase());
    const matchesCategory = category === "All" || inferCategory(job) === category;
    return matchesQuery && matchesCategory;
  });

  return (
    <main className="page-grid">
      <Reveal>
        <InteractiveShell as="section" className="page-hero card" spotlight>
          <div>
            <p className="eyebrow">Marketplace</p>
            <h1>Open jobs</h1>
            <p className="page-intro">Browse fast, compare offers cleanly, and jump straight into the detail page when a job feels right.</p>
          </div>
          <button className="secondary-button" type="button" onClick={onRefresh}>
            <RefreshCw size={18} />
            Refresh
          </button>
        </InteractiveShell>
      </Reveal>

      <Reveal>
        <section className="card section-card filters-card">
          <label className="toolbar" aria-label="Search jobs">
            <Search size={18} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, scope, or agent id" />
          </label>
          <GlideGroup ariaLabel="Category filters" className="filter-chips" items={filterItems} />
        </section>
      </Reveal>

      {loadState === "loading" && <InlineNotice icon={<LoaderCircle className="spin" size={18} />} text="Loading jobs" />}
      {loadState === "error" && <InlineNotice tone="error" icon={<AlertCircle size={18} />} text={error} />}

      {loadState === "ready" && filteredJobs.length === 0 ? (
        <EmptyState
          icon={<Inbox size={26} />}
          title="No jobs match this filter"
          body="Try a different category or search term."
        />
      ) : (
        <Reveal>
          <div className="job-list dense">
            {filteredJobs.map((job) => (
              <JobCard job={job} key={job.jobId} onNavigate={onNavigate} />
            ))}
          </div>
        </Reveal>
      )}
    </main>
  );
}

function JobDetailView({
  job,
  claims,
  loadState,
  identity,
  onNavigate,
  onClaimed,
  onRefresh,
}: {
  job?: PublicJob;
  claims: ClaimRecord[];
  loadState: LoadState;
  identity: DemoIdentity | null;
  onNavigate: (path: string) => void;
  onClaimed: (job: PublicJob, claim: ClaimRecord) => void;
  onRefresh: () => void;
}) {
  if (!job) {
    return (
      <main className="page-grid">
        {loadState === "loading" ? (
          <InlineNotice icon={<LoaderCircle className="spin" size={18} />} text="Loading job" />
        ) : (
          <EmptyState
            icon={<AlertCircle size={26} />}
            title="Job not found"
            body="This job link does not match an active listing."
            action={
              <MagneticButton className="primary-button" type="button" onClick={() => onNavigate("/jobs")}>
                Back to jobs
              </MagneticButton>
            }
          />
        )}
      </main>
    );
  }

  const criteria = parseCriteriaList(job.criteria);
  const existingClaim = claims.find((claim) => claim.jobId === job.jobId);

  return (
    <main className="detail-layout">
      <Reveal className="grid-reveal">
        <InteractiveShell as="section" className="job-detail card" spotlight>
          <button className="text-button back-button" type="button" onClick={() => onNavigate("/jobs")}>
            <ArrowLeft size={16} />
            Back to open jobs
          </button>

          <div className="detail-heading">
            <div className="detail-topline">
              <span className="category-chip">{inferCategory(job)}</span>
              <StatusPill status={job.status} />
            </div>
            <h1>{job.title}</h1>
            <p>{job.criteria}</p>
          </div>

          <div className="detail-facts">
            <article>
              <span>Budget</span>
              <strong>{formatAmount(job.price, job.currency)}</strong>
            </article>
            <article>
              <span>Deadline</span>
              <strong>{formatDeadline(job.deadline)}</strong>
            </article>
            <article>
              <span>Posting agent</span>
              <strong>{job.agent?.agentId ?? "Agent unavailable"}</strong>
            </article>
            <article>
              <span>Private port</span>
              <strong>{job.port?.inboxId ?? "Created at claim"}</strong>
            </article>
          </div>

          <section className="detail-section">
            <h2>Plain-language scope</h2>
            <p>{job.criteria}</p>
          </section>

          <section className="detail-section">
            <h2>Acceptance criteria</h2>
            <ul className="criteria-list">
              {criteria.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        </InteractiveShell>
      </Reveal>

      <Reveal className="grid-reveal">
        <ClaimPanel
          job={job}
          identity={identity}
          existingClaim={existingClaim}
          onClaimed={(claim) => onClaimed(job, claim)}
          onNavigate={onNavigate}
          onRefresh={onRefresh}
        />
      </Reveal>
    </main>
  );
}

function ClaimPanel({
  job,
  identity,
  existingClaim,
  onClaimed,
  onNavigate,
  onRefresh,
}: {
  job: PublicJob;
  identity: DemoIdentity | null;
  existingClaim?: ClaimRecord;
  onClaimed: (claim: ClaimRecord) => void;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleClaim() {
    if (!identity) {
      onNavigate("/signin");
      return;
    }

    setError("");
    setIsSubmitting(true);
    try {
      const response = await claimJob(job.jobId, {
        inboxId: identity.inboxId,
        wallet: identity.wallet,
        payoutAddress: identity.payoutAddress,
        name: identity.name,
      });
      const claim: ClaimRecord = {
        ...identity,
        jobId: job.jobId,
        portInboxId: response.portInboxId,
        claimedAt: Date.now(),
      };
      onClaimed(claim);
      onRefresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not claim this job");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (existingClaim) {
    const selectedForHire = isSelectedForHire(job, existingClaim);
    const isClosedOut = job.status === "approved" || job.status === "settled";
    const movedToAnotherFreelancer =
      (job.status === "hiring" || job.status === "awaiting-freelancer-signature" || job.status === "hired" || isClosedOut) &&
      isNonSelectedConversation(job, existingClaim);

    let title = "Port claimed";
    let body = "Your private conversation is ready and attached to this listing.";

    if (job.status === "awaiting-freelancer-signature" && selectedForHire) {
      title = "Hire draft ready";
      body = "Review the committed terms, confirm the payout wallet, and countersign in chat to lock escrow.";
    } else if (job.status === "hired" && selectedForHire) {
      title = "Escrow locked";
      body = "Work can begin now, and you can submit evidence through your private port.";
    } else if (movedToAnotherFreelancer) {
      title = "Another freelancer is being hired";
      body = "This port has moved into a read-only state while the selected hire continues.";
    } else if (job.status === "settled" && selectedForHire) {
      title = "Payment released";
      body = "This job has been settled and the final transcript is now part of your work record.";
    }

    return (
      <InteractiveShell as="aside" className="claim-panel card" spotlight>
        <div className="panel-icon success">
          <CheckCircle2 size={24} />
        </div>
        <h2>{title}</h2>
        <p>{body}</p>
        <MagneticButton className="primary-button wide" type="button" onClick={() => onNavigate(`/chats/${job.jobId}`)}>
          <MessageCircle size={18} />
          Open chat
        </MagneticButton>
      </InteractiveShell>
    );
  }

  if (!identity) {
    return (
      <InteractiveShell as="aside" className="claim-panel card" spotlight>
        <div className="panel-icon">
          <Mail size={24} />
        </div>
        <h2>Sign in before you claim</h2>
        <p>No crypto experience needed. We set up secure payment for you behind the scenes.</p>
        <MagneticButton className="primary-button wide" type="button" onClick={() => onNavigate("/signin")}>
          Continue to sign in
        </MagneticButton>
      </InteractiveShell>
    );
  }

  return (
    <InteractiveShell as="aside" className="claim-panel card" spotlight>
      <div className="panel-icon">
        <WalletCards size={24} />
      </div>
      <h2>Claim this job</h2>
      <p>No crypto experience needed. We set up secure payment for you.</p>

      <div className="claim-identity">
        <div>
          <span>Freelancer</span>
          <strong>{identity.name}</strong>
        </div>
        <div>
          <span>Email</span>
          <strong>{identity.email}</strong>
        </div>
        <div>
          <span>Default payout wallet</span>
          <strong>{shortAddress(identity.payoutAddress)}</strong>
        </div>
      </div>

      <MagneticButton className="primary-button wide" type="button" disabled={isSubmitting || job.status !== "open"} onClick={handleClaim}>
        {isSubmitting ? <LoaderCircle className="spin" size={18} /> : <BriefcaseBusiness size={18} />}
        {job.status === "open" ? "Claim private port" : "This job is closed"}
      </MagneticButton>

      <button className="secondary-button wide" type="button" onClick={() => onNavigate("/settings")}>
        Change payout wallet
      </button>

      {error && <InlineNotice tone="error" icon={<AlertCircle size={17} />} text={error} />}
    </InteractiveShell>
  );
}

function SignInView({
  identity,
  onSignedIn,
  onNavigate,
}: {
  identity: DemoIdentity | null;
  onSignedIn: (identity: DemoIdentity) => void;
  onNavigate: (path: string) => void;
}) {
  const [name, setName] = useState(identity?.name ?? "");
  const [email, setEmail] = useState(identity?.email ?? "");
  const [error, setError] = useState("");

  function createIdentity(nextEmail: string, nextName?: string) {
    const trimmedEmail = nextEmail.trim().toLowerCase();
    if (!trimmedEmail) {
      setError("Add an email address to continue.");
      return;
    }
    const fallbackName = trimmedEmail.split("@")[0].replace(/[._-]+/g, " ");
    const created = getOrCreateIdentity({
      name: normalizeWords((nextName ?? name).trim() || fallbackName),
      email: trimmedEmail,
    });
    setError("");
    onSignedIn(created);
    onNavigate("/home");
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createIdentity(email, name);
  }

  function handleGoogle() {
    const googleEmail = email.trim() || "freelancer@gmail.com";
    const googleName = name.trim() || "Google freelancer";
    createIdentity(googleEmail, googleName);
  }

  if (identity) {
    return (
      <main className="single-column-page">
        <Reveal>
          <InteractiveShell as="section" className="auth-card card" spotlight>
            <p className="eyebrow">Signed in</p>
            <h1>You&apos;re ready to claim jobs.</h1>
            <p className="page-intro">Your wallet was created automatically. You can update payout details any time in settings.</p>
            <div className="claim-identity">
              <div>
                <span>Name</span>
                <strong>{identity.name}</strong>
              </div>
              <div>
                <span>Email</span>
                <strong>{identity.email}</strong>
              </div>
              <div>
                <span>Wallet</span>
                <strong>{shortAddress(identity.wallet)}</strong>
              </div>
            </div>
            <div className="hero-actions">
              <MagneticButton className="primary-button" type="button" onClick={() => onNavigate("/jobs")}>
                Browse jobs
              </MagneticButton>
              <button className="secondary-button" type="button" onClick={() => onNavigate("/settings")}>
                Open settings
              </button>
            </div>
          </InteractiveShell>
        </Reveal>
      </main>
    );
  }

  return (
    <main className="single-column-page">
      <Reveal>
        <InteractiveShell as="section" className="auth-card card" spotlight>
          <p className="eyebrow">Sign in</p>
          <h1>Start with email or Google.</h1>
          <p className="page-intro">We create your wallet behind the scenes so you can focus on the job, not seed phrases.</p>

          <form className="auth-form" onSubmit={handleSubmit}>
            <label>
              <span>Full name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Ada Morgan" />
            </label>
            <label>
              <span>Email</span>
              <input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="ada@example.com" />
            </label>
            {error && <InlineNotice tone="error" icon={<AlertCircle size={17} />} text={error} />}
            <MagneticButton className="primary-button wide" type="submit">
              Continue with email
            </MagneticButton>
          </form>

          <div className="auth-divider">
            <span>or</span>
          </div>

          <button className="secondary-button wide" type="button" onClick={handleGoogle}>
            Continue with Google
          </button>
        </InteractiveShell>
      </Reveal>
    </main>
  );
}

function SettingsView({
  identity,
  jobs,
  claims,
  onNavigate,
  onIdentityChange,
}: {
  identity: DemoIdentity | null;
  jobs: PublicJob[];
  claims: ClaimRecord[];
  onNavigate: (path: string) => void;
  onIdentityChange: (identity: DemoIdentity | null) => void;
}) {
  const [payoutAddress, setPayoutAddress] = useState(identity?.payoutAddress ?? "");
  const [savedNote, setSavedNote] = useState("");
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawNote, setWithdrawNote] = useState("");

  useEffect(() => {
    setPayoutAddress(identity?.payoutAddress ?? "");
  }, [identity?.payoutAddress]);

  if (!identity) {
    return (
      <main className="page-grid">
        <EmptyState
          icon={<UserRound size={26} />}
          title="Sign in to view settings and identity."
          body="Your freelancer profile, payout wallet, and payment history live on this screen."
          action={
            <MagneticButton className="primary-button" type="button" onClick={() => onNavigate("/signin")}>
              Sign in
            </MagneticButton>
          }
        />
      </main>
    );
  }

  const activeIdentity = identity;
  const conversations = conversationsFrom(jobs, claims);
  const completedJobs = conversations.filter(({ job }) => job.status === "settled");
  const pendingJobs = conversations.filter(({ job }) => isPendingPayment(job.status));
  const availableBalance = completedJobs.reduce((sum, { job }) => sum + amountAsNumber(job.price), 0);
  const pendingBalance = pendingJobs.reduce((sum, { job }) => sum + amountAsNumber(job.price), 0);

  function handleSavePayout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = payoutAddress.trim() || activeIdentity.wallet;
    const nextIdentity = saveIdentity({ ...activeIdentity, payoutAddress: trimmed });
    onIdentityChange(nextIdentity);
    setSavedNote("Default payout wallet updated.");
  }

  function handleWithdraw(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (availableBalance <= 0) {
      setWithdrawNote("No balance is available to withdraw yet.");
      return;
    }
    setWithdrawNote(
      `Demo withdrawal prepared for ${withdrawAmount || availableBalance.toString()} USDT to ${shortAddress(activeIdentity.payoutAddress)}.`,
    );
    setShowWithdraw(false);
    setWithdrawAmount("");
  }

  function handleSignOut() {
    clearIdentity();
    onIdentityChange(null);
    onNavigate("/signin");
  }

  return (
    <main className="page-grid">
      <Reveal>
        <InteractiveShell as="section" className="page-hero card" spotlight>
          <div>
            <p className="eyebrow">Settings & identity</p>
            <h1>Your freelancer profile</h1>
            <p className="page-intro">Track work history, keep payout details current, and review what has already been paid out.</p>
          </div>
          <button className="secondary-button" type="button" onClick={handleSignOut}>
            <LogOut size={18} />
            Sign out
          </button>
        </InteractiveShell>
      </Reveal>

      <Reveal>
        <section className="stats-row">
          <InteractiveShell as="article" className="stat-card card">
            <span>Jobs claimed</span>
            <strong>{claims.length}</strong>
            <small>Total ports you have opened</small>
          </InteractiveShell>
          <InteractiveShell as="article" className="stat-card card">
            <span>Completed jobs</span>
            <strong>{completedJobs.length}</strong>
            <small>Jobs already settled to payout</small>
          </InteractiveShell>
          <InteractiveShell as="article" className="stat-card card">
            <span>Star rating</span>
            <strong>New</strong>
            <small>Ratings will appear here once issue #13 lands</small>
          </InteractiveShell>
        </section>
      </Reveal>

      <div className="settings-grid">
        <Reveal className="grid-reveal">
          <section className="card section-card">
            <div className="section-heading inline">
              <div>
                <p className="eyebrow">Balance</p>
                <h2>Payout overview</h2>
              </div>
            </div>
            <div className="balance-grid">
              <InteractiveShell as="article" className="balance-card">
                <span>Available to withdraw</span>
                <strong>{formatAmount(availableBalance)}</strong>
              </InteractiveShell>
              <InteractiveShell as="article" className="balance-card">
                <span>Pending</span>
                <strong>{formatAmount(pendingBalance)}</strong>
              </InteractiveShell>
            </div>
            <MagneticButton
              className="primary-button"
              type="button"
              onClick={() => {
                setWithdrawNote("");
                setWithdrawAmount(availableBalance > 0 ? availableBalance.toFixed(2) : "");
                setShowWithdraw((value) => !value);
              }}
            >
              <CreditCard size={18} />
              Withdraw balance
            </MagneticButton>

            {showWithdraw && (
              <form className="inline-form" onSubmit={handleWithdraw}>
                <label>
                  <span>Amount</span>
                  <input value={withdrawAmount} onChange={(event) => setWithdrawAmount(event.target.value)} placeholder="0.00" />
                </label>
                <MagneticButton className="primary-button" type="submit">
                  Confirm withdrawal
                </MagneticButton>
              </form>
            )}
            {withdrawNote && <InlineNotice icon={<CheckCircle2 size={17} />} text={withdrawNote} />}
          </section>
        </Reveal>

        <Reveal className="grid-reveal">
          <section className="card section-card">
            <div className="section-heading inline">
              <div>
                <p className="eyebrow">Wallet</p>
                <h2>Default payout wallet</h2>
              </div>
            </div>
            <form className="auth-form" onSubmit={handleSavePayout}>
              <label>
                <span>Payout address</span>
                <input value={payoutAddress} onChange={(event) => setPayoutAddress(event.target.value)} placeholder={activeIdentity.wallet} />
              </label>
              <MagneticButton className="primary-button" type="submit">
                Save payout wallet
              </MagneticButton>
            </form>
            {savedNote && <InlineNotice icon={<CheckCircle2 size={17} />} text={savedNote} />}
            <div className="claim-identity">
              <div>
                <span>Inbox id</span>
                <strong>{shortAddress(activeIdentity.inboxId)}</strong>
              </div>
              <div>
                <span>Wallet</span>
                <strong>{shortAddress(activeIdentity.wallet)}</strong>
              </div>
              <div>
                <span>Email</span>
                <strong>{activeIdentity.email}</strong>
              </div>
            </div>
          </section>
        </Reveal>
      </div>

      <Reveal>
        <section className="card section-card">
          <div className="section-heading inline">
            <div>
              <p className="eyebrow">Payment history</p>
              <h2>Recent activity</h2>
            </div>
          </div>
          {conversations.length === 0 ? (
            <EmptyState icon={<WalletCards size={24} />} title="No payment activity yet" body="Claim a job to start building your history." />
          ) : (
            <div className="stack-list">
              {conversations.map(({ claim, job, messages }) => (
                <article className="history-row" key={claim.jobId}>
                  <div>
                    <strong>{job.title}</strong>
                    <small>{lifecycleCopy(job, messages)}</small>
                  </div>
                  <div className="history-row-side">
                    <span>{formatAmount(job.price, job.currency)}</span>
                    <small>{formatDate(claim.claimedAt)}</small>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </Reveal>
    </main>
  );
}

function ChatThread({
  conversation,
  showBack,
  onBack,
  identity,
  onNavigate,
  onRefreshJobs,
}: {
  conversation?: Conversation;
  showBack: boolean;
  onBack: () => void;
  identity: DemoIdentity | null;
  onNavigate: (path: string) => void;
  onRefreshJobs: () => Promise<void> | void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(conversation ? readMessages(conversation.job.jobId) : []);
  const [submissions, setSubmissions] = useState<EvidenceSubmission[]>(conversation ? readEvidence(conversation.job.jobId) : []);
  const [draft, setDraft] = useState("");
  const [showWorkbench, setShowWorkbench] = useState(false);
  const [deliveryNote, setDeliveryNote] = useState("");
  const [deliveryLinks, setDeliveryLinks] = useState("");
  const [deliveryTxHashes, setDeliveryTxHashes] = useState("");
  const [attachments, setAttachments] = useState<EvidenceAttachment[]>([]);
  const [evidenceError, setEvidenceError] = useState("");

  useEffect(() => {
    if (conversation) {
      setMessages(readMessages(conversation.job.jobId));
      const nextSubmissions = readEvidence(conversation.job.jobId);
      setSubmissions(nextSubmissions);
      setShowWorkbench(nextSubmissions.length > 0);
    } else {
      setMessages([]);
      setSubmissions([]);
      setShowWorkbench(false);
    }
    setDraft("");
    setDeliveryNote("");
    setDeliveryLinks("");
    setDeliveryTxHashes("");
    setAttachments([]);
    setEvidenceError("");
  }, [conversation?.job.jobId]);

  if (!conversation) {
    return (
      <InteractiveShell as="section" className="chat-thread card" spotlight>
        <div className="thread-placeholder">
          <MessageCircle size={30} />
          <h2>Select a chat</h2>
          <p>Open a claimed job to see its private conversation.</p>
        </div>
      </InteractiveShell>
    );
  }

  const { claim, job } = conversation;
  const readOnly = isConversationReadOnly(job, claim);
  const readOnlyCopy = conversationLockCopy(job, claim);
  const selectedForHire = isSelectedForHire(job, claim);
  const canReviewHireDraft = Boolean(identity && job.status === "awaiting-freelancer-signature" && selectedForHire);
  const canSubmitEvidence = job.status === "hired" && selectedForHire;
  const showEvidenceSection = selectedForHire || submissions.length > 0;

  function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (readOnly) return;
    const content = draft.trim();
    if (!content) return;
    const next = appendMessage({
      id: window.crypto.randomUUID(),
      jobId: job.jobId,
      sender: "freelancer",
      content,
      createdAt: Date.now(),
    });
    setMessages(next);
    setDraft("");
  }

  function handleAttachmentPick(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []).map<EvidenceAttachment>((file) => ({
      name: file.name,
      size: file.size,
      mimeType: file.type,
      kind: file.type.startsWith("image/") || file.type.startsWith("video/") || file.type.startsWith("audio/") ? "media" : "file",
    }));
    setAttachments(picked);
    event.currentTarget.value = "";
  }

  function parseMultilineEntries(value: string) {
    return value
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function handleEvidenceSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmitEvidence) {
      setEvidenceError("Work can only be submitted after escrow is locked.");
      return;
    }

    const links = parseMultilineEntries(deliveryLinks);
    const txHashes = parseMultilineEntries(deliveryTxHashes);
    const invalidLink = links.find((link) => {
      try {
        const parsed = new URL(link);
        return parsed.protocol !== "http:" && parsed.protocol !== "https:";
      } catch {
        return true;
      }
    });
    if (invalidLink) {
      setEvidenceError(`"${invalidLink}" is not a valid URL.`);
      return;
    }

    const invalidTxHash = txHashes.find((hash) => !/^0x[0-9a-fA-F]{64}$/.test(hash));
    if (invalidTxHash) {
      setEvidenceError(`"${invalidTxHash}" is not a valid transaction hash.`);
      return;
    }

    const note = deliveryNote.trim();
    if (!note && links.length === 0 && txHashes.length === 0 && attachments.length === 0) {
      setEvidenceError("Add a note, a URL, a tx hash, or at least one attachment before sending.");
      return;
    }

    const submission: EvidenceSubmission = {
      id: window.crypto.randomUUID(),
      jobId: job.jobId,
      note,
      links,
      txHashes,
      attachments,
      createdAt: Date.now(),
    };
    const nextSubmissions = saveEvidenceSubmission(submission);
    const nextMessages = appendMessage({
      id: window.crypto.randomUUID(),
      jobId: job.jobId,
      sender: "freelancer",
      content: `Submitted evidence update: ${summarizeEvidence(submission)}.${note ? ` Note: ${note}` : ""}`,
      createdAt: submission.createdAt,
    });

    setSubmissions(nextSubmissions);
    setMessages(nextMessages);
    setShowWorkbench(true);
    setDeliveryNote("");
    setDeliveryLinks("");
    setDeliveryTxHashes("");
    setAttachments([]);
    setEvidenceError("");
  }

  return (
    <InteractiveShell as="section" className="chat-thread card" spotlight>
      <header className="chat-header">
        <div className="chat-header-main">
          {showBack && (
            <button className="icon-button mobile-back" type="button" onClick={onBack} title="Back to chats">
              <ArrowLeft size={18} />
            </button>
          )}
          <span className="avatar">
            <UserRound size={17} />
          </span>
          <div>
            <strong>{job.title}</strong>
            <small>{lifecycleCopy(job, messages)}</small>
          </div>
        </div>
        <StatusPill status={job.status} />
      </header>

      <div className={`escrow-line ${isEscrowLocked(job.status) ? "is-locked" : ""}`}>
        {isEscrowLocked(job.status) ? <CheckCircle2 size={16} /> : <Clock3 size={16} />}
        <span>{escrowLine(job)}</span>
      </div>

      {readOnlyCopy && <InlineNotice icon={<LockKeyhole size={17} />} text={readOnlyCopy} />}

      {canReviewHireDraft && identity && (
        <HireDraftPanel
          identity={identity}
          job={job}
          onCountersigned={setMessages}
          onNavigate={onNavigate}
          onRefreshJobs={onRefreshJobs}
        />
      )}

      {showEvidenceSection && (
        <section className="workflow-panel">
          <div className="workflow-heading">
            <p className="eyebrow">Work delivery</p>
            <h2>{job.status === "hired" ? "Submit proof through your port." : "Delivery history"}</h2>
            <p className="support-copy">
              {job.status === "hired"
                ? "Share URLs, tx hashes, files, and media in the same private thread where terms were agreed."
                : "Evidence stays attached to this private port record alongside the signed conversation."}
            </p>
          </div>

          {job.status === "awaiting-freelancer-signature" && selectedForHire && (
            <InlineNotice
              icon={<LockKeyhole size={17} />}
              text="Start work only appears after you countersign and escrow is locked."
            />
          )}

          {job.status === "hired" && selectedForHire && !showWorkbench && submissions.length === 0 && (
            <MagneticButton className="primary-button" type="button" onClick={() => setShowWorkbench(true)}>
              <BriefcaseBusiness size={18} />
              Start work
            </MagneticButton>
          )}

          {(submissions.length > 0 || job.status === "approved" || job.status === "settled" || showWorkbench) && (
            <EvidenceTimeline submissions={submissions} />
          )}

          {job.status === "approved" && selectedForHire && (
            <InlineNotice icon={<CheckCircle2 size={17} />} text="Work is approved. New submissions are closed while payment releases." />
          )}

          {job.status === "settled" && selectedForHire && (
            <InlineNotice icon={<BadgeCheck size={17} />} text="This port is archived with your submitted evidence and final payment record." />
          )}

          {canSubmitEvidence && (showWorkbench || submissions.length > 0) && (
            <form className="evidence-form" onSubmit={handleEvidenceSubmit}>
              <label>
                <span>Delivery note</span>
                <textarea
                  value={deliveryNote}
                  onChange={(event) => setDeliveryNote(event.target.value)}
                  placeholder="Summarize what you delivered and anything the agent should check."
                  rows={4}
                />
              </label>
              <label>
                <span>URLs</span>
                <textarea
                  value={deliveryLinks}
                  onChange={(event) => setDeliveryLinks(event.target.value)}
                  placeholder="One URL per line"
                  rows={3}
                />
              </label>
              <label>
                <span>Transaction hashes</span>
                <textarea
                  value={deliveryTxHashes}
                  onChange={(event) => setDeliveryTxHashes(event.target.value)}
                  placeholder="One tx hash per line"
                  rows={3}
                />
              </label>
              <label>
                <span>Files or media</span>
                <input multiple onChange={handleAttachmentPick} type="file" />
              </label>
              {attachments.length > 0 && (
                <div className="attachment-list compact">
                  {attachments.map((attachment) => (
                    <div className="attachment-chip" key={`${attachment.name}-${attachment.size}`}>
                      {attachment.kind === "media" ? <FileImage size={15} /> : <FileText size={15} />}
                      <span>
                        <strong>{attachment.name}</strong>
                        <small>{formatFileSize(attachment.size)}</small>
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {evidenceError && <InlineNotice tone="error" icon={<AlertCircle size={17} />} text={evidenceError} />}
              <div className="workflow-actions">
                <MagneticButton className="primary-button" type="submit">
                  <FileUp size={18} />
                  Submit evidence
                </MagneticButton>
              </div>
            </form>
          )}
        </section>
      )}

      <div className="message-thread" aria-label="Conversation">
        {messages.map((message) => (
          <article className={`message-bubble ${message.sender}`} key={message.id}>
            <p>{message.content}</p>
            <time>{formatTime(message.createdAt)}</time>
          </article>
        ))}
      </div>

      <form className="chat-composer" onSubmit={sendMessage}>
        <input
          disabled={readOnly}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={readOnly ? "This port is read-only" : "Type a message"}
        />
        <button className="send-button" type="submit" disabled={readOnly || !draft.trim()}>
          <Send size={17} />
        </button>
      </form>
    </InteractiveShell>
  );
}

function ChatsView({
  jobs,
  claims,
  route,
  identity,
  onNavigate,
  onRefreshJobs,
}: {
  jobs: PublicJob[];
  claims: ClaimRecord[];
  route: Route;
  identity: DemoIdentity | null;
  onNavigate: (path: string) => void;
  onRefreshJobs: () => Promise<void> | void;
}) {
  const conversations = conversationsFrom(jobs, claims);
  const selectedConversation =
    route.name === "chat" ? conversations.find((item) => item.job.jobId === route.jobId) : conversations[0];

  if (conversations.length === 0) {
    return (
      <main className="page-grid">
        <EmptyState
          icon={<MessageCircle size={26} />}
          title="No chats yet"
          body="Claim a job to open your first private conversation."
          action={
            <MagneticButton className="primary-button" type="button" onClick={() => onNavigate("/jobs")}>
              Browse jobs
            </MagneticButton>
          }
        />
      </main>
    );
  }

  return (
    <main className={`chat-page ${route.name === "chat" ? "mobile-thread-open" : ""}`}>
      <Reveal className="grid-reveal">
        <InteractiveShell as="aside" className="chat-sidebar card" spotlight>
          <div className="sidebar-header">
            <div>
              <p className="eyebrow">Chats</p>
              <h1>Your inbox</h1>
            </div>
          </div>
          <div className="chat-list">
            {conversations.map(({ claim, job, messages }) => {
              const latest = messages.at(-1);
              const isActive = selectedConversation?.job.jobId === job.jobId;
              return (
                <button
                  className={`chat-row ${isActive ? "active" : ""}`}
                  type="button"
                  key={claim.jobId}
                  onClick={() => onNavigate(`/chats/${job.jobId}`)}
                >
                  <span className="avatar">
                    <UserRound size={17} />
                  </span>
                  <span className="chat-row-main">
                    <strong>{job.title}</strong>
                    <small>{lifecycleCopy(job, messages)}</small>
                  </span>
                  <span className="chat-row-side">
                    <StatusPill status={job.status} />
                    <small>{formatTime(latest?.createdAt ?? claim.claimedAt)}</small>
                  </span>
                </button>
              );
            })}
          </div>
        </InteractiveShell>
      </Reveal>

      <Reveal className="grid-reveal">
        <ChatThread
          conversation={selectedConversation}
          identity={identity}
          onBack={() => onNavigate("/chats")}
          onNavigate={onNavigate}
          onRefreshJobs={onRefreshJobs}
          showBack={route.name === "chat"}
        />
      </Reveal>
    </main>
  );
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute());
  const [jobs, setJobs] = useState<PublicJob[]>([]);
  const [claims, setClaims] = useState<ClaimRecord[]>(() => readClaims());
  const [identity, setIdentity] = useState<DemoIdentity | null>(() => readIdentity());
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [error, setError] = useState("");

  function navigate(path: string) {
    startTransition(() => {
      window.history.pushState({}, "", path);
      setRoute(parseRoute());
    });
  }

  async function refreshJobs() {
    setLoadState("loading");
    setError("");
    try {
      const nextJobs = await listJobs();
      setJobs(nextJobs.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)));
      setLoadState("ready");
    } catch (caught) {
      setLoadState("error");
      setError(caught instanceof Error ? caught.message : "Could not load jobs");
    }
  }

  function handleClaimed(job: PublicJob, claim: ClaimRecord) {
    seedConversation(job, claim);
    setClaims(saveClaim(claim));
    navigate(`/chats/${job.jobId}`);
  }

  useEffect(() => {
    void refreshJobs();
  }, []);

  useEffect(() => {
    const onPopState = () => startTransition(() => setRoute(parseRoute()));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const activeJob = "jobId" in route ? jobs.find((job) => job.jobId === route.jobId) : undefined;

  return (
    <div className="app-shell">
      {route.name !== "landing" && <AppHeader route={route} identity={identity} chatCount={claims.length} onNavigate={navigate} />}

      {route.name === "landing" && <LandingPage jobs={jobs} claims={claims} identity={identity} onNavigate={navigate} />}
      {route.name === "home" && <HomeView jobs={jobs} claims={claims} identity={identity} onNavigate={navigate} />}
      {route.name === "jobs" && <JobsView jobs={jobs} loadState={loadState} error={error} onRefresh={refreshJobs} onNavigate={navigate} />}
      {route.name === "job" && (
        <JobDetailView
          job={activeJob}
          claims={claims}
          loadState={loadState}
          identity={identity}
          onNavigate={navigate}
          onClaimed={handleClaimed}
          onRefresh={refreshJobs}
        />
      )}
      {(route.name === "chats" || route.name === "chat") && (
        <ChatsView jobs={jobs} claims={claims} identity={identity} route={route} onNavigate={navigate} onRefreshJobs={refreshJobs} />
      )}
      {route.name === "signin" && <SignInView identity={identity} onSignedIn={setIdentity} onNavigate={navigate} />}
      {route.name === "settings" && (
        <SettingsView identity={identity} jobs={jobs} claims={claims} onNavigate={navigate} onIdentityChange={setIdentity} />
      )}
    </div>
  );
}
