# Prime Port backend

One container, everything: the port service (XMTP port lifecycle: mint /
grant / operate / scrap), the MCP server (a paid job-publication endpoint,
agent-facing port tools, plus the
freelancer REST surface), the distribution poster (Telegram fan-out), and
the OKX marketplace watcher. `index.mjs` starts them all and routes `/mcp`,
`/mcp/publish`, `/jobs`, `/freelancers` to the MCP server and `/ports`, `/attachments` to
the port service. `/health` answers 200 when alive.

`POST /mcp/publish` is the single paid operation. An unpaid call returns an
x402 v2 `402 Payment Required` challenge for 1 USD₮0 on X Layer. A verified
paid replay publishes the supplied human job and returns its private port.
Monitoring and negotiating through that existing port do not trigger another
Prime Port publication charge. The eventual freelancer wage is agreed and
escrowed separately.

State (port keys, XMTP identity DBs, jobs ledger, watcher memory, and the
OKX A2A session store) is
mirrored to a private git repo because free-tier disks are ephemeral; set
`STATE_REMOTE`. The watcher needs `OKX_API_KEY` / `OKX_SECRET_KEY` /
`OKX_PASSPHRASE` (API-key wallet login at boot). Set
`ENABLE_MARKETPLACE_WATCHER=1` to run it. Set `ENABLE_A2A_RESPONDER=1` plus
`NVIDIA_API_KEY` to run the always-on XMTP listener and Hermes/NVIDIA
responder. `HERMES_NVIDIA_MODEL` can override the default Nemotron model.
For an agent registered through email login, provide the four encrypted
`onchainos-*.b64` Render secret files described in `docs/deploy.md`; startup
refuses to report the responder as running unless `EXPECTED_OKX_AGENT_ID`
(default `5021`) is visible to that session.
Both are opt-in so a cloud instance can be verified before the Mac fallback
is stopped; never leave two watchers/responders active for the same agent.

Built by `.github/workflows/build-backend-image.yml` into
`ghcr.io/jr-kenny/prime-port:latest`; deployed on Koyeb's free instance.
See `docs/deploy.md` for the full runbook.

Run locally against the real OKX facilitator: set `OKX_API_KEY`,
`OKX_SECRET_KEY`, and `OKX_PASSPHRASE`, then run `node index.mjs`. For an
unpaid challenge-only local test, set `X402_OFFLINE_CHALLENGE=1`; payment
verification and settlement never bypass OKX.
