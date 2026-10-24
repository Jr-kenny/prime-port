# Prime Port contracts

`PrimePortEscrow` is the wage rail behind every Prime Port job. Negotiation,
submissions, and revision requests stay in the private port. The contract has
only five state-changing operations:

- `fund`: lock the exact token amount after buyer and freelancer sign the same
  chain- and contract-bound authorization.
- `release`: the buyer accepts the work and pays the signed payout address.
- `refund`: the freelancer voluntarily cancels and returns everything to the
  buyer.
- `openDispute`: either party freezes the escrow and commits an evidence hash.
- `resolveDispute`: the immutable resolver applies one finalized GenLayer
  result, expressed as the provider's share in basis points.

There is no owner, upgrade hook, arbitrary withdrawal, mutable payout address,
or Prime Port wage fee. The resolver cannot touch funded happy-path jobs; it can
only settle an escrow after a party has moved it into `Disputed`.

## Authorization

Both parties `personal_sign` this exact message:

```text
Prime Port escrow authorization v1: <authorizationHash>
```

The hash binds `commitmentHash`, buyer, provider, payout, token, amount,
deadline, chain ID, and escrow address. This prevents a valid signature from
being replayed for another amount, wallet, chain, or deployment. EOA and
ERC-1271 smart-account signatures are supported.

## Deployments

| Chain | Contract | Token | Resolver |
|---|---|---|---|
| Robinhood Chain Testnet (46630) | `0x3d4EB178D9BcF5E11B019326AC1d62CAab6a5c2A` | `TestUSD` `0xF736cfDCda31aa450146b6Fe943Ce77Deb2718d8` (6 decimals, open mint) | `0x5fC7D78CC3676325401eDf47044CB6fc0956a696` |
| X Layer mainnet (196), legacy | `0xcEdB9F7e3f12088dBe85b671393928cdEB4EdFdb` | `0x779ded0c9e1022225f8e0630b35a9b54be713736` | `0x171DC5af0f64aEbEDbD281F79d2c8034AA7Af4DB` |

Both a tiny direct release and a tiny GenLayer-resolved dispute have settled
against the legacy X Layer deployment. The testnet deployment is exercised by
`backend/mcp-server/settlement-e2e.mjs`.

The older `JobForwarder` remains deployed at
`0xe3f11D89e585e2F0009ee5c6f105861525f70712`. It is immutable historical
infrastructure and is no longer part of new Prime Port hires.

## Develop

```shell
forge build
forge test
forge test --gas-report
```

## Deploy checklist

1. Deploy the GenLayer judge and prepare the dedicated resolver/relayer wallet.
2. Fund the deployer with the chain's native gas token.
3. Export the settlement token and resolver addresses.
4. Deploy, then independently read back `token()` and `resolver()`.
5. Record the deployment address, transaction hash, and block.
6. Configure the backend watcher and run a very small end-to-end token test.

On Robinhood Chain Testnet, `script/DeployTestnet.s.sol` deploys `TestUSD` and the
escrow together:

```shell
cd contracts
export RESOLVER_ADDRESS=<resolver wallet>
export MINT_TO=<address that receives the opening test USD>
forge script script/DeployTestnet.s.sol \
  --rpc-url https://rpc.testnet.chain.robinhood.com \
  --broadcast --account <foundry-keystore-name>
```

On a chain that already has the settlement token, `script/DeployEscrow.s.sol`
takes the token and resolver as environment variables:

```shell
export USDT_ADDRESS=<settlement token>
export RESOLVER_ADDRESS=<dedicated resolver wallet or verified bridge receiver>
forge script script/DeployEscrow.s.sol \
  --rpc-url <rpc> \
  --broadcast --account <foundry-keystore-name>
```

Deploying or funding this contract is a real financial action and is not done by
the local test suite. Live verification transactions should use deliberately
small amounts.
