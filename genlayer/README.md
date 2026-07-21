# Prime Port GenLayer adjudication

`contracts/PrimePortJudge.py` is the dispute-only Intelligent Contract. It
does not custody funds. A relayer submits the content-addressed evidence URL,
waits for a finalized verdict, and calls `resolveDispute` on the X Layer
`PrimePortEscrow` contract.

The award is deliberately discrete (`0`, `2500`, `5000`, `7500`, or `10000`
basis points). Validators compare the money-moving fields exactly while the
human-readable reasoning may vary.

The evidence endpoint is part of the signed Prime Port dispute policy. Its
body is hashed before the case opens, and the Intelligent Contract rejects a
body whose Keccak-256 does not match the on-chain `DisputeOpened` hash.

The live judge is deployed on GenLayer studionet at
`0x8616cFdc626B57ABca5a6a08B80922e58F8cC494`. Its finalized verdicts are
relayed by the immutable X Layer resolver
`0x171DC5af0f64aEbEDbD281F79d2c8034AA7Af4DB`. A live 50/50 dispute verdict
has been finalized and settled through `PrimePortEscrow`.

Deploy through GenLayer Studio or the GenLayer CLI, then configure:

```text
GENLAYER_JUDGE_ADDRESS=<deployed intelligent contract>
GENLAYER_RPC_URL=https://studio.genlayer.com/api
GENLAYER_CHAIN=studionet
GENLAYER_RELAYER_KEY=<managed secret>
RELAYER_TOKEN=<high-entropy backend marker secret>
ESCROW_ADDRESS=<deployed X Layer PrimePortEscrow>
```

`GENLAYER_CHAIN` accepts `studionet`, `asimov`, or `localnet`; it defaults to
`studionet`. The relayer is disabled unless every required secret is present.

Before any replacement deployment, validate the exact SDK dependency pinned in
the contract:

```shell
genvm-lint check contracts/PrimePortJudge.py
```
