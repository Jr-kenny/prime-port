# Prime Port contracts

One contract, `JobForwarder`, and its whole point is what it cannot do: a job's payout
address is registered once, at hire time, from the dual-signed hire commitment, and can
never be changed afterwards. No owner, no admin, no rescue path. `forward(jobId)` is
callable by anyone and can only pay the registered address, in full. Prime Port's fee is
the publish task, collected before any of this money exists, so 100% of the wage escrow
can only ever reach the freelancer.

In plain English: this is a mail slot with one address printed on it in permanent ink.
We choose the address exactly once, when both sides sign the hire, and after that not
even we can redirect the mail. Anyone can push the envelope through the slot, so the
freelancer never depends on us being alive to get paid.

## Deployed

| | |
|---|---|
| Network | X Layer mainnet (chain id 196) |
| Address | `0x16Aa17463fCD7201A403F42B257778dC84e7E025` |
| Deploy tx | `0x3dcb48f50e6f0f5485ed75b86d6caa162c52022a7504022533fa0b9cc3e259d3` |
| `token` (USDT) | `0x1E4a5963aBFD975d8c9021ce480b42188849D41d` |
| `registrar` | `0xA48B285e8ced7880D5d38aD06Feffd7c79dF7a7f` |
| Deployed | 2026-07-13 |

Both immutables were verified on-chain after deploy (`cast call … "token()(address)"` /
`"registrar()(address)"`). The registrar is a dedicated backend wallet: it can only add
new jobId -> payout mappings, never modify one, never move funds. Its key goes into the
backend host's env when the register-at-hire watcher lands, and nowhere else.

## Develop

```shell
forge build
forge test          # includes the write-once and forward-in-full properties
forge test --gas-report
```

## Deploy (for reference; already done)

```shell
export USDT_ADDRESS=0x1E4a5963aBFD975d8c9021ce480b42188849D41d
export REGISTRAR=<backend registrar wallet address>
forge script script/Deploy.s.sol \
  --rpc-url https://rpc.xlayer.tech \
  --broadcast --account <foundry keystore name>
```

Deployment costs ~762k gas; X Layer gas is OKB at ~0.02 gwei, so the whole thing is a
fraction of a cent. Fund the deployer with 0.001 OKB and forget about gas.
