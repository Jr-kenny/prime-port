# Social auto-posting: rich cards on X and Telegram

Date: 2026-07-14

## What this is and why

Prime Port already advertises every new job to Telegram, no hands: `backend/distribution/poster.mjs` polls the jobs surface and posts each new open job once. Two things are missing. X (Twitter) was never built, and the posts are plain lines of text that link back with a stale `/#id` URL. This design finishes the fan-out: it adds X as a first-class channel, gives every post a rich preview card that unfurls with the job's own title, price, and a branded image, and hardens the poster so it never re-spams a feed after a redeploy.

In plain terms: right now a job announcement is a bare link in a Telegram chat. After this, a new job shows up on both X and Telegram looking like a real job ad, a designed card with the title and pay on it, and clicking it drops the freelancer straight onto that job's page ready to claim.

The scope fence from the brief still stands: socials are adverts only, claiming always happens on our own site, and it's X and Telegram only (Reddit stays out).

## The two halves

The feature splits cleanly into two parts that can be understood and built on their own:

1. **The share endpoint (lives on Vercel, with the web app).** Turns `/s/<jobId>` into a page that carries per-job Open Graph tags and a generated card image. Social crawlers read the tags and draw the card; humans get bounced straight to the job's page. This is where the "rich card" comes from.
2. **The poster (lives in the backend).** Becomes multi-channel, reliability-hardened, and platform-aware: one small module per channel, durable per-channel dedup, per-platform message formatting, and a gentle cap so a burst of jobs doesn't flood a feed.

They meet at one string: the share URL. The poster builds `<SITE_BASE>/s/<jobId>` and hands it to each channel; the share endpoint is what that URL resolves to.

## Part 1: the share endpoint (Vercel)

Two Vercel functions, both co-located with the web app under `web/`:

- **`/s/[id]`** returns a small HTML document whose `<head>` carries the Open Graph and Twitter Card meta tags for that job: `og:title` (the job title), `og:description` (a trimmed line of the criteria plus "Open to offers" or the price), `og:image` (pointing at the card image below), and the Twitter card type. The `<body>` immediately redirects a human visitor to `/jobs/<id>` (the real SPA route) with both a `<meta http-equiv="refresh">` and a small script, so a person who clicks the link lands on the job while a crawler stays on the meta tags.
- **`/api/og/[id]`** is an Edge function using `@vercel/og` that renders the branded card image (PNG): Prime Port styling, the job title, and the pay line ("Open to offers" or "X USDT"). This is the picture inside the unfurled card.

Both functions read the job by fetching the backend. Today the backend only exposes `GET /jobs` (the whole list); this design adds a `GET /jobs/:jobId` single-job read so the functions fetch just what they need. The functions get the backend base URL from an env var on Vercel (the same Render URL the `/api` rewrite already points at).

Caching: Vercel caches both responses, so each job's card and image are generated once and served from cache to every subsequent crawler or click. At our volume this keeps function invocations negligible (and free on the Hobby plan).

Why a dedicated `/s/<id>` rather than putting the tags on `/jobs/<id>` directly: `/jobs/<id>` is the client-rendered SPA route, served as static `index.html` via the SPA-fallback rewrite. Intercepting it to inject per-job tags means fighting the SPA's own serving. A separate share route sidesteps all of that: crawlers get clean per-job tags, humans get redirected onto the real job page, and the SPA is left untouched.

In plain terms: `/s/<id>` is a little signpost page. Robots (X, Telegram) stop and read the sign to draw the pretty card. People don't even see it, they get whisked straight to the job. And because the signs are cached, we draw each one only once.

### Failure behavior

If the backend is down or the job doesn't exist, the share endpoint does not error out at the crawler. It falls back to a generic Prime Port card (house image, "A job on Prime Port", link to the marketplace) so a link never unfurls broken. The OG image function falls back to a static branded banner on any render error.

## Part 2: the poster (backend)

### Channel modules behind one interface

The poster stops being Telegram-specific. Each channel becomes a small module exposing the same shape:

```
{ name: "telegram" | "x",
  enabled(): boolean,          // true only if its creds are present
  post(job, shareUrl): Promise // throws on failure
}
```

The poll loop stays the same in spirit: fetch the jobs, and for each open job, for each enabled channel it hasn't posted to yet, format and post. Adding a platform later is writing one more module, nothing else changes. The existing "switch off cleanly when creds are missing" behavior is preserved per channel.

### Telegram module

The current Telegram code moves into its module mostly as-is: the free bot API, `sendMessage`, the richer multi-line format (title, pay, spec line, link). Reads `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

### X module

Posts with `POST /2/tweets` using OAuth 1.0a user-context (the four credentials: `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`), so the tweet lands on the dedicated Prime Port account those tokens belong to. OAuth 1.0a request signing (HMAC-SHA1) is implemented with Node's built-in `crypto`, no new dependency, since it's a contained bit of signing code and the backend keeps its dependency surface small. The module stays dormant if any of the four are missing, exactly like Telegram.

### Durable, per-channel dedup

This is the "smart poster knows what it already posted" part. Today's `posted.json` sits on Render's ephemeral disk, so a redeploy wipes it and every open job gets re-posted. Instead, the posted record moves onto the job itself in the backend's persisted, backed-up state:

```
job.postedTo = { telegram: <timestamp>, x: <timestamp> }
```

The poster reads `postedTo` (over REST) to decide which channels a job still needs, and after a successful post to a channel it records that channel via a new `POST /jobs/:jobId/posted { channel }` endpoint, which sets the timestamp and saves. Because it lives in the job record, it survives restarts and redeploys, and because it's keyed per channel, a job posted to Telegram but not yet to X (say X's creds arrived later) gets picked up for X on the next tick without re-posting to Telegram. `postedTo` is internal metadata and is not surfaced in the public web job payload.

The old `posted.json` file and its read/write go away.

### Per-platform formatting

One formatter per channel, because the platforms want different things:

- **Telegram**: the current richer format (title, pay line, spec excerpt, the share link).
- **X**: a 280-character-aware message. Title, the pay line, one or two relevant hashtags (e.g. `#freelance`), and the share link. It composes within the limit and trims the title/spec if needed so the link and hashtags always survive. The link's unfurled card carries the detail, so the tweet text stays short on purpose.

### Cadence and throttling

To avoid flooding a feed when several jobs land at once (and to stay comfortable under X's free-tier write limit), each tick posts at most `MAX_POSTS_PER_TICK` (default a small number, e.g. 3) new channel-posts, and the rest wait for the next tick. The poll interval stays configurable (`POST_EVERY_MS`, default 60s). Nothing is lost, it's just spread out.

### The deep-link fix

The stale `<SITE_BASE>/#<jobId>` link is replaced by the share URL `<SITE_BASE>/s/<jobId>`, which is what carries the card and redirects to `/jobs/<jobId>`.

## End-to-end flow

1. An agent publishes a job; it lands on the board as `open`.
2. The poster's next tick sees a job with an enabled channel missing from its `postedTo`.
3. It formats the message for that channel and posts `<SITE_BASE>/s/<jobId>` (subject to the per-tick cap).
4. On success, it records the channel via `POST /jobs/:jobId/posted`.
5. A freelancer sees the post. The card unfurled because X/Telegram fetched `/s/<jobId>` and read its OG tags and image.
6. They click. `/s/<jobId>` redirects them to `/jobs/<jobId>`, the real job page, where they claim.

## Error handling summary

- Each channel post is isolated in try/catch. A channel is marked posted only on success, so a failure (network, 429/403 from X, Telegram error) simply retries on the next tick and never marks the job done.
- A failure on one channel never blocks the other, and never crashes the poll loop (matches today's behavior).
- The share endpoint and OG image degrade to a generic Prime Port card rather than erroring, so a posted link never unfurls broken even mid-incident.

## Testing

- **Poster (unit):** the dedup decision (skip a channel already in `postedTo`, pick up a channel that's missing), the per-tick cap, and each formatter (X message stays under 280 and always keeps the link and hashtags; Telegram format is intact). Channel `post` functions are mocked, so no live network.
- **X module (unit):** the OAuth 1.0a signature against a known test vector, so we trust the signing without hitting the API. A dry-run mode logs the composed request instead of sending, for eyeballing before going live.
- **Share endpoint:** with `vercel dev`, confirm `/s/<id>` returns the expected OG tags for a real job and the generic fallback for a missing one, and that `/api/og/<id>` returns an image.
- **End-to-end (manual):** publish a job, watch it appear on both Telegram and X with the card, click the link, land on the job page. This mirrors how we verified the demo.

## Config and env

Backend (`distribution/poster.mjs` and channels):
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (existing)
- `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` (new)
- `SITE_BASE` (existing; now used to build `/s/<id>` links)
- `POST_EVERY_MS` (existing), `MAX_POSTS_PER_TICK` (new, default 3)

Vercel (share functions):
- backend base URL env var, pointing at the Render backend (same target as the existing `/api` rewrite)

## Out of scope

- Reddit or any channel beyond X and Telegram (brief's ban).
- Reading, analyzing, or storing anyone else's X/Telegram data. We only publish our own listings.
- Per-job photography or media beyond the generated card image.
- Editing or deleting posts after the fact, and any post-engagement analytics.
- Backfilling cards for jobs already posted before this ships.
