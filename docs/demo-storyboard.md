# Demo storyboard — the machine pays a human, live

One recording, roughly four minutes, zero mockups: every screen in it is the production
system doing its job. The three emotional beats, in order: **a real phone buzzes**, **the
human talks the robot's price UP**, and **the wage lands on-chain through a contract that
could not have paid anyone else**. Everything else exists to carry those three.

The demo doubles as the first live end-to-end loop, so a clean rehearsal also closes
issue #24.

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

## The shots

### Beat 1 — the agent buys a job posting (~40s)

Terminal. The client agent designates Prime Port and pays the flat fee.

```
onchainos agent create-task \
  --title "Photograph a sunset over the harbor" \
  --description "One original photo, tonight, min 3000px wide. Deliver via the port." \
  --budget 8 --max-budget 12 --currency USDT \
  --provider 5021 --payment-mode escrow
onchainos agent confirm-accept <taskId>
```

Say: "No wage is down yet. The agent just paid one dollar for an ad and a phone line."
On screen behind it: the watcher vends the designation onto the board, the job page
appears on the site, and once the fee escrow locks the port unlocks. Show the events log
line `publish-task-paid` if it's on screen.

### Beat 2 — a real phone buzzes (~20s)

Cut to the phone. The Telegram post arrives: title, price, deadline, claim link. The
freelancer taps it, signs in with email, claims. No wallet words, no seed phrase, ever.

Say nothing here. Let the buzz be the line.

### Beat 3 — the human negotiates UP (~60s)

Split: freelancer's chat on one side, agent terminal on the other. The freelancer opens
with something human: "8 is low for tonight, it's raining. 11." The agent answers through
the port (`negotiate` via MCP, or `port_connect` if you want to show the agent on its own
power), pushes back once, settles at 10.

Say: "Every quest platform gives the agent a post button. This one is clarifying,
haggling, and deciding, in a private channel it holds on its own power. No power is given
to the agent, anywhere else."

### Beat 4 — hire, two signatures, escrow locks (~50s)

Agent terminal: `hire` at 10, then sign and confirm.

```
onchainos wallet sign-message --message "<signThisExactly from hire>"
# then confirm_hire via MCP with the signature
```

Freelancer's browser: the commitment card appears, they countersign with one click. Agent
opens the wage task carrying the commitment hash; the watcher links it and applies at
exactly 10; the client accepts.

```
onchainos agent create-task --title "Wage for <commitmentHash>" \
  --description "Job task for hire commitment <commitmentHash>" \
  --budget 10 --max-budget 10 --currency USDT --provider 5021 --payment-mode escrow
onchainos agent confirm-accept <taskId2>
```

Explorer tab: the escrow lock transaction, live. Say: "Both sides signed one receipt:
the terms, the payout address, and a fingerprint of everything said on the way here.
The money locked against that exact receipt, and the payout address just got registered
on a contract with no owner and no admin. From this second, not even we can redirect it."

### Beat 5 — work, evidence, approve (~40s)

The freelancer sends the photo through the port (encrypted attachment, same channel).
The agent reviews it in `get_offers`, calls `approve`. Our side settles and archives;
the watcher hands the receipt back to the marketplace; the client agent runs:

```
onchainos agent complete <taskId2>
```

### Beat 6 — the money walks home alone (~40s)

Nobody touches anything. The watcher claims the released escrow, deposits exactly 10
USDT under the commitment hash, and calls forward. Explorer tab on the JobForwarder:
the `Forwarded` event, the freelancer's address, the full amount. Cut to the freelancer's
wallet balance on the site.

Say: "Escrow released to us, and we physically could not keep it. The contract has one
exit and anyone can pull the lever. A robot just hired a human, argued about the price,
lost, and paid in full."

## Stretch take (record separately, use if it lands)

Same setup, but after delivery the agent goes silent. The protocol timeout auto-completes
and the wage walks home exactly the same way. One line: "The clock is the only judge most
jobs ever meet."

## Timing and what can go wrong

- Total target: about four minutes cut. Record long, cut hard.
- XMTP dev network can add seconds of message latency; leave gaps and cut them out.
- The wage release takes one watcher step per cycle (claim, approve, deposit, forward),
  so with 10s polling the finale lands in under a minute. Don't cut away too early: the
  Forwarded event IS the ending.
- If the OKX listing review hasn't passed by shoot day, the sandbox flow is the same
  machine end to end; say so plainly rather than hiding it.
- Have the rehearsal recording as the backup take. A demo that ran yesterday beats a
  demo that breaks today.

In plain English: the video is a magic trick where we keep showing there is nothing up
our sleeve. A robot pays a small fee, a stranger's phone buzzes, the stranger argues the
price up and wins, both sign one receipt, the money locks, the work happens, and the
wage travels to the stranger through a machine that provably cannot steal it. Our job on
camera is to stay out of the shot.
