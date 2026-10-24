# Prime Port backend

One process runs the XMTP port service, the MCP + REST server, the distribution
poster, the escrow event watcher, and the optional GenLayer resolution relayer.
`index.mjs` exposes them through one public port.

`POST /mcp/publish` is the only paid operation. The fee is paid in the
settlement chain's native ETH: the payer sends the exact amount to
`PAY_TO_ADDRESS` with a single-use 32-byte memo in the transaction data, then
replays the job fields with the transaction hash. The paid result mints the
private port and returns the plain-HTTP job inbox. The later negotiated
freelancer wage is a separate escrow: the backend produces the dual-signature
authorization and exact `approve` + `fund` transactions for `PrimePortEscrow`.

The freelancer may submit any number of revisions. An accepted revision becomes
release-ready, but only an observed on-chain event changes financial state. If a
party disputes, the backend writes a content-addressed evidence manifest, the
GenLayer judge returns a finalized provider share, and the dedicated resolver
relays that result to the escrow.

## Important environment variables

- `PAY_TO_ADDRESS`: treasury that receives the publish fee. Required; the
  process refuses to boot without it.
- `PUBLISH_PRICE_ETH`: fee per publication, default `0.001`.
- `PUBLISH_CHAIN_ID`, `PUBLISH_RPC_URL`, `PUBLISH_CONFIRMATIONS`: the chain the
  fee is verified on, default `46630` (Robinhood Chain Testnet).
- `ESCROW_ADDRESS`: deployed `PrimePortEscrow`; unset disables new hires and the
  event watcher.
- `ESCROW_START_BLOCK`: deployment block for the first watcher run.
- `ESCROW_RPC_URL`, `USDT_ADDRESS`, `ESCROW_CHAIN_ID`, `ESCROW_CONFIRMATIONS`:
  settlement chain settings.
- `ENABLE_GENLAYER_RELAYER=1`: run the dispute relayer.
- `GENLAYER_JUDGE_ADDRESS`, `GENLAYER_RPC_URL`, `GENLAYER_RELAYER_KEY`: judge
  and dedicated resolver credentials.
- `RELAYER_TOKEN`: high-entropy secret used for relayer submission markers.
- `STATE_REMOTE`: private git remote that mirrors port/job state at startup and
  on a schedule. The container filesystem is ephemeral.

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
