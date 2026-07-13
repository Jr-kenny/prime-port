# Demo storyboard — the machine pays a human, in 90 seconds

OKX caps the video at 90 seconds, so this is not a walkthrough, it is a proof reel:
hard cuts, a voiceover carrying the story, and no shot on screen longer than it takes
to read one line. Zero mockups, every frame is the production system. The three beats
everything serves: **a real phone buzzes**, **the human talks the robot's price UP**,
and **the wage lands on-chain through a contract that could not have paid anyone else**.

Record the full loop live at natural speed (it takes a few minutes end to end), then
cut it down. The uncut recording doubles as the first live end-to-end loop (closes
issue #24) and as backup evidence if judges want the long version; link it from the
submission page.

## Cast and props

- **The client agent**: a second marketplace agent with the client role (Kenny's wallet
  can hold one per role, or a teammate registers it). Needs a few USDT and a dust of OKB
  on X Layer. Driven live from a terminal: onchainos for marketplace verbs, an MCP client
  for the port verbs (`e2e.mjs` shows every call shape).
- **The freelancer**: a real person with a real phone. Telegram joined to the channel,
  never seen the job before the buzz. They claim on the site with plain email login.
- **Prime Port itself**: nobody. That is the point. The Render container does everything
  in the middle unattended.
- **Screens to capture**: terminal (agent side), the phone (over the shoulder or screen
  mirror), the freelancer's browser, the X Layer explorer, and the Render events log
  tailing in a corner if you want the machine's heartbeat visible.

## Pre-flight, the day before

- [ ] Rehearse the full loop once on the sandbox. Whatever breaks, fix, re-run.
- [ ] Drop `POLL_MS=10000` and `REGISTER_EVERY_MS=10000` on Render for the shoot, so the
      watcher's moves land in seconds instead of half-minutes. Restore after.
- [ ] Client agent funded: USDT for the fee plus the wage (say 10), OKB dust for gas.
- [ ] Freelancer phone: Telegram notifications ON, site login tested once beforehand so
      the embedded wallet already exists (first-time wallet provisioning is slow TV).
- [ ] Explorer tabs pre-opened: the JobForwarder address page and the USDT token page.
- [ ] Registrar and ASP wallets still hold OKB (they do; one loop costs ~0.000005).

## The 90-second cut

Six shots, one voiceover line each. The voiceover is the spine; the screens are
evidence flashing behind it. Sub-second dead air anywhere means cut harder.

### Shot 1 (0:00–0:12) — the agent pays for an ad, not a worker

Terminal: `create-task --provider 5021 --payment-mode escrow` then `confirm-accept`,
sped up. Overlay the job page appearing on the site.

Voiceover: "An AI agent needs a real human. It pays Prime Port one dollar for a job
ad and a private phone line. No wage is down yet."

### Shot 2 (0:12–0:24) — a real phone buzzes

Over-the-shoulder phone shot. Telegram notification, tap, email sign-in, claim. This
is the only shot allowed to breathe; the buzz is the whole point.

Voiceover: "The job fans out. A real phone buzzes. A stranger claims it with an email
address, no wallet, no seed phrase."

### Shot 3 (0:24–0:40) — the human negotiates UP

Split screen: freelancer chat / agent terminal. Two exchanges only: "8 is low for
tonight, it's raining. 11." — agent counters — "deal at 10." Settled price flashes.

Voiceover: "Then they argue about money. Every other platform gives the agent a post
button. Ours clarifies, haggles, and decides through a port it holds on its own power.
The human wins two dollars."

### Shot 4 (0:40–0:55) — two signatures, escrow locks

Fast cuts: `hire` output with the commitment hash, `wallet sign-message`, the
freelancer's one-click countersign card, the escrow-lock tx on the explorer.

Voiceover: "Both sign one receipt: terms, payout address, a fingerprint of the whole
conversation. The wage locks against it, and the payout address is burned into a
contract with no owner. From this second nobody can redirect it, including us."

### Shot 5 (0:55–1:08) — work, evidence, approve

The photo lands as an encrypted attachment in the chat; the agent's `get_offers` shows
it decrypted; `approve`; client runs `complete`.

Voiceover: "The work comes back through the same private line, the agent checks it and
approves, and escrow releases."

### Shot 6 (1:08–1:30) — the money walks home alone

The finale, uncut feel: events log lines scrolling (`wage-deposited`,
`wage-forwarded`), then the explorer showing the Forwarded event with the freelancer's
address and the full amount, then their balance on the site.

Voiceover: "The money walks the last mile alone: through a forwarding contract with
exactly one exit, in full, our fee already paid at the door. A robot hired a human,
lost the negotiation, and paid up. That's Prime Port."

## Cutting-room rules

- Record the whole loop live at natural speed; the machine takes a few minutes end to
  end. The cut compresses time, never fakes it: sped-up footage and hard cuts are fine,
  staged screens are not.
- The timeout path ("the clock is the only judge most jobs ever meet") does not fit in
  90 seconds. Put one sentence about it on the submission page instead, next to the
  link to the uncut recording.
- XMTP dev latency and watcher poll gaps disappear in the edit; that is what the edit
  is for. With `POLL_MS=10000` the finale's four steps land inside a minute of real
  time, so shot 6 barely needs compressing.
- If the OKX listing review hasn't passed by shoot day, the sandbox flow is the same
  machine end to end; say so plainly on the page rather than hiding it.
- Keep the rehearsal recording. A demo that ran yesterday beats a demo that breaks
  today.

## Command sheet for the live run (rehearsal and shoot)

The client agent's side, in order. Port-side calls (`get_offers`, `negotiate`, `hire`,
`confirm_hire`, `approve`) go over MCP; `backend/mcp-server/e2e.mjs` shows every call
shape working.

```
# 1. publish task: buys the ad + port (watcher applies at the flat fee)
onchainos agent create-task \
  --title "Photograph a sunset over the harbor" \
  --description "One original photo, tonight, min 3000px wide. Deliver via the port." \
  --budget 8 --max-budget 12 --currency USDT \
  --provider 5021 --payment-mode escrow
onchainos agent confirm-accept <taskId>

# 2. after negotiation: hire via MCP, then sign the commitment
onchainos wallet sign-message --message "<signThisExactly from hire>"
# confirm_hire via MCP with that signature; freelancer countersigns in the web app

# 3. wage task: carries the commitment hash so the watcher links it
onchainos agent create-task --title "Wage for <commitmentHash>" \
  --description "Job task for hire commitment <commitmentHash>" \
  --budget 10 --max-budget 10 --currency USDT --provider 5021 --payment-mode escrow
onchainos agent confirm-accept <taskId2>

# 4. after evidence + approve (MCP): release the wage escrow
onchainos agent complete <taskId2>
```

In plain English: ninety seconds is an elevator pitch with receipts. One voice tells
the story straight through while the screens flash proof: the buzz, the haggle the
robot loses, and the payment no one could have stolen. Everything slow, technical, or
explanatory moves to the submission page; the video's only job is to make a judge sit
up in the first fifteen seconds and believe the last fifteen.
