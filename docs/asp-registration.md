# ASP registration runbook

Registration path on onchainos 4.2.1, verified against the live CLI on 2026-07-11. Marketplace
verification reportedly takes ~2 days, so this went first.

## Status: DONE — under review (2026-07-11)

- Agent **#5021 "Prime Port"**, role ASP, registered on-chain
  (tx `0x87f8999a5a4d6d041d29ce9f69b927c53d8823b14491eaf9981660d447aa794d`).
- Approval submitted; listing shows "Listing under review", agent online.
- Communication address `0xef2674A89cbB08BA3EDbe4f4Bd85614B9b8F281A`
  (keyUuid `83600996-7bcb-4d01-93e6-5fd1b89fb2b2`).
- Avatar: monochrome isles mark + PRIME/PORT, hosted at
  `https://static.okx.com/cdn/web3/wallet/marketplace/headimages/agent/avatar/91b8a5dc-f062-4a46-aaef-85b4b6571071.png`.
- A2A runtime (`@okxweb3/a2a-node` 0.1.7) installed on Kenny's machine; daemon autostarts.
- Check review verdict with `onchainos agent get-my-agents --role asp`.

The steps below are kept for reference / re-registration.

## Steps

1. **Consent (Kenny, one time).** `pre-check` already returned the consent key and the OKX AI
   Agent Marketplace ToS. Accepting is a standing agreement on the account, so Kenny runs this
   himself after reading the terms:

   ```
   onchainos agent pre-check --role asp --consent-key b9d92fab-0cfe-4f96-8f71-1185655996f1
   ```

   (Key came from the 2026-07-11 pre-check; if it expires, rerun `pre-check --role asp` without
   the flag to get a fresh one.)

2. **Avatar.** Required for ASP, no default. Upload an image first, keep the returned URL:

   ```
   onchainos agent upload --file <path-to-logo>
   ```

3. **Create.** Name, description, and at least one service are required. Role is fixed at create.
   Draft below; edit before firing.

4. **Activate.** `onchainos agent activate` (agent-status + submit-approval). QA runs at
   register/update time; this is where the multi-day verification clock starts.

## Draft listing (the storefront — review before submitting)

```
onchainos agent create \
  --role asp \
  --name "Prime Port" \
  --description "Hire real humans for jobs agents can't do. Publish a task and Prime Port fans it out to human freelancers, mints you a private port (a live XMTP endpoint you control), and lets you clarify, negotiate, and pick who you hire, exactly like a human client. Escrow, timeouts, and disputes stay native to the marketplace. Payout routes only where the freelancer signed." \
  --picture <URL-from-upload> \
  --service '[{"serviceName":"Human freelancer hiring","serviceDescription":"Post a job for human workers: content, research, testing, real-world tasks, any media evidence. You get a private negotiation channel with every claimant and full hire/approve control. Fee is a transparent cut of the job price at payout.","serviceType":"A2A"}]'
```

Open choices on the listing:

- Service type: `A2A` fits (the agent talks to our agent-side surface); `A2MCP` would require a
  fee + endpoint at listing time. If the MCP endpoint becomes the primary integration we can add
  a second service entry via `agent update` later.
- Fee field is optional for A2A; our take is at the forwarding contract, so leaving it off the
  listing and stating it in the description avoids double-declaring.
