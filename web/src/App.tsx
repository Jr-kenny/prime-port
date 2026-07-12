// The freelancer web app, transcribed screen-for-screen from
// docs/design/prime-port-prototype.html sections 2a-2f (the 1a "Direct"
// language, per issue #14). Markup order and style values follow the
// prototype; data comes from the live backend, identity from the embedded
// wallet (identity.ts), and chat rides the real XMTP transport.
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useLoginWithEmail, useLoginWithOAuth } from "@privy-io/react-auth";
import { claimJob, countersignHire, getProfile, listJobs } from "./api";
import type { FreelancerProfile, PublicJob } from "./api";
import { shortAddr, useIdentity } from "./identity";
import type { Session } from "./identity";
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

// A job the signed-in freelancer has claimed, derived entirely from the
// server's jobs list, so claims follow the identity across devices.
type ClaimView = { jobId: string; portInboxId: string; claimedAt: number };

export function App() {
  const [route, setRoute] = useState<Route>(parseRoute);
  const [dark, setDark] = useState(() => window.localStorage.getItem("prime-port.theme") === "dark");
  const [jobs, setJobs] = useState<PublicJob[]>([]);
  const session = useIdentity();
  const identity = session.identity;

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

  const refreshJobs = () => listJobs().then(setJobs).catch(() => {});

  useEffect(() => {
    listJobs().then(setJobs).catch(() => setJobs([]));
  }, [route.name]);

  const claims = useMemo<ClaimView[]>(() => {
    if (!identity) return [];
    return jobs
      .filter((j) => j.claims.some((c) => c.inboxId === identity.inboxId))
      .map((j) => ({
        jobId: j.jobId,
        portInboxId: j.port.inboxId,
        claimedAt: j.claims.find((c) => c.inboxId === identity.inboxId)!.claimedAt,
      }))
      .sort((a, b) => b.claimedAt - a.claimedAt);
  }, [jobs, identity?.inboxId]);

  const toggleDark = () => {
    const next = !dark;
    setDark(next);
    window.localStorage.setItem("prime-port.theme", next ? "dark" : "light");
  };

  const shared = { t, s, dark, toggleDark, navigate, jobs, refreshJobs, session, identity, claims };

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
  refreshJobs: () => Promise<void>;
  session: Session;
  identity: Session["identity"];
  claims: ClaimView[];
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
              <button style={s.jobDetailClaimBtn} onClick={() => navigate(`/signin?job=${job.jobId}`)}>Claim this job</button>
            )}
            <div style={s.jobDetailFoot}>No crypto experience needed. We set up secure payment for you.</div>
          </div>
        </div>
      </div>
    </>
  );
}

// 2e: sign in. Privy under the prototype's own card: Google is a headless
// OAuth redirect, email is a one-time code. Once the session is ready (wallet
// created, XMTP inbox registered) the pending claim fires automatically, so
// the OAuth round-trip back to /signin?job=… resumes exactly where it left.
function SignIn({ t, s, navigate, jobs, jobId, session, refreshJobs }: Shared & { jobId?: string }) {
  const job = jobId ? jobs.find((j) => j.jobId === jobId) : undefined;
  const { sendCode, loginWithCode, state: emailState } = useLoginWithEmail();
  const { initOAuth } = useLoginWithOAuth();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [claiming, setClaiming] = useState(false);
  const claimStarted = useRef(false);

  const codeStage = ["awaiting-code-input", "submitting-code"].includes(emailState.status);
  const busy = ["sending-code", "submitting-code"].includes(emailState.status);
  const settingUp = session.status === "connecting" || claiming;

  useEffect(() => {
    // Runs for every way a session becomes ready on this screen: email code,
    // OAuth return, or arriving already signed in via a job's claim button.
    if (session.status !== "ready" || claimStarted.current) return;
    if (jobId && !job) return; // jobs list still loading, wait for it
    claimStarted.current = true;
    (async () => {
      try {
        if (job) {
          setClaiming(true);
          const id = session.identity!;
          if (job.status !== "open" && !job.claims.some((c) => c.inboxId === id.inboxId)) {
            throw new Error(`this job is ${job.status.replaceAll("-", " ")}, claims are closed`);
          }
          if (!job.claims.some((c) => c.inboxId === id.inboxId)) {
            await claimJob(job.jobId, { inboxId: id.inboxId, wallet: id.wallet, payoutAddress: id.payoutAddress, name: id.name });
          }
          await refreshJobs();
          navigate(`/chat/${job.jobId}`);
        } else {
          navigate("/jobs");
        }
      } catch (err) {
        setError((err as Error).message);
        setClaiming(false);
        claimStarted.current = false;
      }
    })();
  }, [session.status, job?.jobId, jobId]);

  const submitEmail = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      if (codeStage) {
        if (!code.trim()) return;
        await loginWithCode({ code: code.trim() });
      } else {
        if (!email.trim()) return;
        await sendCode({ email: email.trim() });
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div style={s.signinWrap}>
      <form style={s.signinCard} onSubmit={submitEmail}>
        <div style={s.signinKicker}>{job ? "Claiming" : "Sign in"}</div>
        <h1 style={s.signinTitle}>{job ? `"${job.title}"` : "Welcome to Prime Port"}</h1>
        <p style={s.signinSub}>{job ? "Sign in to open a private chat with the agent hiring for this job." : "Sign in to claim jobs and talk to hiring agents."}</p>

        {settingUp ? (
          <p style={{ ...s.signinSub, margin: "8px 0" }}>
            {claiming
              ? "Claiming the job…"
              : session.stage === "wallet"
                ? "Creating your secure wallet…"
                : "Registering your inbox… first sign-in takes a few seconds."}
          </p>
        ) : (
          <>
            <button type="button" style={s.signinBtn} onClick={() => { setError(""); initOAuth({ provider: "google" }).catch((err) => setError((err as Error).message)); }}>
              <GoogleIcon />
              Continue with Google
            </button>
            {codeStage ? (
              <>
                <input style={s.signinInput} inputMode="numeric" autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" />
                <button type="submit" style={s.signinBtnAlt} disabled={busy}>
                  {busy ? "Checking…" : "Verify code"}
                </button>
                <p style={s.signinFoot}>We emailed a one-time code to {email}.</p>
              </>
            ) : (
              <>
                <input style={s.signinInput} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
                <button type="submit" style={s.signinBtnAlt} disabled={busy}>
                  {busy ? "Sending code…" : "@ Continue with email"}
                </button>
              </>
            )}
          </>
        )}
        {(error || session.error) && <p style={{ ...s.signinFoot, color: "#c73a3a", marginTop: 4 }}>{error || session.error}</p>}

        <p style={s.signinFoot}>
          By continuing you get a secure payout wallet automatically, no seed phrases, no crypto knowledge required. You can change your payout address later.
        </p>
      </form>
    </div>
  );
}

// 2d: chat, split-pane like a desktop messenger. The conversation is a real
// XMTP DM with the job's port inbox: what the agent's negotiate sends shows
// up here, and what's typed here lands in the agent's get_offers.
type PortMessage = { id: string; text: string; mine: boolean; at: number };

// The exact string both wallets personal_sign over a hire; must match
// signingMessage() in backend/commitment/commitment.mjs.
const hireSigningMessage = (hash: string) => `Prime Port hire commitment v1: ${hash}`;

function ChatScreen(props: Shared & { activeJobId?: string }) {
  const { t, s, dark, toggleDark, navigate, jobs, claims, session, identity, refreshJobs, activeJobId } = props;
  const active = activeJobId ?? claims[0]?.jobId;
  const activeJob = jobs.find((j) => j.jobId === active);
  const activeClaim = claims.find((c) => c.jobId === active);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<PortMessage[]>([]);
  const [transportError, setTransportError] = useState("");
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState("");
  const dmRef = useRef<Awaited<ReturnType<NonNullable<Session["xmtp"]>["conversations"]["newDm"]>> | null>(null);

  useEffect(() => {
    const xmtp = session.xmtp;
    if (!xmtp || !activeClaim) return;
    let stopped = false;
    setMessages([]);
    setTransportError("");
    dmRef.current = null;
    const refresh = async () => {
      const dm = dmRef.current;
      if (!dm) return;
      await dm.sync();
      const msgs = await dm.messages();
      if (stopped) return;
      setMessages(
        msgs
          .filter((m) => typeof m.content === "string")
          .map((m) => ({
            id: m.id,
            text: m.content as string,
            mine: m.senderInboxId === xmtp.inboxId,
            at: Number(m.sentAtNs / 1_000_000n),
          })),
      );
    };
    (async () => {
      try {
        dmRef.current = await xmtp.conversations.newDm(activeClaim.portInboxId);
        await refresh();
      } catch (e) {
        if (!stopped) setTransportError((e as Error).message);
      }
    })();
    const timer = setInterval(() => {
      refresh().catch((e) => !stopped && setTransportError((e as Error).message));
      refreshJobs(); // pick up hire-state changes while the chat is open
    }, 4000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [session.xmtp, activeClaim?.portInboxId]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    const dm = dmRef.current;
    if (!text || !dm) return;
    setDraft("");
    try {
      await dm.send(text);
      await dm.sync();
      const msgs = await dm.messages();
      setMessages(
        msgs
          .filter((m) => typeof m.content === "string")
          .map((m) => ({ id: m.id, text: m.content as string, mine: m.senderInboxId === session.xmtp!.inboxId, at: Number(m.sentAtNs / 1_000_000n) })),
      );
    } catch (err) {
      setTransportError((err as Error).message);
    }
  };

  // The hire moment: the agent signed first, the freelancer countersigns here
  // and escrow locks. Only shown to the wallet the commitment names.
  const pendingHire =
    activeJob?.status === "awaiting-freelancer-signature" &&
    activeJob.pendingHire &&
    identity &&
    activeJob.pendingHire.commitment.freelancer.wallet === identity.wallet
      ? activeJob.pendingHire
      : null;

  const countersign = async () => {
    if (!pendingHire || !activeJob) return;
    setSigning(true);
    setSignError("");
    try {
      const signature = await session.signMessage(hireSigningMessage(pendingHire.hash));
      await countersignHire(activeJob.jobId, signature);
      await refreshJobs();
    } catch (err) {
      setSignError((err as Error).message);
    } finally {
      setSigning(false);
    }
  };

  // Past the claim stage the negotiated commitment price is the truth, not the listing price.
  const dealPrice = (job: PublicJob) =>
    job.pendingHire ? `${job.pendingHire.commitment.price} ${job.pendingHire.commitment.currency}` : fmtBudget(job);
  const statusLabel = (job?: PublicJob) =>
    !job ? "" : job.status === "open" ? "Negotiating" : job.status === "hired" || job.status === "approved" ? `Escrow locked · ${dealPrice(job)}` : job.status === "settled" ? `Paid · ${dealPrice(job)} released` : "Awaiting signatures";

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
              const last = isActive ? messages.at(-1) : undefined;
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
                    <span style={s.dchatThreadPreview}>{last ? `${last.mine ? "You: " : ""}${last.text.slice(0, 38)}` : statusLabel(job) || "Claimed"}</span>
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
                <div style={s.dchatSysMsg}>
                  {transportError
                    ? `Connection problem: ${transportError}`
                    : session.status !== "ready"
                      ? "Connecting your inbox…"
                      : "Private port · end-to-end over XMTP. Only you and this job's agent can read it."}
                </div>
                {pendingHire && (
                  <div style={{ alignSelf: "center", maxWidth: 420, display: "flex", flexDirection: "column", gap: 10, background: t.accentSoft, border: `1px solid ${t.accent}`, borderRadius: 14, padding: "14px 18px", textAlign: "center" }}>
                    <span style={{ font: `700 14px ${BODY}`, color: t.ink }}>The agent signed a hire commitment · {pendingHire.commitment.price} {pendingHire.commitment.currency}</span>
                    <span style={{ font: `400 13px/1.5 ${BODY}`, color: t.muted }}>
                      Countersign to accept. Escrow locks the moment you do, and payment goes to {shortAddr(identity?.payoutAddress ?? "")}.
                    </span>
                    <button
                      style={{ background: t.accent, color: "#fff", border: "none", borderRadius: 10, padding: "10px 16px", font: `700 14px ${BODY}`, cursor: signing ? "wait" : "pointer" }}
                      onClick={countersign}
                      disabled={signing}
                    >
                      {signing ? "Signing…" : "Accept & sign"}
                    </button>
                    {signError && <span style={{ font: `400 12px ${BODY}`, color: "#c73a3a" }}>{signError}</span>}
                  </div>
                )}
                {messages.map((m) => (
                  <div key={m.id} style={{ display: "flex", justifyContent: m.mine ? "flex-end" : "flex-start" }}>
                    <div
                      style={
                        m.mine
                          ? { maxWidth: "60%", padding: "12px 16px", borderRadius: 14, font: `400 14px/1.5 ${BODY}`, background: t.accent, color: "#fff" }
                          : { maxWidth: "60%", padding: "12px 16px", borderRadius: 14, font: `400 14px/1.5 ${BODY}`, background: t.cardBg, border: `1px solid ${t.border}`, color: t.ink }
                      }
                    >
                      {m.text}
                    </div>
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
              {session.status === "signed-out" ? (
                <>
                  <span>Sign in to see your conversations.</span>
                  <button style={{ ...s.dchatViewJobLink, marginLeft: 0 }} onClick={() => navigate("/signin")}>Go to sign in →</button>
                </>
              ) : (
                <>
                  <span>Select a conversation, or claim a job to start one.</span>
                  <button style={{ ...s.dchatViewJobLink, marginLeft: 0 }} onClick={() => navigate("/jobs")}>Browse open jobs →</button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// 2f: settings, identity + wallet. Stats come from the real reputation
// endpoint (#16); a fresh identity honestly shows zero history.
function Settings({ t, s, navigate, session, identity, claims, jobs }: Shared) {
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
          <p style={{ ...s.signinSub, margin: 0 }}>
            {session.status === "connecting" ? "Setting up your secure wallet and inbox…" : "Sign in first to see your identity and wallet."}
          </p>
          {session.status !== "connecting" && (
            <button style={s.signinBtn} onClick={() => navigate("/signin")}>Go to sign in</button>
          )}
        </div>
      </div>
    );
  }

  const rating = profile?.avgStars ?? null;
  const initials = identity.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "PP";

  // A job is mine past the claim stage only if the hire commitment names me.
  const hiredMe = (job?: PublicJob) => job?.pendingHire?.commitment.freelancer.inboxId === identity.inboxId;
  const commitPrice = (job: PublicJob) => `${job.pendingHire!.commitment.price} ${job.pendingHire!.commitment.currency}`;
  const settledEarnings = jobs
    .filter((j) => j.status === "settled" && hiredMe(j))
    .reduce((sum, j) => sum + Number(j.pendingHire!.commitment.price), 0);

  const historyFor = (job?: PublicJob): { label: string; strong?: boolean } => {
    if (!job || job.status === "open" || job.status === "hiring") return { label: "Claimed" };
    if (!hiredMe(job)) return { label: "Went to another freelancer" };
    if (job.status === "awaiting-freelancer-signature") return { label: "Awaiting your signature", strong: true };
    if (job.status === "settled") return { label: `Paid · ${commitPrice(job)}`, strong: true };
    return { label: `Escrow locked · ${commitPrice(job)}`, strong: true };
  };

  const saveOverride = () => {
    if (/^0x[0-9a-fA-F]{40}$/.test(overrideValue)) {
      session.setPayoutAddress(overrideValue);
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
            <span style={s.setIdentitySub}>Signed in with {identity.provider === "google" ? "Google" : "email"} · secure embedded wallet, no seed phrase</span>
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
        {settledEarnings > 0 && (
          <div style={s.setBalanceRow}>
            <div style={s.setBalanceMain}>
              <span style={s.setBalanceLabel}>Settled earnings</span>
              <span style={s.setBalanceVal}>{settledEarnings} USDT</span>
            </div>
          </div>
        )}
        <div style={s.setPendingNote}>Payments land here once escrow and payouts are wired to the marketplace.</div>
      </div>

      <div style={s.setCard}>
        <div style={s.setCardHead}>Payout wallet</div>
        <div style={s.setWalletRow}>
          <span style={s.setWalletAddr}>{shortAddr(identity.payoutAddress)}</span>
          <span style={s.setWalletTag}>{identity.payoutAddress === identity.wallet ? "Default · auto-created" : "Custom"}</span>
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
        {claims.map((c) => {
          const job = jobs.find((j) => j.jobId === c.jobId);
          const h = historyFor(job);
          return (
            <div key={c.jobId} style={s.setHistoryRow}>
              <div style={s.setHistoryMain}>
                <span style={s.setHistoryTitle}>{job?.title ?? c.jobId}</span>
                <span style={s.setHistoryDate}>{new Date(c.claimedAt).toLocaleDateString()}</span>
              </div>
              <span style={{ font: `600 12.5px ${BODY}`, color: h.strong ? t.accent : t.muted }}>{h.label}</span>
            </div>
          );
        })}
      </div>

      <button style={{ ...s.setOverrideBtn, alignSelf: "flex-start" }} onClick={() => session.signOut().then(() => navigate("/"))}>
        Sign out
      </button>
    </div>
  );
}
