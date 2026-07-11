# The hire commitment object

The load-bearing interface of Prime Port. When an agent hires a freelancer, both sides sign this
object; from that moment escrow locks, the forwarding contract knows where the money can go, and
the transcript stops being a chat and becomes evidence. Every lane touches it: backend produces
it, contracts registers it, frontend shows it, disputes replay it.

Reference implementation + test vector: `backend/commitment/`. Changing anything in this doc
after it lands means changing the reference impl and the test vector in the same PR, with
everyone's eyes on it.

## The object

```jsonc
{
  "version": 1,
  "jobId": "…",                 // OKX marketplace task id
  "port": {
    "inboxId": "…"              // XMTP inbox id of the port minted for this job
  },
  "agent": {
    "agentId": "…",             // OKX agent id of the hiring agent (e.g. "4711")
    "wallet": "0x…"             // its marketplace wallet, lowercase; this signs
  },
  "freelancer": {
    "inboxId": "…",             // freelancer's own XMTP inbox id
    "wallet": "0x…",            // wallet that signs (embedded or user-provided), lowercase
    "payoutAddress": "0x…"      // where money goes; may differ from wallet, lowercase
  },
  "terms": {
    "criteria": "…",            // acceptance criteria, plain text, exactly as negotiated
    "price": "40",              // decimal string, never a float
    "currency": "USDT",
    "deadline": 1752969600      // unix seconds, UTC
  },
  "feeBps": 250,                // Prime Port fee in basis points, transparent
  "transcriptHash": "0x…",      // hash of the negotiation up to this moment (below)
  "hiredAt": 1752278400         // unix seconds, UTC, set by our backend at hire()
}
```

Rules that make it deterministic:

- All addresses lowercase hex. All hashes 0x-prefixed lowercase hex.
- Money is a decimal string (`"40"`, `"39.5"`), never a JSON number: floats don't survive
  round-trips and 6-decimal USDT doesn't need them.
- Timestamps are unix seconds as integers.

## Canonical encoding and the commitment hash

`commitmentHash = keccak256(canonical(object))` where `canonical` is JSON with:

1. object keys sorted lexicographically at every level,
2. no insignificant whitespace,
3. UTF-8 bytes.

That's it. No protobuf, no RLP: the object is small, human-auditable, and every runtime in this
project (node backend, browser, Solidity via off-chain hashing) can reproduce three rules.

## Signatures

Both parties sign the commitment hash with a plain personal message signature (EIP-191
`personal_sign`) over the string:

```
Prime Port hire commitment v1: <commitmentHash>
```

- **Agent side**: signed by the agent's marketplace wallet (`agent.wallet`). Not by the port:
  the port is our infrastructure, and a port-side signature would prove nothing about the agent.
- **Freelancer side**: signed by `freelancer.wallet`, the MPC embedded wallet or whatever wallet
  they connected. We structurally cannot produce this signature.

`personal_sign` is the one thing every embedded-wallet provider supports today. EIP-712 typed
data is the natural upgrade (nicer wallet UX, on-chain verifiable structure) and slots in as
`version: 2` without touching anything else.

The signed bundle `{ commitment, agentSig, freelancerSig }` is what gets committed: the hash is
registered with the forwarding contract at hire (exact call shape to be agreed with the contracts
lane) and attached to the marketplace acceptance so escrow locks against it.

## The transcript hash

Covers the winning candidate's channel only, from channel open to the hire moment:

```
transcriptHash = keccak256(canonical(messages))
```

where `messages` is the time-ordered array, one entry per message:

```jsonc
{ "id": "…", "sender": "<senderInboxId>", "sentAtNs": "…", "contentSha256": "0x…" }
```

- `id` and `sentAtNs` come from XMTP (`sentAtNs` as a decimal string: nanoseconds overflow JSON
  numbers).
- `contentSha256` is the sha256 of the encoded message content bytes, so the hash commits to
  what was said without embedding the whole conversation in the object.
- Losing candidates' channels are not part of any hash. They close unseen, as promised.

Both sides sign over this hash (inside the commitment), so neither can later claim the
negotiation went differently: the archived transcript either matches the hash or it doesn't.

## In plain English

This object is the handshake made solid. It's a small receipt that says who is hiring whom, for
what, by when, for how much, where the money should land, and what was said on the way here. We
boil the receipt down to a single fingerprint (the hash), and both sides put their signature on
that fingerprint: the agent with its marketplace wallet, the freelancer with theirs. From then
on nobody can quietly change a word of the deal or the conversation behind it, because any
change produces a different fingerprint and the signatures stop matching. Our fee sits inside
the receipt in plain sight, and the payout address in the receipt is the only place the
forwarding contract will ever send money.

## Deliberately not in v1

- EIP-712 typed signatures (v2, additive).
- Multi-currency / fiat: `currency` is there, policy says USDT for now.
- Milestones / partial payouts: one job, one price, one payout.
