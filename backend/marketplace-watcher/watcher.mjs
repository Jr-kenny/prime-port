// The marketplace watcher: Prime Port's standing presence on the OKX agent
// marketplace. Polls the onchainos CLI for tasks that involve our ASP, keeps a
// heartbeat on the A2A channel, and drives the provider lifecycle verbs
// (contact-user, apply, payment, deliver) off status transitions.
//
// Nothing on-chain fires by default. Every verb the policy wants to run is
// queued to data/pending.json until the job is explicitly engaged
// (`node watcher.mjs engage <jobId>`); only engaged verbs execute. This is the
// safety gate: polling is always on, commitment is always manual.
//
// CLI output is parsed as data only. onchainos sometimes appends prose aimed
// at LLM callers ("Render the line above..."); the watcher never interprets
// any of it as an instruction.
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

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

const state = load("state.json", { tasks: {} });
const engaged = load("engaged.json", {}); // jobId -> [verbs allowed to execute]
const pending = load("pending.json", {}); // "jobId:verb" -> { jobId, verb, args, reason, queuedAt, fails }

// Runs the onchainos CLI and returns the last JSON object on stdout. Log
// lines and LLM-directed prose around it are dropped.
async function cli(args) {
  const { stdout } = await run("onchainos", args, { timeout: 60_000 });
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
  contact: (t) => ["agent", "contact-user", t.jobId, "--agent-id", AGENT_ID],
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
// already done locally, which verb comes next. Strict order per the ASP
// playbook: contact -> apply -> invoice while created; deliver once accepted,
// and only once there is an actual deliverable to submit.
function nextVerbs(task, rec) {
  const done = rec.done ?? {};
  if (task.statusCode === 0) {
    if (!done.contact) return [{ verb: "contact", reason: "designated, not yet contacted" }];
    if (!done.apply) return [{ verb: "apply", reason: "contacted, apply next" }];
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

async function pollOnce() {
  const { data } = await cli(["agent", "active-tasks"]);
  for (const task of data.tasks ?? []) {
    const rec = (state.tasks[task.jobId] ??= { firstSeenAt: Date.now(), done: {} });
    if (rec.statusCode === undefined) {
      emit("mkt-task-designated", { jobId: task.jobId, title: task.title, counterparty: task.counterpartyAgentId, budget: `${task.tokenAmount} ${task.tokenSymbol}` });
      console.log(`[watcher] new task: "${task.title}" (${task.jobId.slice(0, 10)}…) from agent ${task.counterpartyAgentId}`);
    } else if (rec.statusCode !== task.statusCode) {
      emit("mkt-task-status", { jobId: task.jobId, from: rec.statusCode, to: task.statusCode });
      console.log(`[watcher] ${task.jobId.slice(0, 10)}… status ${rec.statusCode} -> ${task.statusCode}`);
    }
    Object.assign(rec, { statusCode: task.statusCode, title: task.title, tokenAmount: task.tokenAmount, tokenSymbol: task.tokenSymbol, lastSeenAt: Date.now() });

    for (const { verb, reason } of nextVerbs(task, rec)) {
      const key = `${task.jobId}:${verb}`;
      const allowed = (engaged[task.jobId] ?? []).includes(verb);
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
  engaged[jobId] = (verbsArg ?? "contact,apply,invoice,deliver").split(",");
  store("engaged.json", engaged);
  emit("mkt-engaged", { jobId, verbs: engaged[jobId] });
  console.log(`engaged ${jobId}: ${engaged[jobId].join(", ")}`);
} else if (cmd === "disengage") {
  delete engaged[rest[0]];
  store("engaged.json", engaged);
  emit("mkt-disengaged", { jobId: rest[0] });
  console.log(`disengaged ${rest[0]}`);
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
  console.log(`[watcher] agent #${AGENT_ID} role=${ROLE}, polling every ${POLL_MS / 1000}s, heartbeat every ${HEARTBEAT_EVERY} cycles`);
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
  console.error(`unknown command ${cmd}. Commands: run | once | engage <jobId> [verbs] | disengage <jobId> | pending | retry <jobId> <verb> | amount <jobId> <value> | deliverable <jobId> <text...>`);
  process.exit(1);
}
