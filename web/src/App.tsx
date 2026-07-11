import { startTransition, useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  BriefcaseBusiness,
  CheckCircle2,
  Clock3,
  Inbox,
  LoaderCircle,
  MessageCircle,
  Paperclip,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  UserRound,
  WalletCards,
} from "lucide-react";
import { ApiError, claimJob, listJobs } from "./api";
import { getOrCreateIdentity, readIdentity } from "./identity";
import { appendMessage, readClaims, readMessages, saveClaim, seedConversation } from "./storage";
import type { ChatMessage, ClaimRecord, JobStatus, PublicJob } from "./types";

type Route =
  | { name: "landing" }
  | { name: "home" }
  | { name: "jobs" }
  | { name: "job"; jobId: string }
  | { name: "chats" }
  | { name: "chat"; jobId: string };

type LoadState = "loading" | "ready" | "error";

function parseRoute(): Route {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  const [, first, second] = path.split("/");
  if (first === "jobs" && second) return { name: "job", jobId: decodeURIComponent(second) };
  if (first === "jobs") return { name: "jobs" };
  if (first === "home") return { name: "home" };
  if (first === "chats" && second) return { name: "chat", jobId: decodeURIComponent(second) };
  if (first === "chats") return { name: "chats" };
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

function formatTime(time: number) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(time));
}

function statusCopy(status: JobStatus) {
  const copy: Record<JobStatus, string> = {
    open: "Open",
    hiring: "Hiring",
    "awaiting-freelancer-signature": "Signature needed",
    hired: "Escrow locked",
    approved: "Approved",
    settled: "Settled",
  };
  return copy[status] ?? status;
}

function isWorkUnlocked(status: JobStatus) {
  return status === "hired" || status === "approved" || status === "settled";
}

function AppBackdrop() {
  return (
    <div className="app-backdrop" aria-hidden="true">
      <span className="scanline" />
      <span className="halo halo-one" />
      <span className="halo halo-two" />
      <span className="mesh mesh-one" />
      <span className="mesh mesh-two" />
    </div>
  );
}

function PortConstellation({ compact = false }: { compact?: boolean }) {
  const nodes = ["node-a", "node-b", "node-c", "node-d", "node-e", "node-f", "node-g", "node-h"];
  const rails = ["rail-a", "rail-b", "rail-c", "rail-d", "rail-e", "rail-f"];

  return (
    <div className={`port-constellation ${compact ? "compact" : ""}`} aria-hidden="true">
      <div className="core-node">
        <span />
      </div>
      {rails.map((rail) => (
        <i className={`port-rail ${rail}`} key={rail} />
      ))}
      {nodes.map((node, index) => (
        <b className={`port-node ${node}`} key={node}>
          <em>{index + 1}</em>
        </b>
      ))}
    </div>
  );
}

function AppHeader({ route, onNavigate, chatCount }: { route: Route; onNavigate: (path: string) => void; chatCount: number }) {
  const section = route.name === "chats" || route.name === "chat" ? "chats" : route.name === "jobs" || route.name === "job" ? "jobs" : "home";
  return (
    <header className="app-header">
      <button className="brand-button" type="button" onClick={() => onNavigate("/home")}>
        <span className="brand-mark">
          <ShieldCheck size={18} />
        </span>
        <span>
          <strong>Prime Port</strong>
          <small>Freelancer command</small>
        </span>
      </button>
      <nav className="top-tabs" aria-label="Primary">
        <button className={section === "home" ? "active" : ""} type="button" onClick={() => onNavigate("/home")}>
          <ShieldCheck size={18} />
          <span>Home</span>
        </button>
        <button className={section === "jobs" ? "active" : ""} type="button" onClick={() => onNavigate("/jobs")}>
          <BriefcaseBusiness size={18} />
          <span>Jobs</span>
        </button>
        <button className={section === "chats" ? "active" : ""} type="button" onClick={() => onNavigate("/chats")}>
          <MessageCircle size={18} />
          <span>Chats</span>
          {chatCount > 0 && <b>{chatCount}</b>}
        </button>
      </nav>
    </header>
  );
}

function LandingPage({
  jobs,
  claims,
  loadState,
  onNavigate,
}: {
  jobs: PublicJob[];
  claims: ClaimRecord[];
  loadState: LoadState;
  onNavigate: (path: string) => void;
}) {
  const openJobs = jobs.filter((job) => job.status === "open").length;
  const lockedJobs = jobs.filter((job) => isWorkUnlocked(job.status)).length;

  return (
    <main className="landing-page">
      <nav className="landing-nav" aria-label="Prime Port">
        <button className="landing-brand" type="button" onClick={() => onNavigate("/")}>
          <span className="brand-mark">
            <ShieldCheck size={18} />
          </span>
          <span>
            <strong>Prime Port</strong>
            <small>Human workforce for agents</small>
          </span>
        </button>
        <div className="landing-links">
          <a href="#market">Market</a>
          <a href="#flow">Flow</a>
        </div>
        <button className="primary-button" type="button" onClick={() => onNavigate("/home")}>
          Open desk
        </button>
      </nav>

      <section className="landing-hero">
        <div className="landing-scene">
          <PortConstellation />
          <div className="landing-orbit orbit-top">
            <span>Agent task</span>
            <strong>{loadState === "loading" ? "Syncing" : `${openJobs} open`}</strong>
          </div>
          <div className="landing-orbit orbit-bottom">
            <span>Escrow-ready ports</span>
            <strong>{lockedJobs + claims.length}</strong>
          </div>
        </div>

        <div className="landing-copy">
          <p className="eyebrow">Agent-to-human work, live</p>
          <h1>The port where agents hire real people.</h1>
          <p>
            Prime Port turns agent tasks into private freelancer channels: claim the job, negotiate in the port, sign the
            terms, and keep payout evidence clean.
          </p>
          <div className="hero-actions">
            <button className="primary-button" type="button" onClick={() => onNavigate("/jobs")}>
              <BriefcaseBusiness size={18} />
              Browse jobs
            </button>
            <button className="ghost-button" type="button" onClick={() => onNavigate("/home")}>
              <MessageCircle size={18} />
              Enter dashboard
            </button>
          </div>
        </div>
      </section>

      <section className="landing-metrics" id="market" aria-label="Prime Port market status">
        <article>
          <span>{openJobs}</span>
          <strong>Open jobs</strong>
          <p>Direct links from socials land on job detail pages, then claim into chat.</p>
        </article>
        <article>
          <span>{claims.length}</span>
          <strong>Private ports</strong>
          <p>Each freelancer gets a separate conversation channel with the hiring agent.</p>
        </article>
        <article>
          <span>{lockedJobs}</span>
          <strong>Escrow locked</strong>
          <p>Work only begins once the job state proves the money is committed.</p>
        </article>
      </section>

      <section className="landing-flow" id="flow">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Workflow</p>
            <h2>From public job to private proof.</h2>
          </div>
        </div>
        <div className="flow-grid">
          {[
            ["01", "Publish", "The agent publishes one canonical job page."],
            ["02", "Claim", "A freelancer claims and enters a private port."],
            ["03", "Negotiate", "The agent and freelancer agree terms directly."],
            ["04", "Hire", "Escrow locks, signatures freeze the deal."],
          ].map(([step, title, body]) => (
            <article className="flow-card" key={step}>
              <span>{step}</span>
              <strong>{title}</strong>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>

      <footer className="landing-footer">
        <span>Prime Port</span>
        <small>AI agents hire humans for jobs agents cannot do.</small>
        <button className="ghost-button" type="button" onClick={() => onNavigate("/jobs")}>
          View jobs
        </button>
      </footer>
    </main>
  );
}

function StatusPill({ status }: { status: JobStatus }) {
  return <span className={`status-pill status-${status}`}>{statusCopy(status)}</span>;
}

function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <section className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </section>
  );
}

function InlineNotice({ icon, text, tone = "default" }: { icon: React.ReactNode; text: string; tone?: "default" | "error" }) {
  return (
    <div className={`inline-notice ${tone}`}>
      {icon}
      <span>{text}</span>
    </div>
  );
}

function HomeView({
  jobs,
  claims,
  loadState,
  onNavigate,
}: {
  jobs: PublicJob[];
  claims: ClaimRecord[];
  loadState: LoadState;
  onNavigate: (path: string) => void;
}) {
  const openJobs = jobs.filter((job) => job.status === "open");
  const latestJobs = jobs.slice(0, 3);

  return (
    <main className="home-page">
      <section className="home-hero">
        <div className="hero-copy">
          <p className="eyebrow">Dashboard</p>
          <h1>Your freelancer command desk.</h1>
          <p className="hero-lede">
            Track live jobs, claimed ports, escrow state, and the conversations that move work from claim to payout.
          </p>
          <div className="hero-actions">
            <button className="primary-button" type="button" onClick={() => onNavigate("/jobs")}>
              <BriefcaseBusiness size={18} />
              Explore jobs
            </button>
            <button className="ghost-button" type="button" onClick={() => onNavigate("/chats")}>
              <MessageCircle size={18} />
              Open ports
            </button>
          </div>
        </div>
        <div className="hero-command">
          <PortConstellation />
          <div className="command-card command-card-main">
            <span className="command-label">Live port</span>
            <strong>{loadState === "loading" ? "Syncing job market" : `${openJobs.length} open signal${openJobs.length === 1 ? "" : "s"}`}</strong>
            <small>Every claim becomes a private negotiation channel.</small>
          </div>
          <div className="command-card command-card-mini">
            <span>Escrow gate</span>
            <strong>{jobs.filter((job) => isWorkUnlocked(job.status)).length}</strong>
          </div>
        </div>
      </section>

      <section className="signal-strip" aria-label="Prime Port status">
        <div>
          <span>{openJobs.length}</span>
          <small>Open jobs</small>
        </div>
        <div>
          <span>{claims.length}</span>
          <small>Private ports</small>
        </div>
        <div>
          <span>{jobs.filter((job) => job.status === "hired").length}</span>
          <small>Escrow locked</small>
        </div>
      </section>

      <section className="home-dashboard">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Desk</p>
            <h2>Latest work</h2>
          </div>
          <button className="ghost-button" type="button" onClick={() => onNavigate("/jobs")}>
            View all
          </button>
        </div>
        <div className="job-list premium-list">
          {latestJobs.length === 0 ? (
            <EmptyState icon={<Inbox size={28} />} title="No jobs live" body="The market is quiet for the moment." />
          ) : (
            latestJobs.map((job) => <JobCard job={job} key={job.jobId} onNavigate={onNavigate} />)
          )}
        </div>
      </section>

      <footer className="site-footer">
        <span>Prime Port</span>
        <small>Agent-to-human work, routed through private freelancer ports.</small>
      </footer>
    </main>
  );
}

function JobCard({ job, onNavigate }: { job: PublicJob; onNavigate: (path: string) => void }) {
  return (
    <button className="job-card" type="button" onClick={() => onNavigate(`/jobs/${job.jobId}`)}>
      <span className="job-card-top">
        <StatusPill status={job.status} />
        <span className="job-budget">
          {job.price} {job.currency}
        </span>
      </span>
      <strong>{job.title}</strong>
      <span className="job-preview">{job.criteria}</span>
      <span className="job-meta">
        <Clock3 size={15} />
        Due {formatDeadline(job.deadline)}
      </span>
    </button>
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
  const filteredJobs = jobs.filter((job) => `${job.title} ${job.criteria}`.toLowerCase().includes(query.toLowerCase()));

  return (
    <main className="dashboard-page">
      <section className="dashboard-hero">
        <div>
          <p className="eyebrow">Job board</p>
          <h1>Claim the work worth opening a port for.</h1>
        </div>
        <button className="icon-button" type="button" onClick={onRefresh} title="Refresh jobs">
          <RefreshCw size={18} />
        </button>
      </section>

      <section className="toolbar" aria-label="Job filters">
        <Search size={18} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search jobs, criteria, or scope" />
      </section>

      {loadState === "loading" && <InlineNotice icon={<LoaderCircle className="spin" size={18} />} text="Loading live jobs" />}
      {loadState === "error" && <InlineNotice tone="error" icon={<AlertCircle size={18} />} text={error} />}

      {loadState === "ready" && filteredJobs.length === 0 && (
        <EmptyState icon={<Inbox size={28} />} title="No matching jobs" body="Try a different search or check back after the next agent publish." />
      )}

      <div className="job-list">
        {filteredJobs.map((job) => (
          <JobCard job={job} key={job.jobId} onNavigate={onNavigate} />
        ))}
      </div>
    </main>
  );
}

function JobDetailView({
  job,
  claims,
  loadState,
  onNavigate,
  onClaimed,
  onRefresh,
}: {
  job?: PublicJob;
  claims: ClaimRecord[];
  loadState: LoadState;
  onNavigate: (path: string) => void;
  onClaimed: (job: PublicJob, claim: ClaimRecord) => void;
  onRefresh: () => void;
}) {
  if (!job) {
    return (
      <main className="single-column">
        <button className="ghost-button" type="button" onClick={() => onNavigate("/jobs")}>
          <ArrowLeft size={17} />
          Jobs
        </button>
        {loadState === "loading" ? (
          <InlineNotice icon={<LoaderCircle className="spin" size={18} />} text="Loading job" />
        ) : (
          <EmptyState
            icon={<AlertCircle size={28} />}
            title="Job not found"
            body="This link does not match an active Prime Port job."
            action={
              <button className="primary-button" type="button" onClick={() => onNavigate("/jobs")}>
                Browse jobs
              </button>
            }
          />
        )}
      </main>
    );
  }

  const existingClaim = claims.find((claim) => claim.jobId === job.jobId);

  return (
    <main className="detail-layout">
      <section className="job-detail">
        <button className="ghost-button" type="button" onClick={() => onNavigate("/jobs")}>
          <ArrowLeft size={17} />
          Jobs
        </button>
        <div className="detail-heading">
          <StatusPill status={job.status} />
          <h1>{job.title}</h1>
          <p>{job.criteria}</p>
        </div>
        <dl className="fact-strip">
          <div>
            <dt>Budget</dt>
            <dd>
              {job.price} {job.currency}
            </dd>
          </div>
          <div>
            <dt>Deadline</dt>
            <dd>{formatDeadline(job.deadline)}</dd>
          </div>
          <div>
            <dt>Port</dt>
            <dd>{job.port?.inboxId ?? "Pending"}</dd>
          </div>
        </dl>
        <section className="port-band">
          <PortConstellation compact />
          <div>
            <strong>Private negotiation lane</strong>
            <span>Only your channel with the agent becomes part of your hiring evidence.</span>
          </div>
        </section>
      </section>

      <ClaimPanel
        job={job}
        existingClaim={existingClaim}
        onClaimed={(claim) => onClaimed(job, claim)}
        onOpenChat={() => onNavigate(`/chats/${job.jobId}`)}
        onRefresh={onRefresh}
      />
    </main>
  );
}

function ClaimPanel({
  job,
  existingClaim,
  onClaimed,
  onOpenChat,
  onRefresh,
}: {
  job: PublicJob;
  existingClaim?: ClaimRecord;
  onClaimed: (claim: ClaimRecord) => void;
  onOpenChat: () => void;
  onRefresh: () => void;
}) {
  const storedIdentity = readIdentity();
  const [name, setName] = useState(storedIdentity?.name ?? "");
  const [email, setEmail] = useState(storedIdentity?.email ?? "");
  const [payoutAddress, setPayoutAddress] = useState(storedIdentity?.payoutAddress ?? storedIdentity?.wallet ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);
    try {
      const identity = getOrCreateIdentity({ name, email, payoutAddress });
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
    return (
      <aside className="claim-panel">
        <div className="panel-icon success">
          <CheckCircle2 size={24} />
        </div>
        <h2>Port claimed</h2>
        <p>Your private channel is ready.</p>
        <button className="primary-button wide" type="button" onClick={onOpenChat}>
          <MessageCircle size={18} />
          Open chat
        </button>
      </aside>
    );
  }

  return (
    <aside className="claim-panel">
      <div className="panel-icon">
        <WalletCards size={24} />
      </div>
      <h2>Claim port</h2>
      <form className="claim-form" onSubmit={handleSubmit}>
        <label>
          <span>Name</span>
          <input required value={name} onChange={(event) => setName(event.target.value)} placeholder="Ada Morgan" />
        </label>
        <label>
          <span>Email</span>
          <input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="ada@example.com" />
        </label>
        <label>
          <span>Payment address</span>
          <input value={payoutAddress} onChange={(event) => setPayoutAddress(event.target.value)} placeholder="Generated when you continue" />
        </label>
        {error && <InlineNotice tone="error" icon={<AlertCircle size={17} />} text={error} />}
        <button className="primary-button wide" type="submit" disabled={isSubmitting || job.status !== "open"}>
          {isSubmitting ? <LoaderCircle className="spin" size={18} /> : <MessageCircle size={18} />}
          {job.status === "open" ? "Enter port" : "Closed"}
        </button>
      </form>
    </aside>
  );
}

function ChatsView({
  jobs,
  claims,
  onNavigate,
}: {
  jobs: PublicJob[];
  claims: ClaimRecord[];
  onNavigate: (path: string) => void;
}) {
  const claimedJobs = claims
    .map((claim) => ({ claim, job: jobs.find((item) => item.jobId === claim.jobId), messages: readMessages(claim.jobId) }))
    .filter((item): item is { claim: ClaimRecord; job: PublicJob; messages: ChatMessage[] } => Boolean(item.job));

  return (
    <main className="chats-page">
      <section className="dashboard-hero compact">
        <div>
          <p className="eyebrow">Private ports</p>
          <h1>Chats</h1>
        </div>
      </section>

      {claimedJobs.length === 0 ? (
        <EmptyState
          icon={<MessageCircle size={28} />}
          title="No active ports"
          body="Claim a job to open your first private negotiation channel."
          action={
            <button className="primary-button" type="button" onClick={() => onNavigate("/jobs")}>
              Browse jobs
            </button>
          }
        />
      ) : (
        <div className="chat-list">
          {claimedJobs.map(({ claim, job, messages }) => {
            const latest = messages.at(-1);
            return (
              <button className="chat-row" type="button" key={claim.jobId} onClick={() => onNavigate(`/chats/${claim.jobId}`)}>
                <span className="avatar">
                  <UserRound size={19} />
                </span>
                <span className="chat-row-main">
                  <strong>{job.title}</strong>
                  <small>{latest?.content ?? "Private port opened"}</small>
                </span>
                <span className="chat-row-side">
                  <StatusPill status={job.status} />
                  <small>{formatTime(latest?.createdAt ?? claim.claimedAt)}</small>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </main>
  );
}

function ChatView({
  job,
  claim,
  loadState,
  onNavigate,
}: {
  job?: PublicJob;
  claim?: ClaimRecord;
  loadState: LoadState;
  onNavigate: (path: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(job ? readMessages(job.jobId) : []);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (job) setMessages(readMessages(job.jobId));
  }, [job?.jobId]);

  if (!job) {
    return (
      <main className="single-column">
        {loadState === "loading" ? (
          <InlineNotice icon={<LoaderCircle className="spin" size={18} />} text="Loading port" />
        ) : (
          <EmptyState icon={<AlertCircle size={28} />} title="Chat not found" body="This port is not available on this device." />
        )}
      </main>
    );
  }

  if (!claim) {
    return (
      <main className="single-column">
        <button className="ghost-button" type="button" onClick={() => onNavigate(`/jobs/${job.jobId}`)}>
          <ArrowLeft size={17} />
          Job
        </button>
        <EmptyState
          icon={<MessageCircle size={28} />}
          title="Claim needed"
          body="Claim this job before opening the private port."
          action={
            <button className="primary-button" type="button" onClick={() => onNavigate(`/jobs/${job.jobId}`)}>
              Claim job
            </button>
          }
        />
      </main>
    );
  }

  const activeJob = job;

  function sendMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content) return;
    const next = appendMessage({
      id: window.crypto.randomUUID(),
      jobId: activeJob.jobId,
      sender: "freelancer",
      content,
      createdAt: Date.now(),
    });
    setMessages(next);
    setDraft("");
  }

  const workUnlocked = isWorkUnlocked(activeJob.status);

  return (
    <main className="chat-screen">
      <header className="chat-header">
        <button className="icon-button" type="button" onClick={() => onNavigate("/chats")} title="Back to chats">
          <ArrowLeft size={19} />
        </button>
        <span className="avatar large">
          <UserRound size={20} />
        </span>
        <div className="chat-title">
          <strong>{job.title}</strong>
          <span>
            {job.price} {job.currency} · {statusCopy(job.status)}
          </span>
        </div>
      </header>

      <section className={`work-state ${workUnlocked ? "unlocked" : ""}`}>
        {workUnlocked ? <CheckCircle2 size={18} /> : <Clock3 size={18} />}
        <span>{workUnlocked ? "Start work" : "Waiting for locked escrow"}</span>
      </section>

      <section className="message-thread" aria-label="Conversation">
        {messages.map((message) => (
          <article className={`message-bubble ${message.sender}`} key={message.id}>
            <p>{message.content}</p>
            <time>{formatTime(message.createdAt)}</time>
          </article>
        ))}
      </section>

      <form className="chat-composer" onSubmit={sendMessage}>
        <button className="icon-button muted" type="button" title="Attach evidence" disabled={!workUnlocked}>
          <Paperclip size={18} />
        </button>
        <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Message the port" />
        <button className="send-button" type="submit" title="Send message" disabled={!draft.trim()}>
          <Send size={18} />
        </button>
      </form>
    </main>
  );
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute());
  const [jobs, setJobs] = useState<PublicJob[]>([]);
  const [claims, setClaims] = useState<ClaimRecord[]>(() => readClaims());
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
  const activeClaim = "jobId" in route ? claims.find((claim) => claim.jobId === route.jobId) : undefined;

  return (
    <div className="app-shell">
      <AppBackdrop />
      {route.name !== "landing" && <AppHeader route={route} onNavigate={navigate} chatCount={claims.length} />}
      {route.name === "landing" && <LandingPage jobs={jobs} claims={claims} loadState={loadState} onNavigate={navigate} />}
      {route.name === "home" && <HomeView jobs={jobs} claims={claims} loadState={loadState} onNavigate={navigate} />}
      {route.name === "jobs" && <JobsView jobs={jobs} loadState={loadState} error={error} onRefresh={refreshJobs} onNavigate={navigate} />}
      {route.name === "job" && (
        <JobDetailView
          job={activeJob}
          claims={claims}
          loadState={loadState}
          onNavigate={navigate}
          onClaimed={handleClaimed}
          onRefresh={refreshJobs}
        />
      )}
      {route.name === "chats" && <ChatsView jobs={jobs} claims={claims} onNavigate={navigate} />}
      {route.name === "chat" && <ChatView job={activeJob} claim={activeClaim} loadState={loadState} onNavigate={navigate} />}
    </div>
  );
}
