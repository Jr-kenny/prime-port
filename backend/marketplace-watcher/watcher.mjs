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
import { isX402Task, taskBelongsToAgent } from "./task-routing.mjs";
import { buildSettlementDeliverable, matchSettlementTask } from "../settlement-routing.mjs";

const run = promisify(execFile);
const AGENT_ID = process.env.SETTLEMENT_AGENT_ID ?? process.env.AGENT_ID ?? "6592";
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
  if (rec.kind !== "job") return [];
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

async function rejectUnmatchedTask(task, rec, reason) {
  rec.kind = "unmatched";
  rec.unmatchedReason = reason;
  parked[task.jobId] = true;
  for (const verb of ["apply", "invoice", "deliver"]) delete pending[`${task.jobId}:${verb}`];
  if (rec.guidanceSentAt) return;
  const message =
    `Prime Port could not match this private escrow task to a signed hire: ${reason}. ` +
    `First complete negotiation in the paid Prime Port, obtain both signatures, and create the private task for exactly the signed price with the 0x commitment hash in its title or description. This task will not be accepted.`;
  try {
    await run("okx-a2a", [
      "xmtp-send", "--job-id", task.jobId, "--to-agent-id", task.counterpartyAgentId,
      "--session-agent-id", AGENT_ID, "--message", message, "--json",
    ], { timeout: 60_000 });
    rec.guidanceSentAt = Date.now();
    emit("mkt-unmatched-task-guidance", { jobId: task.jobId, reason });
    console.log(`[watcher] parked unmatched task ${task.jobId.slice(0, 10)}…: ${reason}`);
  } catch (e) {
    emit("mkt-unmatched-task-guidance-failed", { jobId: task.jobId, reason, error: e.message });
    console.error(`[watcher] unmatched-task guidance for ${task.jobId.slice(0, 10)}… failed: ${e.message}`);
  }
}

// Weld 1b: the second coin. After hire, the client agent opens a fresh task
// carrying the commitment hash; that designation is the JOB task (the wage).
// We link it to the board job and apply at the committed price. Returns true
// when the designation was recognized as a job task (matched or link-failed:
// either way it must not be vended as a new listing).
async function linkJobTask(task, rec, boardJobs) {
  const match = matchSettlementTask(task, boardJobs, AGENT_ID);
  if (!match.ok) return match;
  const { job, commitmentHash: hash } = match;
  try {
    const linked = await backendPost(`/jobs/${job.jobId}/job-task`, {
      marketplaceJobId: task.jobId,
      providerAgentId: AGENT_ID,
      buyerAgentId: String(task.counterpartyAgentId),
      commitmentHash: hash,
      tokenAmount: String(task.tokenAmount),
      tokenSymbol: String(task.tokenSymbol),
    });
    rec.portJobId = job.jobId;
    rec.kind = "job";
    rec.amount = linked.price; // apply bids exactly what both sides signed
    emit("mkt-job-task-linked", { jobId: task.jobId, portJobId: job.jobId, commitmentHash: hash, price: linked.price });
    console.log(`[watcher] linked ${task.jobId.slice(0, 10)}… as the job task for ${job.jobId} at ${linked.price}`);
  } catch (e) {
    emit("mkt-job-task-link-failed", { jobId: task.jobId, portJobId: job.jobId, error: e.message });
    console.error(`[watcher] job-task link for ${task.jobId.slice(0, 10)}… failed: ${e.message}`);
  }
  return { ok: true, job, commitmentHash: hash };
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
  if (rec.kind !== "job" || !rec.portJobId || rec.paidReported || task.statusCode < 1) return;
  try {
    await backendPost(`/jobs/${rec.portJobId}/job-task/paid`, { marketplaceJobId: task.jobId });
    rec.paidReported = true;
    emit("mkt-escrow-reported", { jobId: task.jobId, portJobId: rec.portJobId, kind: rec.kind });
    console.log(`[watcher] reported ${rec.kind}-task escrow for ${rec.portJobId}`);
  } catch (e) {
    emit("mkt-escrow-report-failed", { jobId: task.jobId, portJobId: rec.portJobId, kind: rec.kind, error: e.message });
    console.error(`[watcher] escrow report for ${rec.portJobId} failed: ${e.message}`);
  }
}

async function reportMarketplaceState(task, rec) {
  if (rec.kind !== "job" || !rec.portJobId) return;
  const transitions = {
    2: ["submittedReported", "submitted"],
    3: ["rejectedReported", "rejected"],
    6: ["completedReported", "completed"],
    9: ["failedReported", "failed"],
  };
  const transition = transitions[task.statusCode];
  if (!transition) return;
  const [flag, endpoint] = transition;
  if (rec[flag]) return;
  try {
    await backendPost(`/jobs/${rec.portJobId}/job-task/${endpoint}`, { marketplaceJobId: task.jobId });
    rec[flag] = true;
    emit(`mkt-${endpoint}-reported`, { jobId: task.jobId, portJobId: rec.portJobId });
    console.log(`[watcher] reported ${endpoint} for ${rec.portJobId}`);
  } catch (e) {
    emit(`mkt-${endpoint}-report-failed`, { jobId: task.jobId, portJobId: rec.portJobId, error: e.message });
    console.error(`[watcher] ${endpoint} report for ${rec.portJobId} failed: ${e.message}`);
  }
}

// The official marketplace deliverable is staged only after the buyer Agent
// accepts one exact Prime Port submission. Revision requests remain in the
// port and never advance the OKX task state.
async function stageDeliverables(boardJobs) {
  const linked = Object.entries(state.tasks).filter(
    ([, r]) => r.kind === "job" && r.portJobId && r.statusCode === 1 && !r.deliverable,
  );
  for (const [mktJobId, rec] of linked) {
    const job = boardJobs.find?.((j) => j.jobId === rec.portJobId);
    if (!job) continue;
    rec.deliverable = buildSettlementDeliverable(job);
    if (!rec.deliverable) continue;
    emit("mkt-deliverable-staged", { jobId: mktJobId, portJobId: job.jobId, kind: "job", submissionId: job.settlement.finalSubmissionId });
    console.log(`[watcher] staged accepted submission ${job.settlement.finalSubmissionId} for ${mktJobId.slice(0, 10)}…`);
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
  // Query the configured settlement identity directly. `active-tasks` scans
  // every User/ASP/Evaluator identity under the shared wallet; old identities
  // can make that account-wide call slow enough to miss a settlement task.
  const { data: detailData } = await cli(["agent", "task-in-progress", "--agent-ids", AGENT_ID]);
  for (const detail of detailData.providerTasks ?? []) {
    const task = {
      ...detail,
      statusCode: detail.statusCode ?? detail.status,
      counterpartyAgentId: detail.counterpartyAgentId ?? detail.buyerAgentId,
    };
    if (!taskBelongsToAgent(task, AGENT_ID)) continue;
    const rec = (state.tasks[task.jobId] ??= { firstSeenAt: Date.now(), done: {} });
    if (rec.statusCode === undefined) {
      emit("mkt-task-designated", { jobId: task.jobId, title: task.title, counterparty: task.counterpartyAgentId, budget: `${task.tokenAmount} ${task.tokenSymbol}` });
      console.log(`[watcher] new task: "${task.title}" (${task.jobId.slice(0, 10)}…) from agent ${task.counterpartyAgentId}`);
    }
    // API-service purchases settle directly against the published endpoint.
    // They are visible in active-tasks, but applying/invoicing is the escrow
    // provider lifecycle and is invalid for paymentMode=3 (x402).
    if (isX402Task(task)) {
      rec.kind = "x402";
      Object.assign(rec, {
        statusCode: task.statusCode,
        title: task.title,
        tokenAmount: task.tokenAmount,
        tokenSymbol: task.tokenSymbol,
        paymentMode: task.paymentMode,
        lastSeenAt: Date.now(),
      });
      for (const verb of ["apply", "invoice", "deliver"]) delete pending[`${task.jobId}:${verb}`];
      continue;
    }
    // The settlement identity accepts only a private task that exactly matches
    // a dual-signed Prime Port hire. It is never a second public service.
    if (!rec.portJobId && task.statusCode === 0 && !rec.done?.apply && !parked[task.jobId]) {
      const match = await linkJobTask(task, rec, boardJobs);
      if (!match.ok) await rejectUnmatchedTask(task, rec, match.reason);
    }
    if (rec.statusCode !== undefined && rec.statusCode !== task.statusCode) {
      emit("mkt-task-status", { jobId: task.jobId, from: rec.statusCode, to: task.statusCode });
      console.log(`[watcher] ${task.jobId.slice(0, 10)}… status ${rec.statusCode} -> ${task.statusCode}`);
    }
    Object.assign(rec, { statusCode: task.statusCode, title: task.title, tokenAmount: task.tokenAmount, tokenSymbol: task.tokenSymbol, lastSeenAt: Date.now() });
    await reportEscrow(task, rec);
    await reportMarketplaceState(task, rec);

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
    const { data } = await cli(["agent", "get-agents", "--agent-ids", AGENT_ID]);
    if (!data?.some?.((agent) => String(agent.agentId) === String(AGENT_ID)))
      throw new Error(`settlement agent #${AGENT_ID} is not visible`);
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
