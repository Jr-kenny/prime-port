# Deploying Prime Port on AWS

Prime Port's current production backend runs on the existing AWS App Runner
service. Its encrypted OnchainOS session is restored from SSM, and its
port/XMTP/job state is mirrored to a private remote at startup and every 15
minutes. The X Layer escrow watcher and GenLayer relayer are both enabled.

App Runner's filesystem is ephemeral, so the included Lightsail systemd setup
remains an optional hardening path when a persistent local disk and a smaller
recovery window are required. It is not required for the current marketplace
submission.

## Required order

1. Deploy and verify the GenLayer judge.
2. Prepare a dedicated resolver/relayer wallet and store its key as a secret.
3. Deploy `PrimePortEscrow` on X Layer with that immutable resolver.
4. Record the escrow address, deployment block, and deployment transaction.
5. Store runtime credentials and the encrypted OnchainOS bundle in AWS SSM.
6. Configure the existing App Runner service to pull the verified ECR image.
7. Start with all background workers disabled and verify HTTPS and `/health`.
8. Enable the public A2A responder and verify agent #5982.
9. Enable the escrow watcher and GenLayer relayer.
10. Run a tiny real USD₮0 happy-path test, then a tiny dispute-path test.
11. Update the Vercel proxy and OKX listing only after both tests pass.
12. Keep the old shared marketplace watcher disabled after App Runner is
    stable and the state mirror has completed.

## Critical environment

```dotenv
APP_PORT=7860
PUBLIC_BASE_URL=https://mxm6w9ajeg.us-east-1.awsapprunner.com
ATTACH_BASE=https://mxm6w9ajeg.us-east-1.awsapprunner.com

EXPECTED_OKX_AGENT_ID=5982
ENABLE_A2A_RESPONDER=0
ENABLE_MARKETPLACE_WATCHER=0

ESCROW_ADDRESS=0xcEdB9F7e3f12088dBe85b671393928cdEB4EdFdb
ESCROW_START_BLOCK=65891610
ESCROW_CHAIN_ID=196
USDT_ADDRESS=0x779ded0c9e1022225f8e0630b35a9b54be713736
XLAYER_RPC_URL=https://rpc.xlayer.tech
ESCROW_CONFIRMATIONS=2

ENABLE_GENLAYER_RELAYER=0
GENLAYER_JUDGE_ADDRESS=0x8616cFdc626B57ABca5a6a08B80922e58F8cC494
GENLAYER_RPC_URL=https://studio.genlayer.com/api
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

The current App Runner deployment uses the private `STATE_REMOTE` mirror because
its container disk is ephemeral. The OnchainOS login bundle stays in encrypted
SSM parameters rather than Git. Evidence manifests contain private dispute
data, so the mirror must remain access-controlled. On Lightsail, the persistent
disk and encrypted instance snapshots become the primary state store.

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
