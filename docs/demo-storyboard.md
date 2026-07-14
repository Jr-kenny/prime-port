# Demo storyboard — one take, one conversation

The demo is a single continuous screen recording of the product being used: a job gets
published, Kenny clicks it, claims it, and asks for the job in the port chat; the agent
pushes back on price, they go back and forth, the agent sends the hire commitment, Kenny
signs it, delivers the work, the agent approves. Boom. Anybody with a brain follows it
without a voiceover, because it is just two parties talking and a deal happening. The
write-up on the submission page is the explainer; the video only has to show the thing
existing.

OKX caps the video at 90 seconds, so the take gets trimmed in the edit (speed up the
waiting, cut the dead air, never stage a screen). The negotiation is the heart: keep the
exchange where the human pushes the price UP and wins.

## How it's recorded

Two seats, one screen recording each (or side by side):

- **Kenny is the freelancer**: on the live site, on camera. Sees the job, clicks it,
  signs in with email, claims, and opens with something human: "can I have this job?
  I'd do it like this…". Later: one click to countersign the hire, then delivers the
  file through the same chat.
- **A Claude session is the agent**: drives `backend/mcp-server/demo-agent.mjs` against
  the production backend. Each beat is one command, so the agent answers at
  conversation speed. The agent's voice in chat: short, businesslike, a real client.
  It pushes back on price at least twice before settling.

The port side on camera is entirely real: real MCP tools, real XMTP channel, real
signatures over the real commitment object. The marketplace money legs are simulated by
the driver (`publish` marks the fee paid, `escrow` locks the wage) because the camera is
pointed at the port, not the marketplace. The full on-chain loop is a separate run that
closes issue #24, gets linked from the submission page as the receipts.

## The beats and the driver commands

```
# agent publishes (fee marked paid, port unlocked)
node demo-agent.mjs publish "Photograph a sunset over the harbor" \
  "One original photo, tonight, min 3000px wide. Deliver via the port." 8

# Kenny's phone buzzes via Telegram fan-out (production poster), he claims on the site
# and says his opening line in the chat

node demo-agent.mjs offers <jobId>                 # agent sees the claim + message
node demo-agent.mjs say <jobId> <inbox> "8 is the budget. What makes you worth more?"
# ...back and forth, settle at 10...

node demo-agent.mjs hire <jobId> <inbox> 10        # commitment + agent signature in one
# Kenny countersigns in the web app (one click)

node demo-agent.mjs escrow <jobId>                 # wage escrow locks -> status hired
# Kenny delivers the photo through the chat

node demo-agent.mjs offers <jobId>                 # agent reviews the evidence
node demo-agent.mjs approve <jobId> "Got the shot, exactly the frame I wanted. Approving now, payout's on its way."
# the closing word rides on approve: once the deal is struck the port stops
# relaying loose chat, so the agent's last message is carried by approve itself,
# dropped into the channel a beat before the port closes. Then: settle + scrapped.
```

`BACKEND=<render url>` points the driver at production. The driver keeps one persistent
demo wallet in `data/demo-agent-key` so the hire signature verifies across commands.

## Pre-flight

- [ ] Kenny's site login exists already (first-time wallet provisioning is slow TV).
- [ ] Telegram notifications on, channel joined: the buzz opens the video.
- [ ] One dry run of the whole conversation off camera. Keep that recording as backup.
- [ ] Agree the price dance beforehand: open 8, ask 11, settle 10. Improvise the words,
      not the numbers.

## The edit

- Open on the phone buzz, end on "approved" plus the paid state in the chat header.
- Compress waiting (XMTP latency, page loads) with speed-ups and cuts; stage nothing.
- If a beat must go to fit 90 seconds, cut from the middle of the negotiation, never
  the opening claim ("can I have this job?") or the countersign moment.
- The submission page carries the rest: the two-task payment model, the forwarding
  contract with the on-chain receipts, the timeout story, the uncut recording.

In plain English: the video is just a customer and a worker striking a deal in a chat
window, except the customer is a robot and every promise they make to each other turns
into a signature. Anyone can follow it. The clever parts (the money rails, the contract
that cannot steal) live in the write-up for whoever wants to look deeper.
