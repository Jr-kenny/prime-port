# Deploying the backend (Koyeb container + Hugging Face state repo)

The backend runs as one container on Koyeb's free instance. One process,
`backend/index.mjs`, starts the port service and the MCP server, fronts them
with a path-routing proxy on the single public port (7860), and runs the
marketplace watcher alongside them when the OKX API keys are present (see
the last section). GitHub Actions builds the image from `backend/Dockerfile`
and pushes it to `ghcr.io/jr-kenny/prime-port:latest`
(`.github/workflows/build-backend-image.yml`); Koyeb pulls and runs it.

In everyday terms: Koyeb gives us a free computer on the internet, but it
only lets the outside world knock on one door. So one small program starts
the backend programs and stands at that door, passing each visitor to the
right program inside. GitHub does the packaging for free whenever the code
changes, and Koyeb just runs the latest package.

## Why this shape

- Free serverless hosts (Workers, Deno Deploy) can't run `@xmtp/node-sdk`:
  it uses native libxmtp bindings and keeps identity databases on disk, so
  we need a real persistent container.
- Hugging Face Spaces was the original pick, but as of July 2026 Docker
  Spaces require a PRO subscription on new accounts, i.e. a card. Koyeb's
  free instance (0.1 vCPU, 512 MB, one web service, no sleep) is the
  remaining card-free host that runs containers. Hugging Face still hosts
  the **state repo** for free (a private dataset repo is just a git repo).
- One public port -> the proxy in `index.mjs`. Ephemeral disk ->
  `state-sync.mjs`.

In everyday terms: the fancy "pay nothing, run code" services all assume
your code is a quick function with no memory. Our port service is more like
a resident with a filing cabinet, so it needs an actual machine. Koyeb
provides the machine; Hugging Face provides the locked drawer where the
filing cabinet gets photocopied.

## The routes

| Path prefix | Internal service | Port |
| --- | --- | --- |
| `/mcp`, `/mcp/publish`, `/jobs`, `/freelancers` | mcp-server | 8792 |
| `/ports`, `/attachments` | port-service | 8791 |
| `/`, `/health` | proxy itself (liveness) | 7860 |

Anything else 404s at the proxy; the internal ports are never exposed.

## State backup (`state-sync.mjs`)

The free instance has no persistent disk: every restart is a fresh container. The
things that must survive are `port-service/data` (port wallet keys, XMTP
identity DBs, archives, attachments) and `mcp-server/data` (jobs ledger,
events). On boot the process clones the git repo named by `STATE_REMOTE` and restores
those dirs; every 5 minutes (`BACKUP_EVERY_MS`) it copies them back into the
clone, commits, and pushes if anything changed. Any git host works; the
default plan is a private Hugging Face dataset repo, so the one HF token
covers everything.

The mirror repo holds port private keys and plaintext job state, so it must
be **private**, and the credential embedded in `STATE_REMOTE` should open
only what it has to.

In everyday terms: the free machine loses its memory whenever it reboots, so
every five minutes it photocopies its filing cabinet into a locked drawer on
GitHub, and after a reboot it starts by refilling the cabinet from that
drawer. The drawer contains real keys, so it stays locked (private repo) and
the copier's badge (the token) opens only that one drawer.

## Setting it up

1. Hugging Face side (done): an account with a **Write** token and a private
   dataset repo `jrkenny/prime-port-state` for the state mirror.
2. Push the code to GitHub main; the `build backend image` workflow produces
   `ghcr.io/jr-kenny/prime-port:latest` (make the package public once in
   GitHub → Packages so Koyeb can pull it).
3. Koyeb side: create an account at koyeb.com (email/GitHub login; designed
   to work without a card), then create a **Web Service** from the Docker
   image above: free instance, port 7860, health check `GET /health`.
4. Environment variables on the Koyeb service:
   - `STATE_REMOTE` = `https://user:<hf_token>@huggingface.co/datasets/jrkenny/prime-port-state`
     (secret)
   - `XMTP_ENV` = `dev` (or `production` when we cut over)
   - `ATTACH_BASE` = the public URL Koyeb assigns, e.g.
     `https://prime-port-<org>.koyeb.app`
   - `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` (optional) = turns on the
     distribution fan-out: every new job gets posted to that Telegram chat
   - `SITE_BASE` (optional) = the web app URL, used for claim links in posts
   - `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE` (required for the
     paid endpoint) = authenticate x402 verification and settlement and also
     turn on the in-container marketplace watcher. Created in the
     [OKX OnchainOS developer portal](https://web3.okx.com/onchainos/dev-docs/home/developer-portal);
     the container runs `onchainos wallet login` (API-key mode) at boot.
     Enter these in the Koyeb dashboard yourself; they control the agent
     wallet.
   - `PUBLIC_BASE_URL` = the public backend origin, for example
     `https://prime-port-latest.onrender.com`. The x402 challenge advertises
     `${PUBLIC_BASE_URL}/mcp/publish` as the paid resource.
   - `PAY_TO_ADDRESS` = the wallet receiving the fixed publication charge.
     It defaults to Prime Port's current agent wallet.
   - `PUBLISH_PRICE` = the fixed publication price (default `$1.00`).
   - `REGISTRAR_KEY` (optional, secret) = turns on register-at-hire: every
     dual-signed hire gets its payout address registered on the JobForwarder
     (contracts/README.md has the deployed address). This is the private key
     of the registrar wallet burned into the contract; fund it with ~0.001
     OKB on X Layer. Enter it in the dashboard yourself. Off means hires
     still work, they just don't register on-chain until it's set.
5. In the GitHub repo settings, add a repository **variable** `SPACE_URL`
   with the Koyeb URL. The `keep space awake` workflow pings `/health` every
   6 hours as a liveness alarm (Koyeb's free instance doesn't sleep, so this
   is purely a tripwire that fails loudly in the Actions tab).
6. Point the web app and any published MCP endpoint at the Koyeb URL.

In everyday terms: GitHub builds the package, Koyeb runs it, Hugging Face
keeps the backup drawer, and a scheduled GitHub job rings an alarm if the
service ever stops answering. The only accounts involved are free ones, and
none of them wanted a card.

## The watcher rides in the container

`marketplace-watcher` shells out to the `onchainos` CLI. OKX publishes Linux
builds of it (fetched and checksum-verified in the Dockerfile), and the CLI
supports non-interactive API-key login: with `OKX_API_KEY`,
`OKX_SECRET_KEY`, and `OKX_PASSPHRASE` set as Space secrets, `index.mjs`
logs the wallet in at boot and runs the watcher as a child process,
restarting it (with a fresh login) if it dies. Each login binds a session to
the machine that made it, which is fine: the container makes its own.
Watcher state (`marketplace-watcher/data`) is in the state-sync mirror, so
task history survives restarts.

**Run exactly one watcher.** If the container watcher is on, do not also run
one locally (`node watcher.mjs run` or the launchd plist) against the same
agent: both would vend and apply to the same designations. The local mode
and the plist remain as a fallback for when the container has no OKX keys.

In everyday terms: the marketplace lookout moves into the same free cloud
computer as everything else, and it gets its own OKX login there, made from
three secret codes you create in OKX's developer portal. Your laptop is no
longer part of the machine at all; just make sure the lookout only exists in
one place at a time, or the machine will bid twice on everything.
