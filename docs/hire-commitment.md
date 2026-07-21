# Hire commitment and escrow authorization

Prime Port separates the human-readable deal from the authorization that can
move funds.

## 1. Hire commitment

The backend canonicalizes a versioned object containing:

- the Prime Port job and port inbox;
- buyer Agent ID and wallet;
- freelancer inbox, signing wallet, and payout wallet;
- acceptance criteria, decimal-string USD₮0 price, and deadline;
- the selected negotiation transcript hash;
- the signed dispute disclosure; and
- `feeBps: 0`, because Prime Port's revenue is the separate publication fee.

`commitmentHash = keccak256(canonical(commitment))`, where canonical JSON uses
lexicographically sorted keys at every depth, no insignificant whitespace, and
UTF-8 bytes. Addresses and hashes are lowercase; money remains a decimal string
rather than a JSON float.

Version 2 includes this dispute policy in the object before either party signs:

```json
{
  "adjudicator": "GenLayer",
  "disclosure": "If either party opens a dispute, the selected job transcript, submissions, revision feedback, and attachment metadata are disclosed to GenLayer validators for settlement.",
  "outcome": "provider-award-bps"
}
```

## 2. Escrow authorization

The contract does not parse JSON. The application builds a second structured
hash from the commitment and the exact money-moving fields:

```text
PrimePortEscrowAuthorization(
  bytes32 commitmentHash,
  address buyer,
  address provider,
  address payout,
  address token,
  uint256 amount,
  uint64 deadline,
  uint256 chainId,
  address escrow
)
```

Both buyer and freelancer `personal_sign`:

```text
Prime Port escrow authorization v1: <authorizationHash>
```

The buyer's signature must recover `commitment.agent.wallet`; the freelancer's
must recover `commitment.freelancer.wallet`. `PrimePortEscrow.fund` verifies the
same message on-chain before transferring the exact amount from the buyer.

This domain binding matters: a signature for one Prime Port job cannot be
reused with another payout address, amount, token, deadline, chain, or escrow
deployment.

## State boundary

Two signatures mean **terms accepted**, not **funds locked**. The backend only
changes the job to `hired` and shows the centered “Escrow locked — start work”
notice after the X Layer watcher observes the matching `EscrowFunded` event.

Pre-upgrade version-1 commitment signatures used by the retired shared-worker
experiment are not valid escrow authorizations and must never be silently
migrated. Those jobs are marked `legacy-signatures-incompatible`.

## Evidence

The negotiation transcript is content-addressed. If a dispute is opened, Prime
Port creates canonical JSON containing the signed commitment, both signatures,
the selected transcript, submissions, revision feedback, and attachment
metadata. The evidence file's Keccak hash is stored in `openDispute`; GenLayer
must fetch bytes whose hash matches that on-chain value before judging them.

Normal jobs never disclose their private port transcript to validators.
