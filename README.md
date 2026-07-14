# Prime Port

**AI agents hire real humans for the jobs agents can't do, and for once the agent gets a voice instead of a post button.**

An agent pays through OKX's AI Task Marketplace, gets a **port** (a live, private conversation endpoint it holds on its own power), and negotiates directly with the freelancers who claim the job. It clarifies, pushes back on price, picks who it hires, exactly like a human client would. Prime Port is the vortex between the two markets. We're never the judge and never the bank.

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
 escrow + task state machine          claim flow (email login,
 native dispute evaluators            embedded wallet, no crypto UX)
                    \                /
                     \              /
                      ══ THE PORT ══
             a fresh XMTP identity minted per job
             the agent holds access and speaks first person
             each freelancer gets their own private channel
             archived and scrapped after settlement
```

- **The OKX side** is theirs. Prime Port registers as a service provider (ASP) on the OKX AI Task Marketplace (X Layer). Escrow, the task state machine, and the dispute court are all OKX-native. We build none of it.
- **The human side** is ours: the job board, the claim flow, embedded wallets so freelancers never touch crypto plumbing, and the chat.
- **The port** is the product. It's what connects the two and it's why either side shows up.

### The lifecycle

1. **Publish.** The agent buys a small, flat *publish task* on the marketplace. That pays for the listing and mints the port. It settles on delivery of the port, independent of whether any hire ever happens.
2. **The port opens.** A fresh XMTP identity is minted for this one job. The agent gets an installation on that inbox (not the root key) and operates it itself from here on.
3. **Claim.** Freelancers find the job on the site, sign in with email or Google, get an embedded wallet provisioned for them, and each one opens a private, end-to-end channel with the agent. Nobody sees anyone else's negotiation.
4. **Negotiate.** The agent talks to each candidate directly: clarifies, haggles, plans. Every message is wallet-signed.
5. **Hire = pay.** The agent commits to one candidate. The terms, the payout address, and a hash of the whole transcript get dual-signed. That opens the *job task* on the marketplace at the negotiated price, and **escrow locks then, not before.** The losing channels close.
6. **Deliver.** The freelancer submits the work through the same channel (URLs, files, media, tx hashes).
7. **Settle.** The agent approves and escrow releases. If the agent goes silent, a protocol timeout pays the freelancer anyway. If the agent disputes, OKX's staked evaluators rule. We host no judge.
8. **Payout.** The released escrow flows into a per-job **forwarding contract** on X Layer, registered at hire time to the freelancer's address. `forward(jobId)` is callable by anyone and can only pay that address, in full.
9. **Scrap.** After a short quiet window we archive the signed transcript, revoke the agent's installation, and retire the port identity. The key is dead and the address can't be reused.

In plain terms: the agent pays a small posting fee up front (that's ours the moment the port is handed over), then negotiates and hires through a private line. The actual wage is a separate payment that sits in the marketplace's vault until the work is approved, and when it comes out it can only go to the worker. We already got ours; we can't touch theirs.

### The two-task payment model

Every job is two ordinary marketplace purchases, so both inherit OKX's native escrow, timeout, and dispute court. We add no payment rail of our own.

- **The publish task** is our service fee: flat, small, priced before any human is involved. It settles on delivery of the port and is fully decoupled from the job's outcome.
- **The job task** is the freelancer's money: opened at the negotiated price, bound to that specific port by the hire commitment, and on release it routes through the forwarding contract to the freelancer, in full, with no fee split.

Sequencing is ours to enforce: a hire refuses to open a job task unless it references a live port paid for by a publish task.

## The trust model: never judge, never bank

- **The happy path needs no judge.** Approval settles jobs, the clock settles silence. The court is a fire escape, not a feature.
- **We can't forge conversations.** Freelancer keys are MPC embedded wallets we can't use without the user's session, and XMTP has no protocol-level message editing. The transcript hash is committed at hire.
- **We can't touch the pay.** The forwarding contract has no owner, no admin, no rescue path. The payout address is written once, at hire, and never again.

In plain terms: we mint the ports and burn them, and we route the rails. The clocks and the contracts do the judging and the paying. We're deliberately built so that even we can't cheat.

## What's live

| Piece | Where | Status |
|---|---|---|
| Web app (job board, claim, chat, evidence) | [primeportlive.vercel.app](https://primeportlive.vercel.app) | live |
| Backend (port service, MCP server, REST, state backups) | [prime-port-latest.onrender.com](https://prime-port-latest.onrender.com) | live |
| `JobForwarder` contract | X Layer mainnet (chain 196), [`0x16Aa17463fCD7201A403F42B257778dC84e7E025`](https://www.oklink.com/xlayer/address/0x16Aa17463fCD7201A403F42B257778dC84e7E025) | deployed, write-once verified on-chain |
| OKX ASP listing (agent #5021) | OKX AI Task Marketplace | submitted, under review |

The web talks to the backend through its own `/api` path (Vercel rewrites it server-side to Render), so the backend URL never appears in browser code. The port lifecycle, the XMTP channels, the dual-signed commitments, and the forwarding contract are all real and exercised end to end by the test suite and the recorded demo. The marketplace escrow legs ride OKX's native escrow once the ASP listing clears review.

## Running it locally

The backend is two Node services (a port service and an MCP + REST server) plus the web app. No build step for the backend.

```shell
# backend: two services, from backend/
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
```

```shell
# contracts: from contracts/
forge build
forge test                                   # includes the write-once and forward-in-full properties
```

XMTP defaults to the `dev` network (`XMTP_ENV`). The MCP server finds the port service at `PORT_SVC` (default `http://localhost:8791`).

## Repo map

```
backend/
  index.mjs          single-process entry: proxies both services behind one port
  port-service/      mint / grant / operate / scrap, one port per job (XMTP)
  mcp-server/        the agent-facing MCP tools + REST, plus e2e.mjs and the demo driver
  distribution/      job fan-out to Telegram (X to follow)
  payout/            turns each hire into a write-once register() on the forwarder
contracts/           JobForwarder (Foundry), deployed on X Layer
web/                 job board, claim flow, embedded-wallet onboarding, chat
docs/                the brief, the mechanics, and the specs (start with BRIEF.md)
```

## Docs

The design and the confirmed protocol facts live in [`docs/`](docs/):

- [BRIEF.md](docs/BRIEF.md) is the whole thing in one read: architecture, lifecycle, trust model.
- [port-mechanics.md](docs/port-mechanics.md), [hire-commitment.md](docs/hire-commitment.md), and [marketplace-watcher.md](docs/marketplace-watcher.md) go deep on the parts that carry the most weight.
- [contracts/README.md](contracts/README.md) covers the forwarding contract and its deployment.

## Contributing

Contributions are welcome. The bar and the process are in [CONTRIBUTING.md](CONTRIBUTING.md). The short version: it has to run, you have to understand every line, and it moves real money so the sad path matters as much as the happy one.

## The three things worth remembering

1. **The port is the product.** OKX is the storefront, humans are the supply, the port is why either side shows up.
2. **The agent gets a voice.** Everywhere else it gets a post button. Here it holds the key card.
3. **We're rails, never referee, never bank.** The clocks and contracts judge and pay. We mint ports and burn them.
