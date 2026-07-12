# Port mechanics — spike findings

Answers the open item "verify agent-side UX for holding a port installation." Verified against
the XMTP docs (manage-inboxes) and the onchainos 4.2.1 CLI on 2026-07-11.

## The one-sentence answer

Granting the agent a port installation is a single remote signature: the agent generates its own
installation keys locally, we sign the registration once with the port wallet, and from then on the
agent operates the port on its own power while we keep the only key that can revoke it.

## How XMTP installations actually work

- An inbox is created by a wallet (the "recovery identity"). That wallet is fixed forever and is
  the only thing that can revoke installations or remove identities.
- A new installation is just a fresh key pair generated on whatever machine runs the client. It
  gets bound to the inbox by one wallet signature at client creation. Nothing else is needed.
- Up to 10 installations per inbox, 256 lifetime identity updates. Irrelevant for us: a port is
  one job, roughly 2 installations (ours + the agent's), then dead.
- `revokeInstallations` is signed by the recovery wallet. Static revocation works even with no
  live client, so scrap works no matter what state the agent left things in.

**In plain English:** an XMTP inbox works like a messaging account that can be logged in on
several devices at once (think WhatsApp on your phone and laptop). Each logged-in device is an
"installation". Adding a device needs one approval signature from the account's owner wallet,
and only that owner wallet can log a device out. The agent never creates anything and never gets
an identity of its own: we open the account, and the agent gets one device slot on it.

## Port lifecycle, concretely

1. **Mint**: generate a fresh wallet (the port key), create the XMTP inbox with it. We hold this
   key for the life of the job and burn it at scrap.
2. **Grant**: the agent's runtime creates an XMTP client for the port's identity with no local DB.
   The SDK asks its signer for one wallet signature to register the new installation. We proxy
   that signer: the agent sends us the exact bytes the SDK wants signed, our port-key service
   signs, done. The agent's installation keys are generated on the agent's side and never pass
   through us, so we cannot impersonate the agent's installation after the grant.
3. **Operate**: the agent runs the port first-person. Freelancer channels are normal XMTP DMs/
   groups on the port inbox. No further signatures from us are needed for messaging.
4. **Revoke + scrap**: after settlement + quiet window, we sign `revokeInstallations` for the
   agent's installation with the port wallet, archive the transcript, and destroy the port key.
   Revocation is permanent at protocol level; the inbox is dead weight after that.

**In plain English:** we open a phone line and keep the SIM account in our vault. The agent says
"here's my new phone, sign me in", we approve it once, and from then on it makes and takes calls
as the line with no help from us. Every freelancer who claims the job gets their own private call
with that line; nobody hears anyone else's. When the job settles we log the agent's phone out
permanently and cancel the line, so the number can never be used again, not even by us. The
one-time sign-in approval is the entire ceremony: the agent's own keys are made on its machine
and we never see them (so we can't fake its words), while we keep the one power that matters
(kicking the device off and burning the line).

Handing the agent a pre-built installation (exported keys / DB) would also work but is strictly
worse: we'd have held the agent's installation keys, which breaks the "we can't forge
conversations" claim on the agent side. The remote-sign grant keeps that claim true for both
sides of the port.

## How this meets the OKX side

- OKX agents already speak XMTP: the marketplace runs its own XMTP system accounts
  (`onchainos agent system-config` returns them) and agent chat goes through the `okx-a2a`
  companion tool (`session create`, `xmtp-send`), which the onchainos CLI shells out to.
- Verified against the published package (`@okxweb3/a2a-node` 0.1.7 on npm): it is a plain
  `@xmtp/node-sdk` 4.6.0 + `@xmtp/agent-sdk` 0.0.7 stack. The agent's XMTP identity is a local
  hex private key (`XMTP_WALLET_KEY` or generated via viem) wrapped in a standard signer and
  passed to `Agent.create` / `Client.create`. Nothing binds the runtime to the marketplace
  identity, so running a second client against our port inbox is just another `Client.create`.
- Better still, the XMTP `Signer` the SDK expects is a `signMessage` callback. Our remote-sign
  grant plugs straight into the SDK version OKX already ships: the agent calls `Client.create`
  for the port identity with a signer whose `signMessage` hits our port-key endpoint once.
- Our MCP surface should still offer a guided handshake (`port_connect`) plus a full fallback
  where `negotiate` and friends operate the port server-side, for agents whose runtimes can't
  spawn a raw XMTP client.

**In plain English:** OKX agents already carry a perfectly normal XMTP messaging app under the
hood, and nothing in it is welded to their marketplace identity. Logging that app into our port
as a second account is routine, and the sign-in approval step plugs into the exact software
version OKX already ships. For agents that can't run their own messaging client at all, our
tools can drive the port for them as a fallback.

## Prototype results (2026-07-11, live XMTP dev network)

Two-process prototype in `backend/spike-port-grant/` using @xmtp/node-sdk 4.6.0 (the exact
version okx-a2a pins). `port-service.mjs` holds the port wallet and exposes `/sign` + `/revoke`;
`agent.mjs` plays the agent plus a freelancer. The test freelancer uses a locally generated key
as a stand-in for the real thing: in production the freelancer signs with their own MPC embedded
wallet (provisioned at claim, we cannot sign for them) or any wallet they bring. To XMTP the two
are identical, so nothing the spike proved changes. Note the wallet count: the port wallet is
ours and disposable by design, the freelancer's wallet is theirs and durable (it signs their
messages and receives the payout), and the agent holds no wallet at all on our side, only device
keys the port wallet approved. All three phases verified end to end:

- **Grant works**: the agent registered its own installation on the port inbox through one
  proxied signature. The port wallet key never left the service process.
- **Operate works**: a freelancer DM'd the port, the agent read and replied as the port, and the
  freelancer's client attributed the reply to the port's identity.
- **Revoke works, with one catch that matters**: revocation removes the installation from the
  inbox immediately (network state confirms; `isInstallationAuthorized` flips to false), but the
  revoked installation could STILL deliver messages into the existing conversation. This is
  documented XMTP behavior: existing groups only eject a revoked installation when some member's
  sync triggers a membership commit, with no timing guarantee. Fix: scrap must flush. After
  revoking, the port service's own installation syncs every conversation and posts a closing
  message, which rotates each group's epoch; after that the agent's send fails hard with
  "Group is inactive". **Scrap = revoke + flush, never revoke alone.**

Two refinements from productionizing this in `backend/port-service` (the e2e found both):

- **Flush ordering matters.** The closing send only commits the eviction if the sending client
  builds the conversation's membership from identity state fetched AFTER the revocation. If the
  service client already synced the conversation before revoking (say, to archive it), its send
  reuses the cached membership and commits nothing, and the revoked agent keeps working. So
  scrap is strictly: revoke first, then first-sync + archive + closing send. And because the
  working installation has always synced by scrap time on a real job (hire reads the channel to
  compute the transcript hash, get_offers reads it constantly), the "first sync after revoke"
  can't come from it. Every port therefore mints a second, cold installation alongside the
  working one: it collects welcomes from birth but never syncs until scrap, so its first sync is
  guaranteed to land after the revocation. Scrap revokes everything except the scrapper — the
  working installation dies with the agent's — and the scrapper archives and flushes.
- **The lockout lands when the revoked client syncs.** MLS receivers tolerate a short window of
  past epochs for out-of-order delivery, so a client that deliberately stops syncing can inject
  a message or two right after the flush. This can't touch evidence: the archive is taken at
  scrap, so nothing after the closing marker exists in any transcript, and our freelancer UI
  treats post-"[port closed]" messages as void.

**In plain English:** logging the agent's device out of the account works instantly on paper,
but a conversation that device was already in keeps accepting its messages until another
participant checks in and notices the logout. So when we close a port we don't just log the
device out; our side immediately pings every conversation with a "[port closed]" message, which
slams the door for real. Two fine-print notes from building the real service: the door only
slams if our side looks at the conversation with fresh eyes after the logout. Our everyday
device has always peeked at the conversation before closing time, so every port keeps a spare
device in a drawer from day one: it's on the account and receives its invitations, but never
opens the app until closing day, when it logs everything else out, reads the whole history with
fresh eyes, files the evidence, and posts the closing message. Separately, a device that covers
its ears and refuses to sync can shout
one last thing through the closing door. That last shout can never matter, because the evidence
record is sealed at closing time and anything after the closing marker is ignored. We proved all
of this against XMTP's live test network, including the freelancer seeing the agent's replies as
coming from the port itself.

## What's still open

- [ ] Decide message-expiry handling knob: archive at settlement is already the plan; confirm
      the archive format includes the transcript hash inputs committed at hire.
