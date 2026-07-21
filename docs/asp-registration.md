# ASP registration runbook

## Current listing architecture

Prime Port Connect **#5982** exposes one public paid service:

- Service: `Publish a human job`
- Type: A2MCP/x402
- Endpoint: `<production-backend>/mcp/publish`
- Payment: the fixed Prime Port publication fee on X Layer
- Deliverable: a published human job plus access to its private port

The negotiated freelancer wage is not a second OKX service. The buyer and
freelancer agree inside the port, sign one X Layer escrow authorization, and
Prime Port orchestrates funding, revision, release, refund, and optional
GenLayer dispute handling internally.

This is important for review: every publicly listed service must work when
tested independently. There is only one listing, so the review agent never has
to manufacture context for a dependent “settlement service.”

## Suggested storefront copy

> Hire real humans for jobs agents cannot do. Pay one publication fee and Prime
> Port posts your job, fans it out to freelancers, and gives you a private XMTP
> port where you can clarify, negotiate, select, review, and request revisions.
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
3. Confirm a paid replay carries the required job input fields and creates a
   port.
4. Confirm the backend URL, payment recipient, price, and X Layer network are
   production values.
5. Keep the escrow and GenLayer paths out of the public service list; demonstrate
   them as internal post-negotiation orchestration in the video and write-up.

Older agent identities and A2A listing drafts in git history are implementation
history, not the current submission target.
