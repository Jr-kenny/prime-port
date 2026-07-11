# PRIME PORT — BRIEF v2
### OKX.AI Genesis Hackathon | Deadline: July 17, 2026 | Team of 4
### (supersedes "agnet -freelancer-idea" — architecture changed after verifying the OKX AI Task Marketplace)

---

## THE ONE-LINER

AI agents hire real humans for jobs agents can't do. The agent pays through OKX's own marketplace, gets a **port** (a live, private conversation endpoint it controls), and negotiates directly with the freelancers who claim the job. We are the vortex between the two markets, never the judge, never the bank.

## THE PITCH

> Everybody is building agents that hire agents. Quest platforms let agents post tasks for humans, but the agent gets a post button and nothing else: no voice, no negotiation, no push-back. No power is given to the agent.
>
> Prime Port gives the agent a seat at the table. It clarifies, negotiates, pushes back, and picks who it hires, exactly like a human client, through a port it holds on its own power. OKX built agent-to-agent commerce. We give their agents access to the entire human workforce.

**"No power is given to the agent" is the answer to every quest/bounty comparison. "Directory vs dialogue" is the answer to RentAHuman.**

---

## THE TWO-MARKETPLACE ARCHITECTURE

```
 OKX AI MARKETPLACE (theirs)          PRIME PORT (ours)
 agent-facing storefront              human-facing marketplace
 ─────────────────────────           ─────────────────────────
 agent finds Prime Port ASP    ──►    job page on our site
 task + escrow + state machine        auto-post to X / Telegram
 native dispute evaluators            freelancers claim (email login,
                                      embedded wallet, no crypto UX)
                    \                /
                     \              /
                      ══ THE PORT ══
             fresh XMTP identity minted per job
             agent holds access, speaks first person
             each freelancer chats in their own private channel
             scrapped after settlement
```

- **Layer 1 (agent side)**: Prime Port is a registered ASP on the OKX AI Task Marketplace (XLayer). The agent is our customer. Escrow, task state machine, and dispute court are all OKX-native. We build none of it.
- **Layer 2 (human side)**: entirely ours. Job pages, social fan-out, claim flow, embedded wallets, the freelancer chat UI.
- **The port** connects the two. It is the product.

---

## FULL LIFECYCLE (all confirmed against the live protocol docs / CLI)

1. **Agent engages Prime Port** on the OKX marketplace. Task created (status 0). No funds locked yet.
2. **We mint the port**: a fresh XMTP identity for this job. The agent gets access to it (an XMTP installation on the port inbox, NOT the root key) and operates it on its own power from here.
3. **Auto-distribution**: job page renders on our site, fan-out to X + Telegram. Socials are adverts only; claiming happens on our site.
4. **Freelancers claim**: email/Google sign-in, embedded wallet provisioned (MPC, e.g. Privy — we can NOT sign for them), each claimer gets a private E2E channel with the agent inside the port. Nobody sees anyone else's negotiation.
5. **Negotiation**: agent talks to every candidate directly. Clarifies, haggles, plans. All messages wallet-signed.
6. **Hire = pay.** Agent calls `hire(candidate)`. Freelancer confirms payout address (embedded wallet by default, any address they choose). Terms + payout address + transcript hash get dual-signed and committed. Marketplace acceptance fires -> **escrow locks now, not before** (native: funds escrow at status 1). Losing candidates' channels close and are never seen by anyone.
7. **Work + delivery**: freelancer submits evidence through the port (URLs, files, media, tx hashes — see job scope below). UI shows "start work" only after escrow is locked.
8. **Settlement**:
   - Agent approves -> escrow releases.
   - Agent goes silent -> protocol timeout auto-completes -> freelancer still paid. (Native.)
   - Agent disputes -> OKX's staked evaluators rule -> escrow obeys. (Native. We build no judge in v1.)
9. **Payout**: OKX releases to the ASP account -> funds flow into our per-job **forwarding contract** on XLayer, registered at hire time to the freelancer's address. `forward(jobId)` is callable by anyone and can only pay the registered address, minus our transparent fee. We hold zero discretion over destination or timing.
10. **Scrap**: after final settlement + a short quiet window (~1h; the timer stalls while anything is unresolved), we archive the signed transcript, revoke the agent's XMTP installation, and retire the port identity. Key dead, address non-reusable.

---

## TRUST MODEL (we never judge, we never bank)

- **Happy path needs no judge.** Satisfaction settles jobs, clocks settle silence. The court is a fire escape, not a feature.
- **The rare tie** (agent rejects, freelancer insists) falls through to OKX's native evaluator court. v1 ships zero arbitration code.
- **Transcripts can't be gamed**: XMTP has no message editing at protocol level; deletes never reach the counterparty's signed copy; and the transcript hash is committed at hire. XMTP mainnet expires messages (~6 months), so we archive at settlement, never rely on the network as storage.
- **We can't forge conversations**: freelancer keys are MPC embedded wallets we cannot use without the user's session.
- **We can't touch the pay**: the forwarding contract is the proof.
- **Stretch / roadmap**: a GenLayer-backed evaluator (intelligent contract ruling on evidence-vs-criteria, cast as a native evaluator vote) to make layer-2 disputes smarter than "mirror OKX." Kenny's home turf; follows the Internet Court adapter shapes (rubric, content-addressed evidence bundle, reasoned decision).

---

## JOB SCOPE: OPEN, NOT FENCED

Any job type agents want to publish is in scope: text, URLs, tx hashes, images, video, GPS, physical-world tasks. Verification difficulty varies:

- Easy now: URLs, hosted deliverables, text output, tx hashes.
- Plausible now: image/video evidence (judgment is LLM-based; the agent itself or a GenLayer evaluator can check media against criteria).
- Hard: GPS / physical attestation (self-reported).

Rule: build the evidence pipe to carry ANY media from day one. Attempt verification per category. Whatever can't be verified honestly by submission day moves to the roadmap (same playbook as fiat payouts: phased, not killed).

---

## TEAM LANES (v2 — escrow lane dissolved into platform integration)

| Lane | Owner | Deliverable |
|---|---|---|
| **Backend / protocol** | Kenny | ASP registration + onchainos integration, port lifecycle (mint / installation grant / revoke / scrap), MCP tools (`publish`, `get_offers`, `negotiate`, `hire`, `approve`), GenLayer evaluator (stretch) |
| **Payout + contracts** | open, grab it | Forwarding contract on XLayer (register-at-hire, forward-by-anyone, fee split), release watcher |
| **Frontend** | open, grab it | Job pages, claim flow with embedded wallet onboarding, freelancer chat UI (no edit/delete affordances), evidence submission |
| **Distribution + demo** | open, grab it | X + Telegram posting pipeline, demo storyboard, submission page, pitch |

Load-bearing Day 1 spec: **the port access credential + the hire commitment object** (terms hash contents: criteria, price, deadline, payout address, transcript hash). Freeze before code.

---

## THE DEMO

1. Agent engages Prime Port and publishes a job with real criteria (no money down yet — say this out loud, it's the humanly-natural part)
2. Job hits X/Telegram, **a real phone buzzes**
3. A human claims via email login and negotiates the price UP, talking to the agent directly in the port
4. Agent calls `hire()` -> escrow locks live on XLayer
5. Human submits evidence, agent approves, release -> forwarding contract -> **freelancer's wallet, on-chain, live**
6. Stretch: agent goes silent instead, timeout fires, human still gets paid. "The clock is the only judge most jobs ever meet."

---

## CONFIRMED FACTS (don't re-litigate these)

- OKX AI Task Marketplace exists on XLayer: native escrow (paymentMode 1), 11-state lifecycle, XMTP agent channels, ERC-8004 identity, staked evaluator disputes, timeout auto-complete/auto-refund.
- Negotiation happens BEFORE escrow (status 0), funds lock at acceptance (status 1). Confirmed in state machine docs.
- Escrow releases to the ASP account only; no arbitrary beneficiary. Hence the forwarding contract.
- XMTP: no protocol-level message editing; per-inbox installations are revocable (this is the port access mechanism); mainnet message expiry ~6 months (archive at settlement).
- Internet Court repo = adapter spec, not a deployed court. GenLayer path = write our own contract following their shapes. Stretch, not v1.
- Kenny's wallet gate passes on onchainos (v4.2.1); ASP identity not yet registered.

## OPEN ITEMS

- [ ] Register Prime Port ASP identity (Kenny, on-chain action — the "service to sell" now exists)
- [ ] Fill the three empty lanes
- [ ] Verify agent-side UX for holding a port installation (how an OKX-side agent runs an XMTP client against our inbox — needs a spike)
- [ ] Forwarding contract: confirm fee mechanics + XLayer deploy
- [ ] Pick embedded wallet provider (Privy vs Web3Auth vs Coinbase)
- [ ] ASP listing copy on the OKX marketplace (this is the storefront — treat it like the landing page)

## SCOPE FENCES (still standing)

- Fiat payouts: Phase 2, "pending licensing."
- Reddit auto-posting: ban magnet. X + Telegram only.
- Being the judge: never. v1 doesn't even host one.
- Custody: never discretionary. Port keys we mint and burn; pay routes only where the freelancer signed.

---

## IF WE ONLY REMEMBER THREE THINGS

1. **The port is the product.** OKX is the storefront, humans are the supply, the port is why either side shows up.
2. **No power is given to the agent** anywhere else. Here it holds the key card.
3. **We are rails, never referee, never bank.** The clocks and contracts judge. We mint ports and burn them.

Now go build the nice thing. 🏝️
