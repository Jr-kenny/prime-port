# Prime Port backend

One container runs the XMTP port service, MCP + REST server, distribution
poster, optional OKX A2A responder, X Layer escrow event watcher, and optional
GenLayer resolution relayer. `index.mjs` exposes them through one public port.

`POST /mcp/publish` is the only paid OKX-facing operation. Its x402 payment is
Prime Port's publication fee. The later negotiated freelancer wage is not a
second marketplace service: the backend internally produces the dual-signature
authorization and exact `approve` + `fund` transactions for `PrimePortEscrow`.

The freelancer may submit any number of revisions. An accepted revision becomes
release-ready, but only an observed X Layer event changes financial state. If a
party disputes, the backend writes a content-addressed evidence manifest, the
GenLayer judge returns a finalized provider share, and the dedicated resolver
relays that result to X Layer.

## Important environment variables

- `ESCROW_ADDRESS`: deployed `PrimePortEscrow`; unset disables new hires and the
  event watcher.
- `ESCROW_START_BLOCK`: deployment block for the first watcher run.
- `XLAYER_RPC_URL`, `USDT_ADDRESS`, `ESCROW_CONFIRMATIONS`: chain settings.
- `ENABLE_GENLAYER_RELAYER=1`: run the dispute relayer.
- `GENLAYER_JUDGE_ADDRESS`, `GENLAYER_RPC_URL`, `GENLAYER_RELAYER_KEY`: judge
  and dedicated resolver credentials.
- `RELAYER_TOKEN`: high-entropy secret used for durable relayer submission
  markers.
- `ENABLE_A2A_RESPONDER=1`, `EXPECTED_OKX_AGENT_ID=5982`: run the public Agent
  responder after its email session is restored.
- `ENABLE_MARKETPLACE_WATCHER=0`: the retired shared settlement worker must stay
  disabled for this architecture.

Production state must live on a persistent disk. App Runner's container
filesystem is ephemeral and is not safe for XMTP identities, job state,
evidence manifests, or the escrow block cursor. The included Lightsail systemd
service mounts those directories under `/var/lib/prime-port`.

## Verify locally

```shell
npm test --prefix mcp-server
npm test --prefix genlayer-relayer
node --check index.mjs
```

The isolated settlement E2E covers dual signatures, exact funding calldata,
the escrow-locked notice, a revision request, direct release, dispute evidence,
and a split GenLayer resolution. It injects decoded contract events; it does not
spend real tokens.
