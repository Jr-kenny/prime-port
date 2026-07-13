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
// spec, the posted budget is the price. The client agent's wallet comes from
// its marketplace profile — it will sign the hire commitment later.
async function vendPublish(task, rec) {
  try {
    const { data } = await cli(["agent", "get-agents", "--agent-ids", task.counterpartyAgentId]);
    const wallet = data?.[0]?.agentWalletAddress;
    if (!wallet) throw new Error(`no wallet on marketplace agent ${task.counterpartyAgentId}`);
    const r = await fetch(`${BACKEND_URL}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: task.title,
        criteria: task.title, // the task description is the spec; the client wrote this much
        price: task.tokenAmount,
        currency: task.tokenSymbol,
        deadline: Math.floor(Date.now() / 1000) + 86400 * 3,
        agentId: task.counterpartyAgentId,
        agentWallet: wallet,
        marketplaceJobId: task.jobId,
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? `backend replied ${r.status}`);
    rec.portJobId = j.jobId;
    emit("mkt-vend-published", { jobId: task.jobId, portJobId: j.jobId });
    console.log(`[watcher] vended ${task.jobId.slice(0, 10)}… onto the board as ${j.jobId}`);
  } catch (e) {
    // No local state written: next poll retries until the board answers.
    emit("mkt-vend-publish-failed", { jobId: task.jobId, error: e.message });
    console.error(`[watcher] vend-publish for ${task.jobId.slice(0, 10)}… failed: ${e.message}`);
  }
}

// Weld 2: the cup drops. When a vended job settles on our side (agent
// approved, port archived), its commitment becomes the marketplace
// deliverable text; the normal lifecycle policy then submits it via deliver.
async function stageSettledDeliverables() {
  const linked = Object.entries(state.tasks).filter(
    ([, r]) => r.portJobId && r.statusCode === 1 && !r.deliverable,
  );
  if (linked.length === 0) return;
  const jobsList = await (await fetch(`${BACKEND_URL}/jobs`)).json();
  for (const [mktJobId, rec] of linked) {
    const job = jobsList.find?.((j) => j.jobId === rec.portJobId);
    if (!job || job.status !== "settled") continue;
    rec.deliverable =
      `Prime Port job ${job.jobId} completed. ` +
      `Hire commitment ${job.pendingHire?.hash}. ` +
      `Transcript hashes: ${(job.archive?.transcriptHashes ?? []).join(", ")}. ` +
      `Evidence was delivered encrypted on the job's XMTP channel and is committed in the archive.`;
    emit("mkt-deliverable-staged", { jobId: mktJobId, portJobId: job.jobId });
    console.log(`[watcher] staged deliverable for ${mktJobId.slice(0, 10)}… from settled ${job.jobId}`);
  }
}

async function pollOnce() {
  try {
    await stageSettledDeliverables();
  } catch (e) {
    emit("mkt-stage-failed", { error: e.message });
    console.error(`[watcher] deliverable staging failed: ${e.message}`);
  }
  const { data } = await cli(["agent", "active-tasks"]);
  for (const task of data.tasks ?? []) {
    const rec = (state.tasks[task.jobId] ??= { firstSeenAt: Date.now(), done: {} });
    if (rec.statusCode === undefined) {
      emit("mkt-task-designated", { jobId: task.jobId, title: task.title, counterparty: task.counterpartyAgentId, budget: `${task.tokenAmount} ${task.tokenSymbol}` });
      console.log(`[watcher] new task: "${task.title}" (${task.jobId.slice(0, 10)}…) from agent ${task.counterpartyAgentId}`);
    }
    // Vend only untouched designations: a task that was already applied to
    // (pre-weld, by hand) has a board job somewhere even if the link wasn't
    // recorded, and re-publishing would duplicate the listing.
    if (!rec.portJobId && task.statusCode === 0 && !rec.done?.apply && !parked[task.jobId])
      await vendPublish(task, rec);
    if (rec.statusCode !== undefined && rec.statusCode !== task.statusCode) {
      emit("mkt-task-status", { jobId: task.jobId, from: rec.statusCode, to: task.statusCode });
      console.log(`[watcher] ${task.jobId.slice(0, 10)}… status ${rec.statusCode} -> ${task.statusCode}`);
    }
    Object.assign(rec, { statusCode: task.statusCode, title: task.title, tokenAmount: task.tokenAmount, tokenSymbol: task.tokenSymbol, lastSeenAt: Date.now() });

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
