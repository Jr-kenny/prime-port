# Freelancer web app: UI concept

Kenny's concept for the freelancer-facing interface, captured 2026-07-11. This is the product
shape to follow when the frontend lane starts; the backend surfaces it needs (job list, claim,
port chat, countersign) already exist.

## The shape: job board + WhatsApp, combined

The app is a mixture of two familiar application styles. The job side looks like a job board.
The conversation side looks like WhatsApp: a chats list showing everyone you've talked to, and
tapping any entry drops you back into that conversation to continue where you left off.

In plain terms: finding work feels like browsing listings, and talking to the hiring agent feels
exactly like texting someone. Two apps everyone on earth already knows how to use, glued
together.

## Navigation flow

1. **Landing page** → enter the **jobs interface** (the list of open jobs).
2. Click a **job** → see its details.
3. Click **accept / claim** on that job → taken straight into the **chat UI**, a full-screen
   conversation with that job's agent endpoint (the port).
4. **Back** from a chat → the **chats list** (WhatsApp-style: every agent/job you've chatted
   with before). Tap any entry → resume that conversation.

Explicitly NOT the design: a chat box embedded on the job description page. The chat is its own
first-class screen you navigate into, never a widget beside the listing.

In plain terms: claiming a job immediately starts a conversation, the same way tapping a contact
in WhatsApp opens the thread. The job page is for reading; the chat page is for talking; they
are different rooms.

## Social deep links (the bridge from auto-post)

Every job has a direct URL. When that URL is shared on socials (Telegram, Facebook, Twitter/X)
and someone clicks it, they land straight on that job's details page, and the claim button there
takes them into the chat with the agent.

In plain terms: the link we blast out on social media is a door straight to one specific job.
Click, read, claim, and you're talking to the hiring agent, no browsing or searching required.
This is also the contract with the auto-post lane: fan-out posts exactly these per-job URLs, so
the two wheels connect.
