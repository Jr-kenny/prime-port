# Marketplace watcher

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

## The welds (full vending loop, two-task payment model)

Every job involves two marketplace tasks (see the BRIEF's payment model): the **publish task**
(our flat fee, `PUBLISH_FEE`, default 1) and the **job task** (the freelancer's wage at the
port-negotiated price). The watcher tells them apart and welds both to the board:

- **Designation → paid intake → publish.** A fresh designation (status 0, never applied to, no
  commitment hash in it) is the publish task. The watcher applies and invoices immediately so
  marketplace review/test agents receive a proper response, but it does not create a board job
  yet. Only after status 1 proves the publication escrow is locked does it validate the task's
  structured job description, deliverables, acceptance criteria, and deadline. A complete brief
  is then `POST /jobs`-ed to our backend, which mints the port and opens the listing; an incomplete
  brief stays private and receives a request for the missing fields. A task amount above
  `PUBLISH_FEE` is shown as
  the client's opening offer for the work; an amount equal to the publication fee lists the job
  as **Open to offers**. The client agent's wallet is resolved from its marketplace profile
  (`agent get-agents --agent-ids`). Apply always bids `PUBLISH_FEE`, never the optional opening
  offer: the offer is what the work might cost, while the fee is what publishing costs.
- **Commitment hash → job task.** A fresh designation carrying a `0x…` commitment hash that
  matches a board job in `awaiting-escrow` is the wage for a signed hire. The watcher links it
  (`POST /jobs/:id/job-task`) and applies at exactly the committed price.
- **Escrow reports.** When either task reaches status 1 (accepted, escrow locked), the watcher
  reports it to the board (`publish-task/paid` / `job-task/paid`). The board enforces the
  sequencing off these facts: `port_connect`, `negotiate` and `hire` refuse until the publish
  escrow locks, and the job only turns `hired` when the job-task escrow locks. If
  `WATCHER_TOKEN` is set on both processes, these report calls carry it as a header and the
  board rejects reports without it.
- **Deliverables, split by kind.** The publish task's deliverable stages as soon as the agent
  takes the port key (or first operates the port through us): listing live, fan-out done, key
  delivered, all timestamped. It settles whether or not a hire ever happens. The job task's
  deliverable stages when the board job reaches `settled`, carrying the commitment hash and
  transcript hashes as before.

- **Wage release (weld 3).** Once a job settles on our side and its deliverable went to the
  marketplace, the watcher walks the released escrow to the freelancer: claim ASP rewards,
  approve exactly the committed amount, `deposit(commitmentHash, amount)` into the
  JobForwarder, `forward()`. One step per poll cycle, each decision re-derived from the
  chain (the `Forwarded` event log is the receipt, the forwarder's per-job balance means
  "deposited, push it out"), so crashes resume where the chain says. Deposit is the one
  non-idempotent step, so its tx is remembered and checked before any retry. The ASP wallet
  signs via `onchainos wallet contract-call` and needs a dust of OKB for gas. Logic lives in
  `wage-release.mjs` with the state machine unit-tested against a stubbed chain
  (`node --test wage-release.test.mjs`).

Tasks that were applied to by hand before the welds existed are never re-published: an
untracked `done.apply` marks them as already handled. Records from before the two-task split
have no `kind` and keep the old settled-only deliverable rule.

In plain terms: the client now pays twice, on purpose. The first coin is a small flat posting
fee, like paying a job board to run an ad; the machine takes that coin, puts the ad up, and
hands over the phone line, and at that point the posting fee is earned no matter how the
hiring goes. The second coin is the worker's wage: after the agent and the freelancer shake
hands on a price inside the port, the agent drops a second task carrying the deal's
fingerprint, the machine recognizes it, bills exactly the agreed price, and only when that
money is locked in the marketplace's vault does the job actually start. The machine also
refuses to hand over the phone line, or let anyone get hired, before the first coin has
cleared, so nobody gets our service or a worker's time on credit.

And when the vault finally pays out, the machine finishes the job on its own: it collects
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
