# ASP registration runbook

## Current service architecture

Prime Port Connect **#5982** exposes one public paid service:

- Service: `Publish a human job`
- Paid trigger: A2MCP/x402
- Buyer interface: the existing OKX A2A conversation with Prime Port Connect
- Endpoint: `<production-backend>/mcp/publish`
- Payment: the fixed Prime Port publication fee on X Layer
- Deliverable: a published human job plus a ready buyer conversation, with no
  XMTP setup required

The negotiated freelancer wage is not a second OKX service. The buyer and
freelancer agree inside the port, sign one X Layer escrow authorization, and
Prime Port orchestrates funding, revision, release, refund, and optional
GenLayer dispute handling internally.

This is important for review: every publicly listed service must work when
tested independently. The paid response returns a working conversation rather
than an inbox identifier. Prime Port Connect keeps each freelancer behind a
stable candidate ID and handles the later steps in that same OKX conversation.

## Suggested storefront copy

> Hire real humans for jobs agents cannot do. Pay one publication fee and Prime
> Port posts your job, fans it out to freelancers, and opens a ready conversation
> with Prime Port Connect inside OKX. Freelancers appear as separate candidates
> such as C1 and C2, so you can clarify, negotiate, select, review, and request revisions
> without installing XMTP or building another endpoint.
> If you hire, the separately negotiated wage is protected by a dual-signed X
> Layer escrow. Approval pays the signed freelancer address; disputes are judged
> through GenLayer.

The listing must not promise OKX-native wage escrow, automatic marketplace
timeouts, a second private ASP, or the retired `JobForwarder` route.

## Submission checks

Before submitting or resubmitting:

1. Confirm the active OnchainOS account owns and can read agent #5982.
2. Confirm the advertised URL returns a valid x402 `402 Payment Required`
   response for both discovery GET and the unpaid POST.
3. Confirm a paid replay carries the required job input fields, creates a port,
   and returns the ready OKX conversation contract instead of a raw inbox ID.
4. Confirm the backend URL, payment recipient, price, and X Layer network are
   production values.
5. Send a real candidate message and confirm it arrives in the buyer's existing
   OKX conversation under a stable candidate ID.
6. Keep the escrow and GenLayer paths out of the public service list; demonstrate
   them as internal post-negotiation orchestration in the video and write-up.

Do not resubmit until the live buyer conversation, candidate routing, and exact
DeepSeek model are verified on the deployed backend.
