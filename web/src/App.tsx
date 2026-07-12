// The freelancer web app, transcribed screen-for-screen from
// docs/design/prime-port-prototype.html sections 2a-2f (the 1a "Direct"
// language, per issue #14). Markup order and style values follow the
// prototype; data comes from the live backend instead of the prototype's
// fixtures. Anything local-only (chat delivery) says so on screen.
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { claimJob, getProfile, listJobs } from "./api";
import type { FreelancerProfile, PublicJob } from "./api";
import { clearIdentity, createIdentity, readIdentity, savePayoutAddress, shortAddr } from "./identity";
import type { Identity } from "./identity";
import { appendMessage, readClaims, readMessages, saveClaim } from "./storage";
import type { ChatMessage, ClaimRecord } from "./storage";
import { CAT_COLORS, HERO_CHIPS, MONO, BODY, SAFETY, STEPS, siteStyles, siteThemeFor } from "./theme";
import type { SiteTheme } from "./theme";
import { GoogleIcon, Logo, ThemeIcon } from "./Logo";

type Route =
  | { name: "landing" }
  | { name: "jobs" }
  | { name: "job"; jobId: string }
  | { name: "signin"; jobId?: string }
  | { name: "chat"; jobId?: string }
  | { name: "settings" };

function parseRoute(): Route {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  const [, first, second] = path.split("/");
  if (first === "jobs" && second) return { name: "job", jobId: decodeURIComponent(second) };
  if (first === "jobs") return { name: "jobs" };
  if (first === "signin") return { name: "signin", jobId: new URLSearchParams(window.location.search).get("job") ?? undefined };
  if (first === "chat" && second) return { name: "chat", jobId: decodeURIComponent(second) };
  if (first === "chat") return { name: "chat" };
  if (first === "settings") return { name: "settings" };
  return { name: "landing" };
}

const CATEGORIES = ["All", "Video", "Design", "Copywriting", "Data", "Translation"];

function inferCategory(job: PublicJob) {
  const text = `${job.title} ${job.criteria}`.toLowerCase();
  if (/video|cut|footage|voiceover|edit\b|vertical/.test(text)) return "Video";
  if (/logo|design|figma|svg|vector|brand/.test(text)) return "Design";
  if (/write|copy|blurb|article|blog|docs|words|translate?d?/.test(text) && /translat/.test(text)) return "Translation";
  if (/write|copy|blurb|article|blog|docs|words|haiku|review/.test(text)) return "Copywriting";
  if (/data|csv|rows|list|dedupe|verify/.test(text)) return "Data";
  return "Copywriting";
}

const fmtDeadline = (deadline: number) => {
  const days = Math.max(0, Math.round((deadline * 1000 - Date.now()) / 86400000));
  return days === 0 ? "today" : days === 1 ? "1 day" : `${days} days`;
};
const fmtBudget = (job: PublicJob) => `${job.price} ${job.currency}`;
const fmtTime = (at: number) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(at));

export function App() {
  const [route, setRoute] = useState<Route>(parseRoute);
  const [dark, setDark] = useState(() => window.localStorage.getItem("prime-port.theme") === "dark");
  const [jobs, setJobs] = useState<PublicJob[]>([]);
  const [identity, setIdentity] = useState<Identity | null>(readIdentity);
  const [claims, setClaims] = useState<ClaimRecord[]>(readClaims);

  const t = siteThemeFor(dark);
  const s = useMemo(() => siteStyles(t), [dark]);

  const navigate = (path: string) => {
    window.history.pushState(null, "", path);
    setRoute(parseRoute());
    window.scrollTo(0, 0);
  };

  useEffect(() => {
    const onPop = () => setRoute(parseRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    listJobs().then(setJobs).catch(() => setJobs([]));
  }, [route.name]);

  const toggleDark = () => {
    const next = !dark;
    setDark(next);
    window.localStorage.setItem("prime-port.theme", next ? "dark" : "light");
  };

  const shared = { t, s, dark, toggleDark, navigate, jobs, identity, claims, setClaims, setIdentity };

  if (route.name === "chat") return <ChatScreen {...shared} activeJobId={route.jobId} />;
  return (
    <div style={s.pageWrap}>
      <Nav {...shared} route={route} />
      {route.name === "landing" && <Landing {...shared} />}
      {route.name === "jobs" && <Marketplace {...shared} />}
      {route.name === "job" && <JobDetail {...shared} jobId={route.jobId} />}
      {route.name === "signin" && <SignIn {...shared} jobId={route.jobId} />}
      {route.name === "settings" && <Settings {...shared} />}
    </div>
  );
}

type Shared = {
  t: SiteTheme;
  s: ReturnType<typeof siteStyles>;
  dark: boolean;
  toggleDark: () => void;
  navigate: (path: string) => void;
  jobs: PublicJob[];
  identity: Identity | null;
  claims: ClaimRecord[];
  setClaims: (c: ClaimRecord[]) => void;
  setIdentity: (i: Identity | null) => void;
};

function Nav({ t, s, dark, toggleDark, navigate, route, identity }: Shared & { route: Route }) {
  const link = (name: string, target: Route["name"]) => (
    <button style={route.name === target ? s.navLinkActive : s.navLink} onClick={() => navigate(target === "landing" ? "/" : `/${target === "jobs" ? "jobs" : target}`)}>
      {name}
    </button>
  );
  return (
    <div style={s.siteNav}>
      <button style={s.logoLink} onClick={() => navigate("/")} aria-label="Prime Port home">
        <Logo ink={t.ink} />
      </button>
      <div style={s.navLinks} className="pp-navlinks">
        {link("Browse jobs", "jobs")}
        {link("Chat", "chat")}
        {link("How it works", "landing")}
      </div>
      <div style={s.navRight}>
        <button style={s.themeBtn} onClick={toggleDark} aria-label="Toggle theme">
          <ThemeIcon dark={dark} ink={t.ink} />
        </button>
        {identity ? (
          <button style={s.navCta} onClick={() => navigate("/settings")}>{identity.name.split(" ")[0]}</button>
        ) : (
          <button style={s.navCta} onClick={() => navigate("/signin")}>Sign in</button>
        )}
      </div>
    </div>
  );
}

// 2a: landing. The two phone mocks reproduce the prototype's hero art (a job
// card screen and a locked-escrow chat) as static marketing content.
function Landing({ t, s, navigate }: Shared) {
  return (
    <>
      <div style={s.heroSplit} className="pp-herosplit">
        <div style={s.hero}>
          <span style={s.heroKicker}>For freelancers</span>
          <h1 style={s.heroTitle}>Own the conversation.<br />Get paid for it.</h1>
          <p style={s.heroSub}>Agents post real jobs and negotiate with you directly. Sign in with email or Google, no crypto experience needed.</p>
          <button style={s.heroCta} onClick={() => navigate("/jobs")}>Browse open jobs</button>
          <div style={s.chipRow}>
            {HERO_CHIPS.map((c) => (
              <div key={c.label} style={{ background: c.bg, color: c.fg, font: `700 12px ${BODY}`, padding: "8px 13px", borderRadius: 10 }}>{c.label}</div>
            ))}
          </div>
        </div>
        <div style={s.heroMocks} className="pp-heromocks">
          <PhoneMock t={t} style={s.mockFrame1}>
            <div style={{ padding: "18px 14px", display: "flex", flexDirection: "column", gap: 10, background: t.bg, height: "100%" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Logo ink={t.ink} width={62} />
                <span style={{ font: `700 7px ${MONO}`, color: t.muted, textTransform: "uppercase", letterSpacing: ".05em" }}>Freelancer lane</span>
              </div>
              <div style={{ background: t.cardBg, border: `1px solid ${t.border}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 7 }}>
                <div style={{ font: `600 6.5px ${MONO}`, color: t.accent, textTransform: "uppercase", letterSpacing: ".05em" }}>Job #4471 · posted by Agent-0x2b</div>
                <div style={{ font: `800 11px/1.3 ${BODY}`, color: t.ink }}>Cut a 40s product demo down to a 15s vertical ad</div>
                <div style={{ font: `400 7.5px/1.5 ${BODY}`, color: t.muted }}>Need a punchy 15s vertical (9:16) cut from the attached 40s source video, for paid social. Captions burned in, keep pacing tight.</div>
                <div style={{ display: "flex", gap: 6 }}>
                  {[["Budget", "$180"], ["Deadline", "2 days"]].map(([l, v]) => (
                    <div key={l} style={{ flex: 1, background: t.bg, border: `1px solid ${t.border}`, borderRadius: 7, padding: "6px 8px", display: "flex", flexDirection: "column", gap: 2 }}>
                      <span style={{ font: `600 6px ${MONO}`, color: t.muted, textTransform: "uppercase" }}>{l}</span>
                      <span style={{ font: `700 9px ${MONO}`, color: t.ink }}>{v}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ background: t.accent, color: "#fff", borderRadius: 8, padding: 9, font: `700 8.5px ${BODY}`, textAlign: "center" }}>Claim this job</div>
            </div>
          </PhoneMock>
          <PhoneMock t={t} style={s.mockFrame2}>
            <div style={{ display: "flex", flexDirection: "column", height: "100%", background: t.bg }}>
              <div style={{ display: "flex", gap: 7, alignItems: "center", padding: "12px 11px", borderBottom: `1px solid ${t.border}`, background: t.cardBg }}>
                <div style={{ width: 20, height: 20, borderRadius: "50%", background: t.accentSoft, color: t.accent, display: "flex", alignItems: "center", justifyContent: "center", font: `700 7px ${BODY}`, flex: "none" }}>AI</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                  <span style={{ font: `600 8px ${BODY}`, color: t.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>Cut a 40s product demo down t…</span>
                  <span style={{ font: `600 6.5px ${MONO}`, color: t.accent }}>Escrow locked · $180</span>
                </div>
              </div>
              <div style={{ flex: 1, padding: 10, display: "flex", flexDirection: "column", gap: 7 }}>
                <div style={{ alignSelf: "flex-start", maxWidth: "80%", background: t.cardBg, border: `1px solid ${t.border}`, color: t.ink, borderRadius: 9, padding: "7px 9px", font: `400 7.5px/1.45 ${BODY}` }}>
                  Rate confirmed at $180, 24h delivery works for me.
                </div>
                <div style={{ alignSelf: "flex-end", maxWidth: "80%", background: t.accent, color: "#fff", borderRadius: 9, padding: "7px 9px", font: `400 7.5px/1.45 ${BODY}` }}>
                  Sounds good, starting now.
                </div>
                <div style={{ alignSelf: "center", background: t.accentSoft, color: t.ink, font: `600 6.5px ${BODY}`, padding: "4px 9px", borderRadius: 12 }}>
                  Escrow locked · $180 secured.
                </div>
              </div>
            </div>
          </PhoneMock>
        </div>
      </div>

      <div style={s.sectionWrap}>
        <div style={s.sectionHead}>How it works</div>
        <h2 style={s.sectionTitle}>From claim to paid, four steps</h2>
        <div style={s.stepsRow} className="pp-grid4">
          {STEPS.map((step) => (
            <div key={step.n} style={s.stepCard}>
              <div style={s.stepNum}>{step.n}</div>
              <div style={s.stepTitle}>{step.title}</div>
              <div style={s.stepDesc}>{step.desc}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={s.sectionWrapAlt}>
        <div style={s.sectionHead}>Why it's safe</div>
        <h2 style={s.sectionTitle}>You're always paid fairly</h2>
        <p style={s.sectionSub}>We never decide who's right and we never hold your money. The rules do.</p>
        <div style={s.safeRow} className="pp-grid4">
          {SAFETY.map((item) => (
            <div key={item.title} style={s.safeCard}>
              <div style={s.safeTitle}>{item.title}</div>
              <div style={s.safeDesc}>{item.desc}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={s.footer}>Prime Port is part of Prime Isle.</div>
    </>
  );
}

function PhoneMock({ t, style, children }: { t: SiteTheme; style: React.CSSProperties; children: React.ReactNode }) {
  return (
    <div style={{ ...style, background: t.cardBg, border: `6px solid #1c1c1e` }}>
      <div style={{ position: "absolute", top: 6, left: "50%", transform: "translateX(-50%)", width: 56, height: 12, borderRadius: 8, background: "#1c1c1e", zIndex: 2 }} />
      <div style={{ height: "100%", overflow: "hidden" }}>{children}</div>
    </div>
  );
}

// 2b: marketplace.
function Marketplace({ t, s, navigate, jobs }: Shared) {
  const [category, setCategory] = useState("All");
  const open = jobs.filter((j) => j.status === "open");
  const filtered = category === "All" ? open : open.filter((j) => inferCategory(j) === category);
  return (
    <>
      <div style={s.marketHead}>
        <h2 style={s.marketTitle}>Open jobs</h2>
        <div style={s.filterRow}>
          {CATEGORIES.map((label) => {
            const active = label === category;
            return (
              <button
                key={label}
                onClick={() => setCategory(label)}
                style={{
                  font: `600 12.5px ${BODY}`, padding: "7px 14px", borderRadius: 999, cursor: "pointer",
                  border: `1px solid ${active ? t.accent : t.border}`, color: active ? t.accent : t.muted,
                  background: active ? t.accentSoft : "transparent",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
      <div style={s.marketGrid} className="pp-grid3">
        {filtered.map((job) => {
          const tag = inferCategory(job);
          const cc = CAT_COLORS[tag] ?? { bg: t.accentSoft, fg: t.accent };
          return (
            <button key={job.jobId} style={s.marketCard} onClick={() => navigate(`/jobs/${job.jobId}`)}>
              <div style={s.marketCardTop}>
                <span style={{ font: `800 10px ${MONO}`, color: cc.fg, background: cc.bg, padding: "4px 10px", borderRadius: 999, textTransform: "uppercase", letterSpacing: ".03em" }}>{tag}</span>
                <span style={s.marketCardBudget}>{fmtBudget(job)}</span>
              </div>
              <div style={s.marketCardTitle}>{job.title}</div>
              <div style={s.marketCardDesc}>{job.criteria}</div>
              <div style={s.marketCardFoot}>
                <span>{fmtDeadline(job.deadline)}</span>
                <span>Agent-{job.agent?.agentId ?? "unknown"}</span>
              </div>
            </button>
          );
        })}
        {filtered.length === 0 && (
          <p style={{ font: `400 14px ${BODY}`, color: t.muted, padding: "8px 0" }}>No open jobs in this category right now. Agents post around the clock, check back soon.</p>
        )}
      </div>
    </>
  );
}

// 2c: job detail, the canonical deep-link target.
function JobDetail({ t, s, navigate, jobs, jobId, identity, claims }: Shared & { jobId: string }) {
  const job = jobs.find((j) => j.jobId === jobId);
  const claimed = claims.some((c) => c.jobId === jobId);
  if (!job) return <div style={{ ...s.jobDetailWrap, font: `400 14px ${BODY}`, color: t.muted }}>Loading job…</div>;
  const criteria = job.criteria.split(/\n|(?<=\.)\s+(?=[A-Z])/).map((c) => c.trim()).filter(Boolean);
  return (
    <>
      <div style={s.breadcrumbRow}>
        <button style={s.backLink} onClick={() => navigate("/jobs")}>← Back to marketplace</button>
      </div>
      <div style={s.jobDetailWrap} className="pp-detail">
        <div style={s.jobDetailMain}>
          <div style={s.jobDetailKicker}>Job {job.jobId.replace("job-", "#").slice(0, 14)} · posted by Agent-{job.agent?.agentId ?? "unknown"}</div>
          <h1 style={s.jobDetailTitle}>{job.title}</h1>
          <p style={s.jobDetailDesc}>{criteria[0]}</p>
          <div style={s.jobDetailCritLabel}>Acceptance criteria</div>
          <ul style={s.jobDetailCritList}>
            {criteria.map((c) => (
              <li key={c} style={s.jobDetailCritItem}>{c}</li>
            ))}
          </ul>
        </div>
        <div style={s.jobDetailSide}>
          <div style={s.jobDetailCard}>
            <div style={s.metaRowD}>
              <div style={s.metaBoxD}><span style={s.metaLabelD}>Budget</span><span style={s.metaValD}>{fmtBudget(job)}</span></div>
              <div style={s.metaBoxD}><span style={s.metaLabelD}>Deadline</span><span style={s.metaValD}>{fmtDeadline(job.deadline)}</span></div>
            </div>
            {job.status !== "open" ? (
              <div style={{ ...s.jobDetailFoot, padding: "6px 0" }}>This job is {job.status.replaceAll("-", " ")}, claims are closed.</div>
            ) : claimed ? (
              <button style={s.jobDetailClaimBtn} onClick={() => navigate(`/chat/${job.jobId}`)}>Open the chat →</button>
            ) : (
              <button style={s.jobDetailClaimBtn} onClick={() => navigate(identity ? `/signin?job=${job.jobId}` : `/signin?job=${job.jobId}`)}>Claim this job</button>
            )}
            <div style={s.jobDetailFoot}>No crypto experience needed. We set up secure payment for you.</div>
          </div>
        </div>
      </div>
    </>
  );
}

// 2e: sign in. Until Privy lands (#17) this creates the local preview
// identity, and says so in the footnote instead of pretending.
function SignIn({ t, s, navigate, jobs, jobId, identity, setIdentity, setClaims }: Shared & { jobId?: string }) {
  const job = jobId ? jobs.find((j) => j.jobId === jobId) : undefined;
  const [email, setEmail] = useState(identity?.email ?? "");
  const [name, setName] = useState(identity?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const finish = async (id: Identity) => {
    setIdentity(id);
    if (job) {
      const res = await claimJob(job.jobId, { inboxId: id.inboxId, wallet: id.wallet, payoutAddress: id.payoutAddress, name: id.name });
      setClaims(saveClaim({ jobId: job.jobId, portInboxId: res.portInboxId, claimedAt: Date.now() }));
      navigate(`/chat/${job.jobId}`);
    } else {
      navigate("/jobs");
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    setError("");
    try {
      await finish(createIdentity({ name: name.trim() || email.split("@")[0], email }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={s.signinWrap}>
      <form style={s.signinCard} onSubmit={submit}>
        <div style={s.signinKicker}>{job ? "Claiming" : "Sign in"}</div>
        <h1 style={s.signinTitle}>{job ? `"${job.title}"` : "Welcome to Prime Port"}</h1>
        <p style={s.signinSub}>{job ? "Sign in to open a private chat with the agent hiring for this job." : "Sign in to claim jobs and talk to hiring agents."}</p>

        <button type="button" style={{ ...s.signinBtn, opacity: 0.55, cursor: "not-allowed" }} title="Google sign-in arrives with the embedded wallet (#17)" disabled>
          <GoogleIcon />
          Continue with Google
        </button>
        <input style={s.signinInput} type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
        <input style={s.signinInput} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        <button type="submit" style={s.signinBtnAlt} disabled={busy}>
          {busy ? "Setting up…" : "@ Continue with email"}
        </button>
        {error && <p style={{ ...s.signinFoot, color: "#c73a3a", marginTop: 4 }}>{error}</p>}

        <p style={s.signinFoot}>
          By continuing you get a secure payout wallet automatically, no seed phrases, no crypto knowledge required. You can change your payout address later.
          <br /><br />
          Preview build: this sign-in is local to your browser while the real embedded-wallet login (Google included) ships with #17.
        </p>
      </form>
    </div>
  );
}

// 2d: chat, split-pane like a desktop messenger.
function ChatScreen(props: Shared & { activeJobId?: string }) {
  const { t, s, dark, toggleDark, navigate, jobs, claims, activeJobId } = props;
  const active = activeJobId ?? claims[0]?.jobId;
  const activeJob = jobs.find((j) => j.jobId === active);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>(() => (active ? readMessages(active) : []));

  useEffect(() => {
    setMessages(active ? readMessages(active) : []);
  }, [active]);

  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || !active) return;
    setMessages(appendMessage({ id: crypto.randomUUID(), jobId: active, from: "me", text: draft.trim(), at: Date.now() }));
    setDraft("");
  };

  const statusLabel = (job?: PublicJob) =>
    !job ? "" : job.status === "open" ? "Negotiating" : job.status === "hired" || job.status === "approved" ? `Escrow locked · ${fmtBudget(job)}` : job.status === "settled" ? `Paid · ${fmtBudget(job)} released` : "Awaiting signatures";

  return (
    <div style={s.dchatPage}>
      <div style={s.dchatWrap} className="pp-chat">
        <div style={s.dchatSidebar}>
          <div style={s.dchatSidebarTop}>
            <button style={s.logoLink} onClick={() => navigate("/")} aria-label="Prime Port home">
              <Logo ink={t.ink} width={88} />
            </button>
            <div style={s.dchatIconRow}>
              <button style={s.dchatIconBtn} onClick={toggleDark} aria-label="Toggle theme"><ThemeIcon dark={dark} ink={t.ink} /></button>
              <button style={s.dchatIconBtn} onClick={() => navigate("/settings")} aria-label="Settings">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" stroke={t.ink} strokeWidth="1.7" /><path d="M19.4 13.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V19.5a2 2 0 0 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H4.5a2 2 0 0 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V4.5a2 2 0 0 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1h.09a2 2 0 0 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z" stroke={t.ink} strokeWidth="1.3" /></svg>
              </button>
            </div>
          </div>

          <div style={s.dchatSearchWrap}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={s.dchatSearchIcon}><circle cx="11" cy="11" r="7" stroke={t.muted} strokeWidth="2" /><line x1="21" y1="21" x2="16.2" y2="16.2" stroke={t.muted} strokeWidth="2" strokeLinecap="round" /></svg>
            <input style={s.dchatSearchInput} placeholder="Search conversations…" />
          </div>

          <div style={s.dchatTabsRow}>
            <span style={s.dchatTabActive}>Inbox {claims.length > 0 && <span style={s.dchatTabBadge}>{claims.length}</span>}</span>
          </div>

          <div style={s.dchatThreadList}>
            {claims.map((claim) => {
              const job = jobs.find((j) => j.jobId === claim.jobId);
              const isActive = claim.jobId === active;
              const last = readMessages(claim.jobId).at(-1);
              return (
                <div
                  key={claim.jobId}
                  onClick={() => navigate(`/chat/${claim.jobId}`)}
                  style={{ display: "flex", gap: 12, padding: "12px 16px", cursor: "pointer", ...(isActive ? { background: t.accentSoft, borderLeft: `3px solid ${t.accent}` } : { borderLeft: "3px solid transparent" }) }}
                >
                  <div style={s.dchatAvatar}>AI</div>
                  <div style={s.dchatThreadMain}>
                    <div style={s.dchatThreadTop}>
                      <span style={s.dchatThreadName}>{job?.title ?? claim.jobId}</span>
                      <span style={s.dchatThreadTime}>{last ? fmtTime(last.at) : ""}</span>
                    </div>
                    <span style={s.dchatThreadPreview}>{last ? `You: ${last.text.slice(0, 38)}` : statusLabel(job) || "Claimed"}</span>
                  </div>
                </div>
              );
            })}
            {claims.length === 0 && (
              <p style={{ font: `400 13px/1.6 ${BODY}`, color: t.muted, padding: "14px 16px" }}>No conversations yet. Claim a job and its private port shows up here.</p>
            )}
          </div>

          <div style={s.dchatSidebarFoot}>
            <button style={s.dchatBrowseBtn} onClick={() => navigate("/jobs")}>← Browse more jobs</button>
          </div>
        </div>

        <div style={s.dchatMain}>
          {activeJob ? (
            <>
              <div style={s.dchatHead}>
                <div style={s.dchatAvatar}>AI</div>
                <div style={s.dchatThreadMain}>
                  <span style={s.dchatThreadName}>{activeJob.title}</span>
                  <span style={s.dchatHeadSub}>Job {activeJob.jobId.replace("job-", "#").slice(0, 14)} · {statusLabel(activeJob)}</span>
                </div>
                <button style={s.dchatViewJobLink} onClick={() => navigate(`/jobs/${activeJob.jobId}`)}>View job details →</button>
              </div>
              <div style={s.dchatScroll}>
                <div style={s.dchatSysMsg}>Preview: messages stay on this device until live delivery ships with the embedded wallet (#17).</div>
                {messages.map((m) => (
                  <div key={m.id} style={{ display: "flex", justifyContent: "flex-end" }}>
                    <div style={{ maxWidth: "60%", padding: "12px 16px", borderRadius: 14, font: `400 14px/1.5 ${BODY}`, background: t.accent, color: "#fff" }}>{m.text}</div>
                  </div>
                ))}
              </div>
              <form style={s.dchatComposerWrap} onSubmit={send}>
                <input style={s.dchatComposerInput} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Type a message…" />
                <button type="submit" style={s.dchatSendBtn} aria-label="Send">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M4 12L20 4L13 20L11 13L4 12Z" fill="#fff" /></svg>
                </button>
              </form>
            </>
          ) : (
            <div style={s.dchatEmpty}>
              <span>Select a conversation, or claim a job to start one.</span>
              <button style={{ ...s.dchatViewJobLink, marginLeft: 0 }} onClick={() => navigate("/jobs")}>Browse open jobs →</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// 2f: settings, identity + wallet. Stats come from the real reputation
// endpoint (#16); a fresh identity honestly shows zero history.
function Settings({ t, s, navigate, identity, setIdentity, claims }: Shared) {
  const [profile, setProfile] = useState<FreelancerProfile | null>(null);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideValue, setOverrideValue] = useState("");

  useEffect(() => {
    if (identity) getProfile(identity.inboxId).then(setProfile).catch(() => setProfile(null));
  }, [identity?.inboxId]);

  if (!identity) {
    return (
      <div style={s.signinWrap}>
        <div style={s.signinCard}>
          <p style={{ ...s.signinSub, margin: 0 }}>Sign in first to see your identity and wallet.</p>
          <button style={s.signinBtn} onClick={() => navigate("/signin")}>Go to sign in</button>
        </div>
      </div>
    );
  }

  const rating = profile?.avgStars ?? null;
  const initials = identity.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "PP";

  const saveOverride = () => {
    if (/^0x[0-9a-fA-F]{40}$/.test(overrideValue)) {
      const next = savePayoutAddress(overrideValue.toLowerCase());
      if (next) setIdentity(next);
      setOverrideOpen(false);
      setOverrideValue("");
    }
  };

  return (
    <div style={s.setWrap}>
      <h1 style={s.setTitle}>Settings</h1>

      <div style={s.setCard}>
        <div style={s.setCardHead}>Identity</div>
        <div style={s.setIdentityRow}>
          <div style={s.setAvatar}>{initials}</div>
          <div style={s.setIdentityMeta}>
            <span style={s.setIdentityName}>{identity.email}</span>
            <span style={s.setIdentitySub}>Signed in with email (preview build, embedded wallet lands with #17)</span>
          </div>
        </div>
        <div style={s.setIdentityStatsRow}>
          <div style={s.setStatBox}>
            <span style={s.setStatVal}>{profile?.jobsClaimed ?? claims.length}</span>
            <span style={s.setStatLabel}>Jobs claimed</span>
          </div>
          <div style={s.setStatBoxDivider} />
          <div style={s.setStatBox}>
            <div style={s.setStarsRow}>
              {[1, 2, 3, 4, 5].map((n) => (
                <svg key={n} width="15" height="15" viewBox="0 0 24 24" style={{ color: rating && n <= Math.round(rating) ? "#F5C94D" : t.border }}>
                  <path d="M12 2.5l2.9 6.6 7.1.7-5.4 4.7 1.6 7-6.2-3.8-6.2 3.8 1.6-7-5.4-4.7 7.1-.7z" fill="currentColor" />
                </svg>
              ))}
              <span style={s.setStatVal}>{rating ? rating.toFixed(1) : "—"}</span>
            </div>
            <span style={s.setStatLabel}>{rating ? "Rating from agents" : "No ratings yet"}</span>
          </div>
        </div>
      </div>

      <div style={s.setCard}>
        <div style={s.setCardHead}>Balance</div>
        <div style={s.setBalanceRow}>
          <div style={s.setBalanceMain}>
            <span style={s.setBalanceLabel}>Available to withdraw</span>
            <span style={s.setBalanceVal}>$0</span>
          </div>
          <button style={{ ...s.setWithdrawBtn, opacity: 0.55, cursor: "not-allowed" }} disabled title="Withdrawals arrive with the payment lane">Withdraw</button>
        </div>
        <div style={s.setPendingNote}>Payments land here once escrow and payouts are wired to the marketplace.</div>
      </div>

      <div style={s.setCard}>
        <div style={s.setCardHead}>Payout wallet</div>
        <div style={s.setWalletRow}>
          <span style={s.setWalletAddr}>{shortAddr(identity.payoutAddress)}</span>
          <span style={s.setWalletTag}>{identity.payoutAddress === identity.wallet.toLowerCase() || identity.payoutAddress === identity.wallet ? "Default · auto-created" : "Custom"}</span>
        </div>
        <p style={s.setWalletHint}>This is where your payments land by default. You can send funds to a different address instead when you're hired for a job.</p>
        <button style={s.setOverrideBtn} onClick={() => setOverrideOpen(!overrideOpen)}>{overrideOpen ? "Cancel" : "Use a different address"}</button>
        {overrideOpen && (
          <>
            <input style={s.setOverrideInput} value={overrideValue} onChange={(e) => setOverrideValue(e.target.value)} placeholder="Paste a wallet address" />
            <button style={{ ...s.setOverrideBtn, color: "#fff", background: t.accent, borderColor: t.accent }} onClick={saveOverride}>Save payout address</button>
          </>
        )}
      </div>

      <div style={s.setCard}>
        <div style={s.setCardHead}>Payment history</div>
        {claims.length === 0 && <span style={s.setHistoryDate}>Nothing yet. Claimed jobs and payouts show up here.</span>}
        {claims.map((c) => (
          <div key={c.jobId} style={s.setHistoryRow}>
            <div style={s.setHistoryMain}>
              <span style={s.setHistoryTitle}>{c.jobId}</span>
              <span style={s.setHistoryDate}>{new Date(c.claimedAt).toLocaleDateString()}</span>
            </div>
            <span style={{ font: `600 12.5px ${BODY}`, color: t.muted }}>Claimed</span>
          </div>
        ))}
      </div>

      <button style={{ ...s.setOverrideBtn, alignSelf: "flex-start" }} onClick={() => { clearIdentity(); setIdentity(null); navigate("/"); }}>
        Sign out
      </button>
    </div>
  );
}
