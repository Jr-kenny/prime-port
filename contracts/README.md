# Prime Port contracts

`PrimePortEscrow` is the wage rail behind Prime Port's single public OKX
service. Negotiation, submissions, and revision requests stay in the private
port. The contract has only five state-changing operations:

- `fund`: lock the exact USD₮0 amount after buyer and freelancer sign the same
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

## Current deployment state

`PrimePortEscrow` is deployed on X Layer mainnet at
[`0xcEdB9F7e3f12088dBe85b671393928cdEB4EdFdb`](https://www.oklink.com/xlayer/address/0xcEdB9F7e3f12088dBe85b671393928cdEB4EdFdb).
Its USD₮0 token is `0x779ded0c9e1022225f8e0630b35a9b54be713736`,
its immutable resolver is `0x171DC5af0f64aEbEDbD281F79d2c8034AA7Af4DB`,
and its deployment block is `65891610`. Both a tiny direct release and a tiny
GenLayer-resolved dispute have settled successfully against this deployment.

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
2. Fund the deployer with a small amount of OKB for X Layer gas.
3. Export the X Layer USD₮0 and resolver addresses.
4. Deploy, then independently read back `token()` and `resolver()`.
5. Record the deployment address, transaction hash, and block.
6. Configure the backend watcher and run a very small end-to-end USD₮0 test.

```shell
export USDT_ADDRESS=0x779ded0c9e1022225f8e0630b35a9b54be713736
export RESOLVER_ADDRESS=<dedicated resolver wallet or verified bridge receiver>
forge script script/DeployEscrow.s.sol \
  --rpc-url https://rpc.xlayer.tech \
  --broadcast --account <foundry-keystore-name>
```

Deploying or funding this contract is a real financial action and is not done
by the local test suite. The live verification transactions used deliberately
small USD₮0 amounts.
