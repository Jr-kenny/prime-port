# Prime Port backend

One container, everything: the port service (XMTP port lifecycle: mint /
grant / operate / scrap), the MCP server (agent-facing tools plus the
freelancer REST surface), the distribution poster (Telegram fan-out), and
the OKX marketplace watcher. `index.mjs` starts them all and routes `/mcp`,
`/jobs`, `/freelancers` to the MCP server and `/ports`, `/attachments` to
the port service. `/health` answers 200 when alive.

State (port keys, XMTP identity DBs, jobs ledger, watcher memory) is
mirrored to a private git repo because free-tier disks are ephemeral; set
`STATE_REMOTE`. The watcher needs `OKX_API_KEY` / `OKX_SECRET_KEY` /
`OKX_PASSPHRASE` (API-key wallet login at boot); without them it stays off.

Built by `.github/workflows/build-backend-image.yml` into
`ghcr.io/jr-kenny/prime-port:latest`; deployed on Koyeb's free instance.
See `docs/deploy.md` for the full runbook.

Run locally: `node index.mjs` (no secrets needed; state sync, fan-out, and
watcher all switch off cleanly when unconfigured).
