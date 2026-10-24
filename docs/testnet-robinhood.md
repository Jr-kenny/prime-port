# Running Prime Port on Robinhood Chain Testnet (46630)

The standalone configuration: publication is paid in native ETH, identity is the
paying wallet, and the wage escrow holds a 6-decimal test dollar. No marketplace
account and no payment facilitator is involved.

## Deployed stack

| Contract | Address | Notes |
|---|---|---|
| `TestUSD` (tUSD) | `0xF736cfDCda31aa450146b6Fe943Ce77Deb2718d8` | 6 decimals, open mint, testnet only |
| `PrimePortEscrow` | `0x3d4EB178D9BcF5E11B019326AC1d62CAab6a5c2A` | holds tUSD, pays freelancers |
| Resolver | `0x5fC7D78CC3676325401eDf47044CB6fc0956a696` | applies dispute splits after a GenLayer verdict |

Deployment transactions:

- `TestUSD` — [`0x16a878e2…59c63`](https://explorer.testnet.chain.robinhood.com/tx/0x16a878e2fc349d941dca7d71c880f86336bcc6f4d47a0a4371be755f68459c63)
- initial 100,000 tUSD mint — [`0x99eb4019…a8b72`](https://explorer.testnet.chain.robinhood.com/tx/0x99eb401953459013d625fb3d4168f62982169394417f34a4742c4e0327ea8b72)
- `PrimePortEscrow` — [`0x5c08860d…0c16f`](https://explorer.testnet.chain.robinhood.com/tx/0x5c08860d2475b22e71e32bd211df25d878c64e2ebd3435ffe0fc5c3a5ab0c16f)

The resolver is a single address on purpose: the GenLayer relayer is the only
writer, and it submits a finalized provider share. It cannot move funds on its
own and it cannot change the payout route.

## Redeploy from scratch

```shell
cd contracts
export DEPLOYER_KEY=0x...        # funded with test ETH
export RESOLVER_ADDRESS=0x...    # an address you control
export MINT_TO=0x...             # receives the opening test USD
forge script script/DeployTestnet.s.sol \
  --rpc-url https://rpc.testnet.chain.robinhood.com \
  --broadcast --private-key "$DEPLOYER_KEY"
```

Gas is test ETH from `faucet.testnet.chain.robinhood.com`. Do not bridge mainnet
assets to the testnet; the faucet is the only source.

## Backend environment

```shell
PAY_TO_ADDRESS=0x5fC7D78CC3676325401eDf47044CB6fc0956a696
PUBLISH_PRICE_ETH=0.001
PUBLISH_CHAIN_ID=46630
PUBLISH_RPC_URL=https://rpc.testnet.chain.robinhood.com
PUBLISH_CONFIRMATIONS=1

ESCROW_ADDRESS=0x3d4EB178D9BcF5E11B019326AC1d62CAab6a5c2A
USDT_ADDRESS=0xF736cfDCda31aa450146b6Fe943Ce77Deb2718d8
ESCROW_CHAIN_ID=46630
ESCROW_CHAIN_NAME="Robinhood Chain Testnet"
ESCROW_RPC_URL=https://rpc.testnet.chain.robinhood.com
ESCROW_START_BLOCK=141716011

GENLAYER_JUDGE_ADDRESS=<judge contract>
GENLAYER_RPC_URL=<genlayer rpc>
GENLAYER_RELAYER_KEY=<relayer key>
RELAYER_TOKEN=<shared secret>
```

The escrow was deployed at block `141716011`, so the watcher starts there and
never scans the chain before the contract existed.

The four escrow values move together. The chain id is bound into the signed hire
authorization, so a half-switched deployment produces authorizations that the
contract rejects. `ESCROW_RPC_URL` is required whenever `ESCROW_ADDRESS` is set:
there is no inherited node default.

The publish fee stays at `0.001` ETH on testnet. If `PAY_TO_ADDRESS` or
`PUBLISH_RPC_URL` is missing the process refuses to boot rather than serve an
unpaid publication.

## Publishing from an agent

Ask for the price and the treasury:

```shell
curl -s https://<host>/mcp/publish | jq .payment
```

Choose a single-use memo, send the exact fee to the treasury, keep the hash:

```shell
MEMO=0x$(openssl rand -hex 32)
cast send $PAY_TO_ADDRESS \
  --value 0.001ether \
  --data $MEMO \
  --rpc-url https://rpc.testnet.chain.robinhood.com \
  --private-key $AGENT_KEY
```

Replay the job fields with the payment headers:

```shell
curl -s -X POST https://<host>/mcp/publish \
  -H 'content-type: application/json' \
  -H "payment-tx: $TX_HASH" \
  -H "payment-memo: $MEMO" \
  -d '{
    "title": "Photograph a Lagos storefront",
    "description": "Take a daylight photo of the storefront at the given address and return the original image.",
    "criteria": "Store name and entrance are visible and legible.",
    "deliverables": "One original JPEG, unedited.",
    "deadline": 1999999999,
    "agentWallet": "<your wallet>",
    "price": "40"
  }'
```

The response carries `jobId`, the confirmed payment, and the HTTP inbox where
candidates appear. There is no `conversation` field: a publication is a direct
port, not a chat on someone else's platform.

## Talking to candidates

The buyer agent gets a session from its wallet, then long-polls the inbox:

```shell
curl -s -X POST https://<host>/auth/agent-challenge \
  -H 'content-type: application/json' -d '{"wallet":"<agent wallet>"}'
# sign the returned message, then:
curl -s -X POST https://<host>/auth/agent-session \
  -H 'content-type: application/json' \
  -d '{"challenge":"<challenge>","signature":"0x..."}'

curl -s "https://<host>/jobs/$JOB/inbox?after=0&wait=25" \
  -H "authorization: Bearer $TOKEN"

curl -s -X POST "https://<host>/jobs/$JOB/messages" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"candidateId":"C1","body":"Can you shoot at 9am?","clientId":"ask-1"}'
```

`after` is the last `seq` processed, `wait` long-polls up to 25 seconds, and
`clientId` makes a write idempotent. Messages are relayed verbatim. See
[/agents](https://primeportlive.vercel.app/agents) for the same contract.

## Settlement

1. The freelancer claims the port with a payout wallet.
2. The buyer hires: the commitment is hashed, the buyer signs, the freelancer
   countersigns the same authorization.
3. The backend returns exact `approve` + `fund` transactions. The escrow emits
   `EscrowFunded` and the job is locked.
4. The freelancer submits revisions; the buyer approves one.
5. The backend returns the `release` transaction. Approval is not payment — only
   the observed `EscrowReleased` event is.
6. On disagreement the backend writes a content-addressed evidence manifest, the
   GenLayer judge returns a provider share, and the resolver applies the split.

## What the fee buys

The fee buys the port, not the work. The wage is a separate escrow the buyer
funds after hiring, and it is the only money a freelancer can be paid from.
`FEE_BPS` is `0`, so Prime Port takes no cut of the wage.
