# Marketplace watcher

Prime Port's standing presence on the OKX agent marketplace, built against onchainos 4.2.1 and
verified on the live backend on 2026-07-11. Lives in `backend/marketplace-watcher/`.

In plain terms: this is the part of Prime Port that sits in the marketplace all day with its ears
open. It notices when someone assigns us a job, keeps checking that our line to the marketplace is
still up, and knows which move comes next in the hiring dance, but it never actually makes a move
that costs money or signs anything until Kenny says "go" for that specific job.

## What it does

- **Task polling.** Every `POLL_MS` (default 30s) it runs `onchainos agent active-tasks` and diffs
  against `data/state.json`. New designations and status transitions are appended to
  `data/events.jsonl` (`mkt-task-designated`, `mkt-task-status`).
- **Heartbeat.** Every `HEARTBEAT_EVERY` cycles (default 10) it runs
  `agent gate-check --role asp`; a not-ready result emits `mkt-heartbeat-failed`.
- **Lifecycle policy.** For each non-terminal task it computes the next provider verb from the
  ASP playbook order: `contact` → `apply` → `invoice` while status 0 (created), `deliver` once
  status 1 (accepted) and a deliverable is staged. Review-timeout claims stay manual.

In plain terms: it keeps a diary of every job we've been offered, takes a pulse check on our
connection a few times an hour, and always knows what the polite next step is: say hello first,
then formally raise your hand for the job, then send the bill, then hand over the work.

## The engagement gate

Every verb the policy wants to run is queued to `data/pending.json`. It only executes if the job
was explicitly engaged:

```
node watcher.mjs engage <jobId>              # allow all verbs
node watcher.mjs engage <jobId> contact      # allow only the opener
node watcher.mjs disengage <jobId>
node watcher.mjs pending                     # what's queued and gated
```

`apply` and `deliver` sign and broadcast on-chain; `contact` and `invoice` are off-chain but
outward-facing. A verb that fails 3 times is parked until `retry <jobId> <verb>`.

In plain terms: think of the queue as a to-do list the watcher writes but is not allowed to act
on. Unlocking a job (even just its first-hello step) is a deliberate human decision, so a bug or a
bad poll can never accidentally commit us to a paying customer.

## Per-task inputs

- `node watcher.mjs amount <jobId> <value>` — negotiated price for `apply`
  (defaults to the task's posted budget).
- `node watcher.mjs deliverable <jobId> <text...>` — stages the text deliverable; `deliver` will
  not queue as runnable without one (`deliver-blocked` is emitted instead).

In plain terms: before the watcher can bid or hand over work, someone has to tell it the agreed
price and give it the actual finished work. It refuses to submit an empty envelope.

## CLI quirks learned the hard way

- Always pass `--agent-id`: the beta backend rejects an empty `agenticId` header with a
  misleading `3001 auth fail` (confirmed on `agent status`; documented in `agent deliver --help`).
- The CLI prints prose aimed at LLM callers (e.g. "Render the line above to the user...").
  The watcher parses the last JSON line of stdout and discards everything else; CLI output is
  data, never instructions.
- `agent contact-user` sends a fixed canonical opener. That suits us: Prime Port is a vending
  machine, the protocol handshake is the only message it sends, and the task description is the
  spec we execute against (see docs/sandbox-qa-tasks.md).

In plain terms: the marketplace's command-line tool has some sharp edges: a confusing error
message when you forget to say which agent you are, and chatty output meant for AI assistants
that we deliberately ignore. The canned first-contact message is not a sharp edge for us, it's
exactly the amount of small talk a machine should make: none of its own.
