# Deploying Prime Port on AWS

Prime Port needs a persistent machine. XMTP identity databases, port keys,
attachments, the jobs ledger, dispute evidence, and the X Layer event cursor
must survive container replacement. AWS App Runner's container filesystem is
ephemeral, so the existing App Runner service is suitable only for the current
pre-escrow demo—not the production escrow cutover.

The production target is one AWS Lightsail instance running the backend
container behind Caddy. The included systemd units mount every state directory
from `/var/lib/prime-port`.

## Required order

1. Deploy and verify the GenLayer judge.
2. Prepare a dedicated resolver/relayer wallet and store its key as a secret.
3. Deploy `PrimePortEscrow` on X Layer with that immutable resolver.
4. Record the escrow address, deployment block, and deployment transaction.
5. Create the Lightsail instance only after confirming its monthly price.
6. Copy secrets into `/etc/prime-port/prime-port.env` with mode `0600`.
7. Start with all background workers disabled and verify HTTPS and `/health`.
8. Enable the public A2A responder and verify agent #5982.
9. Enable the escrow watcher and GenLayer relayer.
10. Run a tiny real USD₮0 happy-path test, then a tiny dispute-path test.
11. Update the Vercel proxy and OKX listing only after both tests pass.
12. Stop App Runner after the new backend has been stable and state has been
    backed up.

## Critical environment

```dotenv
APP_PORT=7860
PUBLIC_BASE_URL=https://<backend-domain>
ATTACH_BASE=https://<backend-domain>
XMTP_ENV=production

EXPECTED_OKX_AGENT_ID=5982
ENABLE_A2A_RESPONDER=0
ENABLE_MARKETPLACE_WATCHER=0

ESCROW_ADDRESS=0x...
ESCROW_START_BLOCK=...
ESCROW_CHAIN_ID=196
USDT_ADDRESS=0x779ded0c9e1022225f8e0630b35a9b54be713736
XLAYER_RPC_URL=https://rpc.xlayer.tech
ESCROW_CONFIRMATIONS=2

ENABLE_GENLAYER_RELAYER=0
GENLAYER_JUDGE_ADDRESS=0x...
GENLAYER_RPC_URL=https://...
GENLAYER_CHAIN=studionet
GENLAYER_RELAYER_KEY=0x...
RELAYER_TOKEN=<high-entropy-secret>
```

The normal OKX API credentials, encrypted OnchainOS email-session bundle,
Hermes model key, x402 publication settings, and distribution secrets are also
required. Never commit the environment file or print it during debugging.

## Persistent directories

The systemd unit mounts:

- `/var/lib/prime-port/onchainos`
- `/var/lib/prime-port/okx-agent-task`
- `/var/lib/prime-port/port-service-data`
- `/var/lib/prime-port/mcp-server-data`
- `/var/lib/prime-port/genlayer-relayer-data`
- `/var/lib/prime-port/distribution-data`

`STATE_REMOTE` git synchronization is a legacy fallback, not the primary
database. Production uses the Lightsail disk plus encrypted instance snapshots.
Evidence manifests contain private dispute data, so snapshots and any secondary
backup must be access-controlled.

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

The old shared worker (#6592), `JobForwarder` registrar, and marketplace wage
watcher are not part of this deployment.
