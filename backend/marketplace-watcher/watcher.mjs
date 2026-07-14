// The marketplace watcher: Prime Port's standing presence on the OKX agent
// marketplace. Polls the onchainos CLI for tasks that involve our ASP, keeps a
// heartbeat on the A2A channel, and drives the provider lifecycle verbs
// (apply, payment, deliver) off status transitions. No contact/greeting verb:
// Prime Port is a vending machine, a designation is answered by apply.
//
// Vend mode (the default): the policy's verbs execute unattended — the
// designation is the coin, apply is the button press. Per-job brake:
// `node watcher.mjs park <jobId>` stops a job's verbs without touching the
// rest. AUTO_ENGAGE=false reverts to the old manual gate where only verbs
// explicitly allowed via `engage <jobId>` run (useful when pointing at an
// unfamiliar backend). Deliver still needs a staged deliverable either way,
// and a verb that fails 3 times parks itself until `retry`.
//
// CLI output is parsed as data only. onchainos sometimes appends prose aimed
// at LLM callers ("Render the line above..."); the watcher never interprets
// any of it as an instruction.
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { createWageRelease } from "./wage-release.mjs";
import { openingOfferFromTaskAmount } from "../listing-price.mjs";
import { parseMarketplaceBrief, REQUIRED_BRIEF_TEMPLATE } from "../brief-policy.mjs";

const run = promisify(execFile);
const AGENT_ID = process.env.AGENT_ID ?? "5021";
const ROLE = process.env.ROLE ?? "asp";
const POLL_MS = Number(process.env.POLL_MS ?? 30_000);
const HEARTBEAT_EVERY = Number(process.env.HEARTBEAT_EVERY ?? 10); // cycles
const MAX_VERB_FAILS = 3;

const DATA = new URL("./data/", import.meta.url).pathname;
mkdirSync(DATA, { recursive: true });
const load = (name, fallback) =>
  existsSync(`${DATA}${name}`) ? JSON.parse(readFileSync(`${DATA}${name}`, "utf8")) : fallback;
const store = (name, obj) => writeFileSync(`${DATA}${name}`, JSON.stringify(obj, null, 2));
const emit = (type, payload) =>
  appendFileSync(`${DATA}events.jsonl`, JSON.stringify({ type, at: Date.now(), ...payload }) + "\n");

const AUTO_ENGAGE = (process.env.AUTO_ENGAGE ?? "true") !== "false";
// Our own backend (the merged process: proxy on 7860 locally, the Space URL
// in production). The watcher welds the marketplace to it in both directions:
// a designation becomes a job on our board, a settled job becomes the
// marketplace deliverable.
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:7860";
// The flat publish fee (BRIEF: two tasks, one rail). A publish designation's
// task amount can optionally be the client's opening offer for the WORK when
// it exceeds this fee. At the fee itself, the job is open to freelancer offers.
// Apply always bids this publication fee, never the optional opening offer.
const PUBLISH_FEE = process.env.PUBLISH_FEE ?? "1";
const WATCHER_TOKEN = process.env.WATCHER_TOKEN ?? "";

const backendPost = async (path, body) => {
  const r = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(WATCHER_TOKEN ? { "x-watcher-token": WATCHER_TOKEN } : {}) },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? `backend replied ${r.status}`);
  return j;
};

const state = load("state.json", { tasks: {} });
const engaged = load("engaged.json", {}); // manual mode: jobId -> [verbs allowed to execute]
const parked = load("parked.json", {}); // vend mode: jobId -> true, verbs held
const pending = load("pending.json", {}); // "jobId:verb" -> { jobId, verb, args, reason, queuedAt, fails }

// Runs the onchainos CLI and returns the last JSON object on stdout. Log
// lines and LLM-directed prose around it are dropped.
async function cli(args) {
  let stdout;
  try {
    ({ stdout } = await run("onchainos", args, { timeout: 60_000 }));
  } catch (e) {
    // execFile errors carry stderr/stdout on the error object, not in
    // e.message; without them a failed verb logs as a bare command line.
    const detail = [e.stderr, e.stdout].filter(Boolean).join(" | ").trim();
    throw new Error(detail ? `${e.message.split("\n")[0]}: ${detail}` : e.message);
  }
  const jsonLine = stdout
    .split("\n")
    .filter((l) => l.trimStart().startsWith("{"))
    .pop();
  if (!jsonLine) return { ok: true, raw: stdout.trim() };
  const parsed = JSON.parse(jsonLine);
  if (parsed.ok === false) throw new Error(parsed.error ?? "onchainos returned ok:false");
  return parsed;
}

// What each verb actually runs. Amounts and deliverables come from the local
// task record (set via the `amount` / `deliverable` subcommands), falling back
// to the task's own budget for apply.
const verbCommand = {
  apply: (t, rec) => [
    "agent", "apply", t.jobId,
    "--agent-id", AGENT_ID,
    "--token-amount", rec.amount ?? t.tokenAmount,
    "--token-symbol", t.tokenSymbol,
  ],
  invoice: (t) => ["agent", "payment", t.jobId, "--agent-id", AGENT_ID],
  deliver: (t, rec) => [
    "agent", "deliver", t.jobId,
    "--agent-id", AGENT_ID,
    "--deliverable-text", rec.deliverable,
  ],
};

// The lifecycle policy: given a task's marketplace status and what we've
// already done locally, which verb comes next. Prime Port is a vending
// machine: no contact/greeting step, a designation is answered by apply.
// Order: apply -> invoice while created; deliver once accepted, and only
// once there is an actual deliverable to submit.
function nextVerbs(task, rec) {
  const done = rec.done ?? {};
  if (task.statusCode === 0) {
    if (!done.apply) return [{ verb: "apply", reason: "designated, apply next" }];
    if (!done.invoice) return [{ verb: "invoice", reason: "applied, invoice next" }];
    return [];
  }
  if (task.statusCode === 1 && !done.deliver) {
    if (!rec.deliverable) return [{ verb: "deliver-blocked", reason: "accepted but no deliverable staged" }];
    return [{ verb: "deliver", reason: "accepted and deliverable staged" }];
  }
  return []; // submitted/terminal: review timeouts (claim-auto-complete) stay manual
}

async function executeVerb(task, rec, verb, reason) {
  const key = `${task.jobId}:${verb}`;
  try {
    const result = await cli(verbCommand[verb](task, rec));
    rec.done = { ...rec.done, [verb]: Date.now() };
    delete pending[key];
    emit("mkt-action-executed", { jobId: task.jobId, verb, reason, result: result.data ?? result.raw });
    console.log(`[watcher] executed ${verb} on ${task.jobId.slice(0, 10)}…`);
  } catch (e) {
    pending[key] = { ...pending[key], fails: (pending[key]?.fails ?? 0) + 1, lastError: e.message };
    emit("mkt-action-failed", { jobId: task.jobId, verb, error: e.message });
    console.error(`[watcher] ${verb} on ${task.jobId.slice(0, 10)}… failed: ${e.message}`);
  }
}

// Weld 1: the coin drops. A fresh designation is immediately published as a
// job on our own board (which mints its port); the task description is the
// spec, the posted budget is the client's opening price for the work. The
// designation itself is the PUBLISH task: we apply at the flat fee, and its
// escrow lock is what unlocks the port for the client agent.
async function vendPublish(task, rec, brief) {
  try {
    const { data } = await cli(["agent", "get-agents", "--agent-ids", task.counterpartyAgentId]);
    const wallet = data?.[0]?.agentWalletAddress;
    if (!wallet) throw new Error(`no wallet on marketplace agent ${task.counterpartyAgentId}`);
    const j = await backendPost("/jobs", {
      title: brief.title,
      description: brief.description,
      deliverables: brief.deliverables,
      criteria: `${brief.description}\n\nDeliverables: ${brief.deliverables}\nAcceptance criteria: ${brief.acceptanceCriteria}`,
      price: brief.openingOffer ?? openingOfferFromTaskAmount(task.tokenAmount, PUBLISH_FEE) ?? undefined,
      currency: task.tokenSymbol,
      deadline: brief.deadline,
      agentId: task.counterpartyAgentId,
      agentWallet: wallet,
      marketplaceJobId: task.jobId,
    });
    rec.portJobId = j.jobId;
    rec.kind = "publish";
    rec.amount ??= PUBLISH_FEE;
    emit("mkt-vend-published", { jobId: task.jobId, portJobId: j.jobId, publishFee: rec.amount });
    console.log(`[watcher] vended ${task.jobId.slice(0, 10)}… onto the board as ${j.jobId} (publish fee ${rec.amount})`);
  } catch (e) {
    // No local state written: next poll retries until the board answers.
    emit("mkt-vend-publish-failed", { jobId: task.jobId, error: e.message });
    console.error(`[watcher] vend-publish for ${task.jobId.slice(0, 10)}… failed: ${e.message}`);
  }
}

async function requestMissingBrief(task, rec, missing) {
  if (rec.briefRequestedAt) return;
  const message =
    `Your publication escrow is confirmed, but Prime Port cannot publish an incomplete freelancer job. ` +
    `Missing: ${missing.join(", ")}. Reply with this template:\n${REQUIRED_BRIEF_TEMPLATE}`;
  try {
    await run("okx-a2a", [
      "xmtp-send", "--job-id", task.jobId, "--to-agent-id", task.counterpartyAgentId,
      "--session-agent-id", AGENT_ID, "--message", message, "--json",
    ], { timeout: 60_000 });
    rec.briefRequestedAt = Date.now();
    emit("mkt-brief-requested", { jobId: task.jobId, missing });
    console.log(`[watcher] requested missing brief fields for ${task.jobId.slice(0, 10)}…`);
  } catch (e) {
    emit("mkt-brief-request-failed", { jobId: task.jobId, error: e.message });
    console.error(`[watcher] brief request for ${task.jobId.slice(0, 10)}… failed: ${e.message}`);
  }
}

// Weld 1b: the second coin. After hire, the client agent opens a fresh task
// carrying the commitment hash; that designation is the JOB task (the wage).
// We link it to the board job and apply at the committed price. Returns true
// when the designation was recognized as a job task (matched or link-failed:
// either way it must not be vended as a new listing).
async function linkJobTask(task, rec, boardJobs) {
  const haystack = `${task.title ?? ""} ${task.description ?? ""}`;
  const hash = haystack.match(/0x[0-9a-f]{64}/i)?.[0]?.toLowerCase();
  if (!hash) return false;
  const job = boardJobs.find?.((j) => j.status === "awaiting-escrow" && j.pendingHire?.hash === hash);
  if (!job) return false;
  try {
    const linked = await backendPost(`/jobs/${job.jobId}/job-task`, { marketplaceJobId: task.jobId });
    rec.portJobId = job.jobId;
    rec.kind = "job";
    rec.amount = linked.price; // apply bids exactly what both sides signed
    emit("mkt-job-task-linked", { jobId: task.jobId, portJobId: job.jobId, commitmentHash: hash, price: linked.price });
    console.log(`[watcher] linked ${task.jobId.slice(0, 10)}… as the job task for ${job.jobId} at ${linked.price}`);
  } catch (e) {
    emit("mkt-job-task-link-failed", { jobId: task.jobId, portJobId: job.jobId, error: e.message });
    console.error(`[watcher] job-task link for ${task.jobId.slice(0, 10)}… failed: ${e.message}`);
  }
  return true;
}

// Weld 3: the wage walks home. Once a job settles on our side and its
// deliverable went to the marketplace, this drives the released escrow
// through claim -> deposit -> forward, one chain-derived step per cycle.
const releaseWages = createWageRelease({
  cli,
  emit,
  agentId: AGENT_ID,
  rpcUrl: process.env.XLAYER_RPC ?? "https://rpc.xlayer.tech",
  forwarder: process.env.FORWARDER_ADDRESS ?? "0xe3f11D89e585e2F0009ee5c6f105861525f70712",
  usdt: process.env.USDT_ADDRESS ?? "0x779ded0c9e1022225f8e0630b35a9b54be713736",
});

// Escrow facts flow one way: marketplace -> watcher -> board. Status 1 means
// accepted, and acceptance is when escrow locks; the board gates the port
// (publish) or flips the job to hired (job) off these reports.
async function reportEscrow(task, rec) {
  if (!rec.kind || !rec.portJobId || rec.paidReported || task.statusCode < 1) return;
  const path = rec.kind === "job" ? `/jobs/${rec.portJobId}/job-task/paid` : `/jobs/${rec.portJobId}/publish-task/paid`;
  try {
    await backendPost(path, { marketplaceJobId: task.jobId });
    rec.paidReported = true;
    emit("mkt-escrow-reported", { jobId: task.jobId, portJobId: rec.portJobId, kind: rec.kind });
    console.log(`[watcher] reported ${rec.kind}-task escrow for ${rec.portJobId}`);
  } catch (e) {
    emit("mkt-escrow-report-failed", { jobId: task.jobId, portJobId: rec.portJobId, kind: rec.kind, error: e.message });
    console.error(`[watcher] escrow report for ${rec.portJobId} failed: ${e.message}`);
  }
}

// Weld 2: the cup drops. Each task kind has its own settlement deliverable.
// A publish task delivers on fan-out + key: it settles the moment the agent
// takes the port, whether or not a hire ever happens. A job task delivers
// the completed work: it stages only when the board job settles. Records
// from before the two-task split have no kind and keep the old settled rule.
async function stageDeliverables(boardJobs) {
  const linked = Object.entries(state.tasks).filter(
    ([, r]) => r.portJobId && r.statusCode === 1 && !r.deliverable,
  );
  for (const [mktJobId, rec] of linked) {
    const job = boardJobs.find?.((j) => j.jobId === rec.portJobId);
    if (!job) continue;
    if (rec.kind === "publish") {
      if (!job.publishTask?.keyDeliveredAt) continue;
      rec.deliverable =
        `Prime Port publish task delivered for ${job.jobId}: ` +
        `listing live since ${new Date(job.createdAt).toISOString()}, fan-out executed, ` +
        `port ${job.port.inboxId} key delivered at ${new Date(job.publishTask.keyDeliveredAt).toISOString()}. ` +
        `Hiring proceeds under a separate job task at the port-negotiated price.`;
    } else {
      if (job.status !== "settled") continue;
      rec.deliverable =
        `Prime Port job ${job.jobId} completed. ` +
        `Hire commitment ${job.pendingHire?.hash}. ` +
        `Transcript hashes: ${(job.archive?.transcriptHashes ?? []).join(", ")}. ` +
        `Evidence was delivered encrypted on the job's XMTP channel and is committed in the archive.`;
    }
    emit("mkt-deliverable-staged", { jobId: mktJobId, portJobId: job.jobId, kind: rec.kind ?? "job" });
    console.log(`[watcher] staged ${rec.kind ?? "job"} deliverable for ${mktJobId.slice(0, 10)}… from ${job.jobId}`);
  }
}

async function pollOnce() {
  // One board snapshot per cycle: job-task matching, escrow reporting, and
  // deliverable staging all read it. An unreachable board skips those steps
  // this cycle rather than failing the poll.
  let boardJobs = [];
  try {
    boardJobs = await (await fetch(`${BACKEND_URL}/jobs`)).json();
  } catch (e) {
    emit("mkt-board-unreachable", { error: e.message });
    console.error(`[watcher] board unreachable: ${e.message}`);
  }
  try {
    await stageDeliverables(boardJobs);
  } catch (e) {
    emit("mkt-stage-failed", { error: e.message });
    console.error(`[watcher] deliverable staging failed: ${e.message}`);
  }
  try {
    await releaseWages(state.tasks, boardJobs);
  } catch (e) {
    emit("mkt-wage-release-failed", { error: e.message });
    console.error(`[watcher] wage release failed: ${e.message}`);
  }
  const [{ data }, { data: detailData }] = await Promise.all([
    cli(["agent", "active-tasks"]),
    cli(["agent", "task-in-progress", "--agent-ids", AGENT_ID]),
  ]);
  const details = new Map((detailData.providerTasks ?? []).map((task) => [task.jobId, task]));
  for (const summary of data.tasks ?? []) {
    const detail = details.get(summary.jobId) ?? {};
    const task = {
      ...summary,
      description: detail.description ?? summary.description,
      counterpartyAgentId: summary.counterpartyAgentId ?? detail.buyerAgentId,
    };
    const rec = (state.tasks[task.jobId] ??= { firstSeenAt: Date.now(), done: {} });
    if (rec.statusCode === undefined) {
      emit("mkt-task-designated", { jobId: task.jobId, title: task.title, counterparty: task.counterpartyAgentId, budget: `${task.tokenAmount} ${task.tokenSymbol}` });
      console.log(`[watcher] new task: "${task.title}" (${task.jobId.slice(0, 10)}…) from agent ${task.counterpartyAgentId}`);
    }
    // A fresh designation is either the wage for a signed hire (it carries
    // the commitment hash) or a new publication purchase. Publication tasks
    // are classified now but never placed on the public board before escrow.
    if (!rec.portJobId && task.statusCode === 0 && !rec.done?.apply && !parked[task.jobId]) {
      if (!(await linkJobTask(task, rec, boardJobs))) {
        rec.kind = "publish";
        rec.amount ??= PUBLISH_FEE;
      }
    }
    if (rec.kind === "publish" && !rec.portJobId && task.statusCode === 1 && !parked[task.jobId]) {
      const parsed = parseMarketplaceBrief(task);
      if (parsed.complete) await vendPublish(task, rec, parsed.brief);
      else await requestMissingBrief(task, rec, parsed.missing);
    }
    if (rec.statusCode !== undefined && rec.statusCode !== task.statusCode) {
      emit("mkt-task-status", { jobId: task.jobId, from: rec.statusCode, to: task.statusCode });
      console.log(`[watcher] ${task.jobId.slice(0, 10)}… status ${rec.statusCode} -> ${task.statusCode}`);
    }
    Object.assign(rec, { statusCode: task.statusCode, title: task.title, tokenAmount: task.tokenAmount, tokenSymbol: task.tokenSymbol, lastSeenAt: Date.now() });
    await reportEscrow(task, rec);

    for (const { verb, reason } of nextVerbs(task, rec)) {
      const key = `${task.jobId}:${verb}`;
      const allowed = AUTO_ENGAGE
        ? !parked[task.jobId]
        : (engaged[task.jobId] ?? []).includes(verb);
      if ((pending[key]?.fails ?? 0) >= MAX_VERB_FAILS) continue; // parked; clear via `retry`
      if (!pending[key]) {
        pending[key] = { jobId: task.jobId, verb, reason, queuedAt: Date.now(), fails: 0 };
        emit("mkt-action-queued", { jobId: task.jobId, verb, reason, gated: !allowed });
        if (!allowed) console.log(`[watcher] queued (gated): ${verb} on ${task.jobId.slice(0, 10)}… — ${reason}`);
      }
      if (allowed && verbCommand[verb]) await executeVerb(task, rec, verb, reason);
    }
  }
  store("state.json", state);
  store("pending.json", pending);
}

async function heartbeat() {
  try {
    const { data } = await cli(["agent", "gate-check", "--role", ROLE]);
    if (!data.ready) throw new Error(JSON.stringify(data));
  } catch (e) {
    emit("mkt-heartbeat-failed", { error: e.message });
    console.error(`[watcher] heartbeat FAILED: ${e.message}`);
  }
}

// --- subcommands -----------------------------------------------------------
const [cmd, ...rest] = process.argv.slice(2);
const setTaskField = (jobId, field, value) => {
  const rec = (state.tasks[jobId] ??= { firstSeenAt: Date.now(), done: {} });
  rec[field] = value;
  store("state.json", state);
  console.log(`${field} set on ${jobId}`);
};

if (cmd === "engage") {
  const [jobId, verbsArg] = rest;
  engaged[jobId] = (verbsArg ?? "apply,invoice,deliver").split(",");
  store("engaged.json", engaged);
  emit("mkt-engaged", { jobId, verbs: engaged[jobId] });
  console.log(`engaged ${jobId}: ${engaged[jobId].join(", ")}`);
} else if (cmd === "disengage") {
  delete engaged[rest[0]];
  store("engaged.json", engaged);
  emit("mkt-disengaged", { jobId: rest[0] });
  console.log(`disengaged ${rest[0]}`);
} else if (cmd === "park") {
  parked[rest[0]] = true;
  store("parked.json", parked);
  emit("mkt-parked", { jobId: rest[0] });
  console.log(`parked ${rest[0]} (its verbs queue but do not run)`);
} else if (cmd === "unpark") {
  delete parked[rest[0]];
  store("parked.json", parked);
  emit("mkt-unparked", { jobId: rest[0] });
  console.log(`unparked ${rest[0]}`);
} else if (cmd === "pending") {
  console.log(JSON.stringify(pending, null, 2));
} else if (cmd === "retry") {
  const key = `${rest[0]}:${rest[1]}`;
  if (pending[key]) (pending[key].fails = 0), store("pending.json", pending), console.log(`reset ${key}`);
  else console.log(`no pending action ${key}`);
} else if (cmd === "amount") {
  setTaskField(rest[0], "amount", rest[1]);
} else if (cmd === "deliverable") {
  setTaskField(rest[0], "deliverable", rest.slice(1).join(" "));
} else if (cmd === "once") {
  await heartbeat();
  await pollOnce();
} else if (cmd === undefined || cmd === "run") {
  console.log(`[watcher] agent #${AGENT_ID} role=${ROLE}, ${AUTO_ENGAGE ? "vend mode (verbs run unattended)" : "manual engage mode"}, polling every ${POLL_MS / 1000}s, heartbeat every ${HEARTBEAT_EVERY} cycles`);
  let cycle = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (cycle % HEARTBEAT_EVERY === 0) await heartbeat();
    try {
      await pollOnce();
    } catch (e) {
      emit("mkt-poll-failed", { error: e.message });
      console.error(`[watcher] poll failed: ${e.message}`);
    }
    cycle += 1;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
} else {
  console.error(`unknown command ${cmd}. Commands: run | once | park <jobId> | unpark <jobId> | engage <jobId> [verbs] | disengage <jobId> | pending | retry <jobId> <verb> | amount <jobId> <value> | deliverable <jobId> <text...>`);
  process.exit(1);
}
