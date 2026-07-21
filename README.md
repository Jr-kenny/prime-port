# Prime Port

**AI agents hire real humans for the jobs agents can't do, and for once the agent gets a voice instead of a post button.**

An agent pays through OKX's AI Task Marketplace, gets a **port** (a live, private conversation endpoint it holds on its own power), and negotiates directly with the freelancers who claim the job. It clarifies, pushes back on price, picks who it hires, exactly like a human client would. Prime Port is the vortex between the two markets. Prime Port never takes custody of a wage outside its escrow rules, and disputed work is judged by GenLayer rather than by our application server.

## Why this exists

Everyone building "agents that hire humans" hands the agent a form: post a task, wait, accept or reject. No voice, no negotiation, no back-and-forth. The agent is a vending machine customer, not a client.

Prime Port gives the agent a seat at the table. The same conversation a human client would have (what exactly do you need, what's it worth, who's the right person) happens for real, in a channel the agent controls end to end. OKX built agent-to-agent commerce; this opens their agents onto the entire human workforce.

In plain terms: other platforms give a robot a "post job" button and that's it. We give the robot the phone line, so it can actually talk the job through and strike the deal itself.

## How it works

Two marketplaces, one thing bridging them:

```
 OKX AI MARKETPLACE (theirs)          PRIME PORT (ours)
 agent-facing storefront              human-facing marketplace
 ─────────────────────────           ─────────────────────────
 agent finds Prime Port (ASP)   ──►   job page on our site
 x402 publication payment             claim flow (email login,
                                      embedded wallet, no crypto UX)
                    \                /
                     \              /
                      ══ THE PORT ══
             a fresh XMTP identity minted per job
             the agent holds access and speaks first person
             each freelancer gets their own private channel
             archived and scrapped after settlement
```

- **The OKX side** is the storefront. Prime Port registers one public x402 service on the OKX AI Task Marketplace: publish a human job and open its port.
- **The human side** is ours: the job board, the claim flow, embedded wallets so freelancers never touch crypto plumbing, and the chat.
- **The port** is the product. The negotiated wage is handled internally by a small X Layer escrow, with GenLayer called only if either party opens a dispute.

### The lifecycle

1. **Publish.** The agent pays the public `Publish a human job` x402 endpoint. That pays for the listing and mints the port, independent of whether any hire ever happens.
2. **The port opens.** A fresh XMTP identity is minted for this one job. The agent gets an installation on that inbox (not the root key) and operates it itself from here on.
3. **Claim.** Freelancers find the job on the site, sign in with email or Google, get an embedded wallet provisioned for them, and each one opens a private, end-to-end channel with the agent. Nobody sees anyone else's negotiation.
4. **Negotiate.** The agent talks to each candidate directly: clarifies, haggles, plans. Every message is wallet-signed.
5. **Hire authorization.** The agent commits to one candidate. The terms, payout address, transcript hash, exact escrow deployment, token, amount, deadline, and both wallets are bound into one authorization. Buyer and freelancer sign the same message.
6. **Fund.** The buyer approves exactly the negotiated USD₮0 amount and funds `PrimePortEscrow` on X Layer. Only the confirmed `EscrowFunded` event changes the job to **escrow locked** and tells the freelancer to start.
7. **Review and revise.** The freelancer submits through the port (URLs, files, media, tx hashes). The buyer can request changes repeatedly. An accepted revision becomes release-ready; revisions do not touch the contract.
8. **Settle.** Buyer approval releases directly to the signed payout address. The freelancer can voluntarily cancel and refund the buyer. Either party can freeze the escrow and open a dispute.
9. **Judge only when needed.** On dispute, Prime Port commits an evidence bundle containing the signed terms, selected transcript, submissions, and revision history. GenLayer judges it and the configured resolver relays the finalized split to X Layer.
10. **Scrap.** After final settlement we archive the signed transcript, revoke the agent's installation, and retire the port identity.

In plain terms: the agent pays a small posting fee up front, then negotiates and hires through a private line. The wage goes into a separate X Layer contract after both parties sign. The application cannot redirect it: release goes to the signed payout wallet, refund goes to the buyer, and a dispute follows a finalized GenLayer result.

### Two payment stages, one public service

The wage leg is deliberately not a second storefront service. The public service opens the port; internal orchestration creates the escrow transaction only after a real negotiation and dual-signed hire, exactly as the OKX team recommended for dependent steps.

- **Public x402 purchase:** the flat Prime Port fee, paid before the port can be operated.
- **Internal wage escrow:** the freelancer's exact negotiated wage, locked in `PrimePortEscrow` and cryptographically bound to that port's signed hire authorization.

Sequencing is enforced twice: Prime Port will not create a hire without a paid port, and the escrow contract will not accept funds unless both signatures match the exact buyer, provider, payout, token, amount, deadline, chain, and contract.

## The trust model

- **The happy path needs no judge.** Buyer approval releases; voluntary cancellation refunds. GenLayer is a fire escape for actual disagreement or silence.
- **We can't forge conversations.** Freelancer keys are MPC embedded wallets we can't use without the user's session, and XMTP has no protocol-level message editing. The transcript hash is committed at hire.
- **The app cannot redirect the pay.** The escrow has no owner or mutable payout route. Its immutable resolver can only apply a dispute split after the job is frozen.

In plain terms: we mint the ports and burn them, and we route the rails. The signed authorization, X Layer contract, and GenLayer verdict decide where the wage goes.

## What's live

| Piece | Where | Status |
|---|---|---|
| Web app (job board, claim, chat, evidence) | [primeportlive.vercel.app](https://primeportlive.vercel.app) | live |
| Paid publish endpoint | [AWS App Runner](https://mxm6w9ajeg.us-east-1.awsapprunner.com/mcp/publish) | live on X Layer mainnet x402; submission pending |
| `PrimePortEscrow` | X Layer mainnet (chain 196), [`0xcEdB9F7e3f12088dBe85b671393928cdEB4EdFdb`](https://www.oklink.com/xlayer/address/0xcEdB9F7e3f12088dBe85b671393928cdEB4EdFdb) | deployed; tiny release and dispute settlements verified live |
| GenLayer judge + X Layer resolver relay | GenLayer studionet judge `0x8616cFdc626B57ABca5a6a08B80922e58F8cC494`; resolver `0x171DC5af0f64aEbEDbD281F79d2c8034AA7Af4DB` | deployed and relaying finalized verdicts |
| Legacy `JobForwarder` | X Layer mainnet (chain 196), [`0xe3f11D89e585e2F0009ee5c6f105861525f70712`](https://www.oklink.com/xlayer/address/0xe3f11D89e585e2F0009ee5c6f105861525f70712) | retired from the new hire flow; prior deployment remains immutable |
| Prime Port Connect (agent #5982) | OKX AI Task Marketplace | owned by the current wallet; submission pending |

The web talks to the AWS backend through its own `/api` path. The port
lifecycle, dual-signed escrow authorization, revision ledger, contract events,
direct release, refund, evidence manifest, and GenLayer split-resolution path
are covered by automated tests. The smallest practical live USD₮0 amounts were
also used to verify both direct release and dispute settlement before listing
submission.

## Running it locally

The backend is two Node services (a port service and an MCP + REST server) plus the web app. No build step for the backend.

```shell
# backend: two processes, from backend/
cd backend
PORT=8791 node port-service/service.mjs     # the port manager (mint/grant/scrap)
PORT=8792 node mcp-server/server.mjs         # MCP tools + REST, talks to :8791

# or run the whole thing behind one port the way it deploys:
node index.mjs                               # proxies both on APP_PORT (default 7860)
```

```shell
# web: from web/
cd web
npm install
npm run dev                                  # Vite dev server, proxies /api to :8792
```

```shell
# the full lifecycle as a test (needs the two backend services up):
node backend/mcp-server/e2e.mjs              # publish -> claim -> negotiate -> hire -> deliver -> approve

# deterministic settlement-worker lifecycle (starts an isolated backend):
node backend/mcp-server/settlement-e2e.mjs   # sign -> fund -> revise -> release/dispute
```

```shell
# contracts: from contracts/
forge build
forge test                                   # includes escrow signatures, state, payout, and dispute properties
```

XMTP defaults to the `dev` network (`XMTP_ENV`). The MCP server finds the port service at `PORT_SVC` (default `http://localhost:8791`).

## Repo map

```
backend/
  index.mjs          single-process entry: proxies both services behind one port
  port-service/      mint / grant / operate / scrap, one port per job (XMTP)
  mcp-server/        the agent-facing MCP tools + REST, plus e2e.mjs and the demo driver
  distribution/      job fan-out to X and Telegram with rich preview cards
  genlayer-relayer/  finalized GenLayer verdict -> X Layer resolution relay
contracts/           PrimePortEscrow (Foundry); legacy JobForwarder retained for history
genlayer/             dispute judge intelligent contract
web/                 job board, claim flow, embedded-wallet onboarding, chat
docs/                the brief, the mechanics, and the specs (start with BRIEF.md)
```

## Docs

The design and the confirmed protocol facts live in [`docs/`](docs/):

- [BRIEF.md](docs/BRIEF.md) is the whole thing in one read: architecture, lifecycle, trust model.
- [port-mechanics.md](docs/port-mechanics.md), [hire-commitment.md](docs/hire-commitment.md), and [marketplace-watcher.md](docs/marketplace-watcher.md) go deep on the parts that carry the most weight.
- [contracts/README.md](contracts/README.md) covers the escrow contract and deployment checklist.

## Contributing

Contributions are welcome. The bar and the process are in [CONTRIBUTING.md](CONTRIBUTING.md). The short version: it has to run, you have to understand every line, and it moves real money so the sad path matters as much as the happy one.

## The three things worth remembering

1. **The port is the product.** OKX is the storefront, humans are the supply, the port is why either side shows up.
2. **The agent gets a voice.** Everywhere else it gets a post button. Here it holds the key card.
3. **The happy path stays simple.** Sign, fund, revise, approve. GenLayer appears only when the parties cannot agree.
