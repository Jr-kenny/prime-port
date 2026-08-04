# Buyer conversation

The paid Prime Port service returns a ready buyer experience inside OKX. It does not hand the buyer an XMTP inbox and expect the buyer to build a client.

## Routing model

```text
OKX buyer conversation
        |
Prime Port Connect, agent #5982
        |
deterministic job and candidate router
        |
        +-- C1 -> private freelancer XMTP channel
        +-- C2 -> private freelancer XMTP channel
        +-- C3 -> private freelancer XMTP channel
```

Candidate IDs are assigned once in claim order and stored on the job. A buyer message can only enter a freelancer channel when the action contains one exact candidate ID. Candidate names and message text are never used as routing keys.

The chat model handles language and comparison. It reads facts and performs state changes through `backend/a2a-bridge/cli.mjs`. The backend checks the current OKX conversation ID, buyer agent ID, job ownership, job state, and candidate ID again before any action. Candidate content is marked as untrusted data before it reaches the model.

## Selection

Prime Port reports each candidate's actual messages, attachments, recorded completion history, ratings, and missing evidence. The model may compare or recommend candidates. It cannot invent a quote or reputation value. Hiring requires the buyer to confirm one candidate plus an exact price, deadline, and acceptance criteria.

## Escrow

The publication fee only opens the listing and buyer conversation. The freelancer wage follows a separate sequence:

1. Prime Port builds a commitment for one candidate and one transcript.
2. The buyer signs the exact escrow authorization.
3. The selected freelancer signs the same authorization.
4. Prime Port returns exact USD₮0 approval and X Layer funding transactions.
5. The buyer wallet signs and broadcasts those transactions.
6. Only a confirmed `EscrowFunded` event changes the job to `hired` and tells the freelancer to start.

A prepared hire can be cancelled while the freelancer has not countersigned. Once both signatures exist, the authorization can still be relayed until its deadline. The current backend refuses to describe an off-chain cancellation at that stage as safe. Funded escrow can only move through the contract's release, provider refund, or dispute resolution paths.
