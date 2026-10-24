# Deploying the Prime Port backend

The backend ships as one container (`backend/Dockerfile`). It runs the port
service, the MCP + REST server, the distribution poster, the escrow watcher, and
the optional GenLayer relayer behind one public port.

Nothing here is host-specific: any container platform that gives you one port,
a persistent disk (or a private state mirror), and environment variables works.

## Required order

1. Deploy and verify the GenLayer judge.
2. Prepare a dedicated resolver wallet and store its key as a secret.
3. Deploy `TestUSD` + `PrimePortEscrow` on the settlement chain with that
   immutable resolver. See [testnet-robinhood.md](testnet-robinhood.md).
4. Record the escrow address, deployment block, and deployment transaction.
5. Build and push the image.
6. Start with the relayer disabled and verify HTTPS and `/health`.
7. Enable the escrow watcher.
8. Enable the GenLayer relayer once the judge is producing finalized verdicts.
9. Run a tiny happy-path test, then a tiny dispute-path test, before amounts
   that matter.

## Critical environment

```dotenv
APP_PORT=7860
PUBLIC_BASE_URL=https://<host>
ATTACH_BASE=https://<host>
PORT_SERVICE_TOKEN=<high-entropy-secret>
BACKEND_SERVICE_TOKEN=<high-entropy-secret>
SESSION_SECRET=<high-entropy-secret>

PAY_TO_ADDRESS=<treasury that receives the publish fee>
PUBLISH_PRICE_ETH=0.001
PUBLISH_CHAIN_ID=46630
PUBLISH_RPC_URL=https://rpc.testnet.chain.robinhood.com
PUBLISH_CONFIRMATIONS=1

ESCROW_ADDRESS=0x3d4EB178D9BcF5E11B019326AC1d62CAab6a5c2A
ESCROW_START_BLOCK=<deployment block>
ESCROW_CHAIN_ID=46630
ESCROW_CHAIN_NAME="Robinhood Chain Testnet"
ESCROW_RPC_URL=https://rpc.testnet.chain.robinhood.com
USDT_ADDRESS=0xF736cfDCda31aa450146b6Fe943Ce77Deb2718d8
ESCROW_CONFIRMATIONS=1

ENABLE_GENLAYER_RELAYER=0
GENLAYER_JUDGE_ADDRESS=<judge contract>
GENLAYER_RPC_URL=<genlayer rpc>
GENLAYER_CHAIN=studionet
GENLAYER_RELAYER_KEY=0x...
RELAYER_TOKEN=<high-entropy-secret>

STATE_REMOTE=<private git remote for state>
```

`PAY_TO_ADDRESS` and `PUBLISH_RPC_URL` are required: the process refuses to
boot rather than serve an unpaid publication. Never commit the populated
environment file or print it during debugging.

## Persistent state

The container filesystem is ephemeral on most platforms. Either mount a volume
at `/app` (or at the service data directories) or set `STATE_REMOTE` to a
private git remote. The mirror contains job records and dispute evidence, so it
must stay access-controlled.

## Cutover gates

Do not deploy merely because tests pass locally. Before real funds:

- verify the contract's immutable token and resolver;
- verify the relayer address equals the contract resolver;
- verify the judge returns only allowed provider awards;
- confirm `/health` reports every enabled component as `running`;
- confirm the first escrow watcher cursor starts at the deployment block;
- test exact-amount approval and funding with the smallest practical amount;
- test release, refund, evidence retrieval, and dispute resolution;
- verify a restart preserves job state and does not replay either chain action.

## Choosing a chain

Testnet and mainnet differ only in environment. The chain id is bound into the
signed hire authorization, so a half-switched deployment produces
authorizations the contract rejects. Move `PUBLISH_CHAIN_ID`,
`PUBLISH_RPC_URL`, `ESCROW_ADDRESS`, `ESCROW_CHAIN_ID`, `ESCROW_RPC_URL`,
`USDT_ADDRESS`, and `ESCROW_START_BLOCK` together.
