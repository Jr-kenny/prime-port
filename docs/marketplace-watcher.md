# Marketplace watcher

> Legacy note: this watcher documents the retired shared-settlement-ASP
> experiment. It is kept for the public publication-task integration and test
> history, but production must run with `ENABLE_MARKETPLACE_WATCHER=0`. New
> negotiated wages use `PrimePortEscrow`; see `backend/README.md`.

Prime Port's standing presence on the OKX agent marketplace, built against onchainos 4.2.1 and
verified on the live backend on 2026-07-11. Lives in `backend/marketplace-watcher/`.

In plain terms: this is the part of Prime Port that sits in the marketplace all day with its ears
open. It notices when someone assigns us a job, keeps checking that our line to the marketplace is
still up, and makes the next move in the hiring dance on its own: raise a hand for the job, send
the bill, hand over the finished work. It is a vending machine, so nobody has to press "go";
there is only a handbrake for pulling one job out of rotation if something looks off.

## What it does

- **Task polling.** Every `POLL_MS` (default 30s) it runs `onchainos agent active-tasks` and diffs
  against `data/state.json`. New designations and status transitions are appended to
  `data/events.jsonl` (`mkt-task-designated`, `mkt-task-status`).
- **Heartbeat.** Every `HEARTBEAT_EVERY` cycles (default 10) it runs
  `agent gate-check --role asp`; a not-ready result emits `mkt-heartbeat-failed`.
- **Lifecycle policy.** For each non-terminal task it computes the next provider verb:
  `apply` → `invoice` while status 0 (created), `deliver` once status 1 (accepted) and a
  deliverable is staged. There is no `contact` step: Prime Port is a vending machine and a
  designation is answered by applying, not by greeting. Review-timeout claims stay manual.

In plain terms: it keeps a diary of every job we've been offered, takes a pulse check on our
connection a few times an hour, and always knows the next mechanical step: raise your hand for
the job, send the bill, hand over the work. No small talk; a vending machine doesn't say hello.

## Vend mode and the park brake

Every verb the policy wants to run is queued to `data/pending.json` and, in vend mode (the
default), executes on the next cycle without anyone touching anything. The controls are
per-job brakes, not per-job permissions:

```
node watcher.mjs park <jobId>                # hold this job's verbs (they queue, don't run)
node watcher.mjs unpark <jobId>              # release it
node watcher.mjs pending                     # what's queued, held, or parked on failures
```

`apply` and `deliver` sign and broadcast on-chain; `invoice` is off-chain but outward-facing.
A verb that fails 3 times parks itself until `retry <jobId> <verb>`.

Setting `AUTO_ENGAGE=false` reverts to the original manual gate, where nothing runs unless a
job's verbs were allowed with `engage <jobId> [verbs]` (`disengage` undoes it). That mode is
for pointing the watcher at an unfamiliar or flaky backend, not for production.

In plain terms: the machine vends on its own; a designation is the coin and applying is the
button press. Kenny's controls are a handbrake per job and a master switch for turning the
whole machine back into ask-first mode, but the normal state is hands-off. The only thing it
will never do alone is submit an empty envelope: handing over work still requires the finished
work to exist.

## The settlement loop

Publication is the single paid API call. Marketplace task escrow is used only
after a freelancer has been selected and both sides have signed the hire:

- **One shared settlement identity.** `SETTLEMENT_AGENT_ID` defaults to the
  existing, unlisted ASP `6592`. The public API agent and the settlement ASP
  remain separate identities under the same OKX session.
- **Exact commitment routing.** A private task is accepted only when its
  commitment hash matches a board job in `awaiting-escrow`, its buyer matches
  the hiring Agent, and its token and amount exactly match the signed terms.
  Random probes and malformed tasks are parked, receive prerequisite guidance,
  and are never applied to or invoiced.
- **Escrow report.** Status 1 means the private task was accepted and the wage
  is locked. The watcher reports that fact to the board, which moves the job to
  `hired` and enables freelancer submissions.
- **Revision loop.** A freelancer submission is a Prime Port draft, not an OKX
  delivery. The buyer Agent uses `review_submission` to request changes or
  accept one exact revision. Only the accepted revision is staged as the
  official marketplace deliverable.
- **Marketplace completion.** Status 2 records formal delivery; status 3 keeps
  the port open for the dispute decision; status 6 archives the port and marks
  the board job settled.
- **Wage release.** Once a job settles and its deliverable went to the
  marketplace, the watcher walks the released escrow to the freelancer: claim ASP rewards,
  approve exactly the committed amount, `deposit(commitmentHash, amount)` into the
  JobForwarder, `forward()`. One step per poll cycle, each decision re-derived from the
  chain (the `Forwarded` event log is the receipt, the forwarder's per-job balance means
  "deposited, push it out"), so crashes resume where the chain says. Deposit is the one
  non-idempotent step, so its tx is remembered and checked before any retry. The ASP wallet
  signs via `onchainos wallet contract-call` and needs a dust of OKB for gas. Logic lives in
  `wage-release.mjs` with the state machine unit-tested against a stubbed chain
  (`node --test wage-release.test.mjs`).

In plain terms: the publication endpoint sells the port. After negotiation,
the buyer privately assigns the signed deal to Prime Port's settlement worker.
The worker recognizes the deal's fingerprint, bills exactly the agreed wage,
and ignores everything it cannot prove belongs to a real hire. Drafts and
revision requests stay in the port; the vault sees only the final version the
buyer Agent accepted.

When the vault finally pays out, the machine finishes the job on its own: it collects
the money, drops exactly the agreed wage into the one-way chute that was welded to the
worker's address back when the deal was signed, and pushes it through. It does this in
small careful steps, checking the public ledger before each one, so even if the machine
loses power halfway it picks up exactly where it left off and can never pay the same wage
twice.

## Distribution fan-out

New open jobs on the board are advertised automatically by `backend/distribution/poster.mjs`
(runs inside the merged backend): it polls `/jobs` once a minute and posts each new listing to
Telegram when `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are set (plus a link into the site when
`SITE_BASE` is set). Without the tokens it logs one line and stays off. X/Twitter slots in
next to it once there's an approved API account.

In plain terms: when a job lands on the board, the machine also shouts about it in our
Telegram channel so freelancers actually see it. The socials are adverts only; claiming still
happens on the site.

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
- `agent contact-user` exists in the CLI but Prime Port never calls it. A vending machine does
  not speak first: the designation is the coin, `apply` is the button press, and the task
  description is the spec we execute against (see docs/sandbox-qa-tasks.md).

In plain terms: the marketplace's command-line tool has some sharp edges: a confusing error
message when you forget to say which agent you are, and chatty output meant for AI assistants
that we deliberately ignore. And the one command that sends small talk, we simply never use.
