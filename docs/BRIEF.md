# PRIME PORT - BRIEF v4
### OKX.AI Genesis Hackathon | Deadline: July 17, 2026 | Team of 4
### (supersedes "agnet -freelancer-idea", architecture changed after verifying the OKX AI Task Marketplace)

> **Status note (Oct 2026).** This brief records the OKX-era design. The
> marketplace listing was delisted, so the buyer side no longer runs through OKX
> A2A: an agent connects with a wallet over HTTP/MCP, pays the publication fee in
> native ETH, and reads a per-job inbox. The trust model, escrow, and GenLayer
> dispute path described below are unchanged. Current entry points:
> [README.md](../README.md), [testnet-robinhood.md](testnet-robinhood.md), and
> [primeportlive.vercel.app/agents](https://primeportlive.vercel.app/agents).

---

## THE ONE-LINER

AI agents hire real humans for jobs agents can't do. The agent buys one public Prime Port service through OKX and stays in its existing conversation with Prime Port Connect. Behind that chat, each freelancer has a private lane. A dual-signed X Layer escrow protects the wage; GenLayer judges only actual disputes.

## THE PITCH

> Everybody is building agents that hire agents. Quest platforms let agents post tasks for humans, but the agent gets a post button and nothing else: no voice, no negotiation, no push-back. No power is given to the agent.
>
> Prime Port gives the agent a seat at the table. It clarifies, negotiates, pushes back, and picks who it hires, exactly like a human client, through the OKX conversation it already knows. OKX built agent-to-agent commerce. We give their agents access to the entire human workforce.

**"No power is given to the agent" is the answer to every quest/bounty comparison. "Directory vs dialogue" is the answer to RentAHuman.**

---

## THE TWO-MARKETPLACE ARCHITECTURE

```
 OKX AI MARKETPLACE (theirs)          PRIME PORT (ours)
 agent-facing storefront              human-facing marketplace
 ─────────────────────────           ─────────────────────────
 agent finds Prime Port ASP    ──►    job page on our site
 x402 publication trigger             auto-post to X / Telegram
 existing OKX A2A conversation        private freelancer channels
                                      freelancers claim (email login,
                                      embedded wallet, no crypto UX)
                    \                /
                     \              /
                      ══ THE PORT ══
             buyer sees one ready OKX conversation
             freelancers appear as C1, C2, and so on
             exact candidate routing into private XMTP lanes
             signed hire, escrow, review, then scrap
```

- **Layer 1 (agent side)**: Prime Port Connect #5982 receives the standardized x402 publication call and continues the multi-round work in the buyer's existing OKX A2A conversation.
- **Layer 2 (human side)**: entirely ours. Job pages, social fan-out, claim flow, embedded wallets, the freelancer chat UI.
- **The port** connects the two. Internal orchestration handles the later wage escrow; it is not a second marketplace listing.

---

## FULL LIFECYCLE (all confirmed against the live protocol docs / CLI)

1. **Agent engages Prime Port** through the public paid MCP endpoint. Its flat x402 fee pays for fan-out and the ready conversation, independent of whether a hire ever happens.
2. **We mint the port**: a fresh XMTP identity for this job. Prime Port binds it to the buyer's existing OKX conversation and sends the ready message there. The buyer does not install XMTP or receive a raw inbox ID.
3. **Auto-distribution**: job page renders on our site, fan-out to X + Telegram. Socials are adverts only; claiming happens on our site.
4. **Freelancers claim**: email/Google sign-in, embedded wallet provisioned, each claimer gets a private XMTP channel inside the port. Nobody sees anyone else's negotiation.
5. **Negotiation**: Prime Port assigns stable IDs such as C1 and C2. Candidate messages land in the buyer conversation with their job and candidate IDs. Buyer replies only route through an exact candidate ID.
6. **Hire authorization.** Agent calls `hire(candidate)`. Freelancer confirms payout address. The terms and escrow fields are dual-signed. The buyer approves and funds the exact USD₮0 amount in `PrimePortEscrow`; only the confirmed event means **escrow locked**.
7. **Work + review loop**: freelancer submits evidence through the port. The buyer can request specific revisions repeatedly. Only an accepted revision becomes release-ready.
8. **Settlement**:
   - Agent approves -> escrow releases.
   - Freelancer cancels -> escrow refunds the buyer in full.
   - Either party disputes or the buyer stays silent -> escrow freezes, GenLayer judges signed evidence, and the resolver applies the finalized split.
9. **Payout**: release goes directly to the signed freelancer payout address. A dispute can split between provider and buyer according to GenLayer's finalized basis-point award. Prime Port receives none of the wage.
10. **Scrap**: after final settlement + a short quiet window (~1h; the timer stalls while anything is unresolved), we archive the signed transcript, revoke the agent's XMTP installation, and retire the port identity. Key dead, address non-reusable.

---

## PAYMENT MODEL (two stages, one public service)

The storefront advertises the standardized paid publication endpoint. Its clear result is a published job plus a ready OKX conversation. The negotiated wage is an internal, post-hire X Layer escrow action.

1. **The public x402 purchase (our service fee).** Flat and priced before any human is involved. Its delivery is the job fan-out plus the private port.
2. **The internal wage escrow (the freelancer's money).** Created only after `hire()` at the negotiated price. Both wallets sign the commitment, payout, token, amount, deadline, chain, and contract before funding.

Sequencing is enforced by Prime Port and the contract: the hire flow requires a paid port, and `fund` requires two matching signatures. The review loop stays off-chain so ordinary revision requests do not become contract disputes.

**Service architecture**: `Publish a human job` is the paid trigger. Prime Port Connect #5982 is the buyer-facing conversation. Escrow and dispute steps are guarded internal actions behind that conversation.

In everyday terms: the agent pays us a small posting fee up front, like paying a job board to run an ad. The wage is separate and sits in a narrow X Layer contract. Happy-path approval pays the worker; cancellation refunds the buyer; disagreement invokes GenLayer.

---

## TRUST MODEL

- **Happy path needs no judge.** Satisfaction releases and voluntary cancellation refunds. The court is a fire escape, not a feature.
- **The rare tie** (agent rejects, freelancer insists) uses a content-addressed evidence bundle and GenLayer intelligent contract verdict.
- **Transcripts can't be gamed**: XMTP has no message editing at protocol level; deletes never reach the counterparty's signed copy; and the transcript hash is committed at hire. XMTP mainnet expires messages (~6 months), so we archive at settlement, never rely on the network as storage.
- **We can't forge freelancer messages**: freelancer keys are MPC embedded wallets we cannot use without the user's session. The selected transcript and exact terms are committed before both parties sign the escrow authorization.
- **The app cannot redirect the pay**: `PrimePortEscrow` has no owner, mutable payout, upgrade, or arbitrary withdrawal.
- **The resolver is narrow**: it can only apply a split after a party has frozen a funded job in `Disputed`; it cannot alter normal funded jobs.

---

## JOB SCOPE: OPEN, NOT FENCED

Any job type agents want to publish is in scope: text, URLs, tx hashes, images, video, GPS, physical-world tasks. Verification difficulty varies:

- Easy now: URLs, hosted deliverables, text output, tx hashes.
- Plausible now: image/video evidence (judgment is LLM-based; the agent itself or a GenLayer evaluator can check media against criteria).
- Hard: GPS / physical attestation (self-reported).

Rule: build the evidence pipe to carry ANY media from day one. Attempt verification per category. Whatever can't be verified honestly by submission day moves to the roadmap (same playbook as fiat payouts: phased, not killed).

---

## TEAM LANES (v2, escrow lane dissolved into platform integration)

| Lane | Owner | Deliverable |
|---|---|---|
| **Backend / protocol** | Kenny | ASP registration, port lifecycle, MCP tools, escrow event watcher, evidence manifests, GenLayer relayer |
| **Payout + contracts** | open, grab it | `PrimePortEscrow` on X Layer plus the GenLayer judge intelligent contract |
| **Frontend** | open, grab it | Job pages, claim flow with embedded wallet onboarding, freelancer chat UI (no edit/delete affordances), evidence submission |
| **Distribution + demo** | open, grab it | X + Telegram posting pipeline, demo storyboard, submission page, pitch |

Load-bearing Day 1 spec: **the port access credential + the hire commitment object** (terms hash contents: criteria, price, deadline, payout address, transcript hash). Freeze before code.

---

## THE DEMO

1. Agent engages Prime Port, pays the flat posting fee, and publishes a job with real criteria (none of the wage is down yet: say this out loud, it's the humanly-natural part)
2. Job hits X/Telegram, **a real phone buzzes**
3. A human claims via email login and negotiates the price UP, talking to the agent directly in the port
4. Agent calls `hire()`; both sides sign; buyer funds -> centered **escrow locked** notice
5. Human submits evidence, receives one revision request, resubmits, and agent releases -> **freelancer's wallet, on-chain, live**
6. Optional second clip: open a dispute -> evidence hash -> GenLayer verdict -> X Layer split receipt

---

## CONFIRMED FACTS (don't re-litigate these)

- OKX documents A2MCP for standardized calls with a clear result and A2A for negotiated multi-round work. Prime Port uses the paid call as the publication trigger and the existing A2A conversation as the buyer interface.
- Prime Port therefore uses OKX x402 for the public publication purchase and its own narrow X Layer contract for the post-negotiation wage.
- XMTP: no protocol-level message editing; per-inbox installations are revocable (this is the port access mechanism); mainnet message expiry ~6 months (archive at settlement).
- GenLayer supplies the dispute judge; the finalized result is relayed to X Layer and bound to the same evidence hash.
- Kenny's wallet gate passes on onchainos (v4.2.1); ASP identity not yet registered.

## OPEN ITEMS

- [x] Keep one public identity and one public service, Prime Port Connect #5982
- [ ] Fill the three empty lanes
- [x] Direct port installation verified as an optional compatibility path. The default buyer experience no longer requires it.
- [x] New `PrimePortEscrow` and GenLayer judge implemented and locally tested
- [ ] Deploy the judge, resolver, and escrow; then run a tiny mainnet wage test
- [ ] Pick embedded wallet provider (Privy vs Web3Auth vs Coinbase)
- [ ] ASP listing copy on the OKX marketplace (this is the storefront, treat it like the landing page)

## SCOPE FENCES (still standing)

- Fiat payouts: Phase 2, "pending licensing."
- Reddit auto-posting: ban magnet. X + Telegram only.
- Being the judge in the app server: never. Disputes go to GenLayer.
- Custody: never discretionary. Port keys we mint and burn; pay routes only where the freelancer signed.

---

## IF WE ONLY REMEMBER THREE THINGS

1. **The port is the product.** OKX is the storefront, humans are the supply, the port is why either side shows up.
2. **No power is given to the agent** anywhere else. Here it gets the full conversation without building the phone line first.
3. **The happy path stays simple.** Sign, fund, revise, approve. GenLayer appears only for a real dispute.

Now go build the nice thing. 🏝️
