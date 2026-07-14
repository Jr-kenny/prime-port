# Social Auto-Posting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the social fan-out so every new job auto-posts to X and Telegram with a rich preview card that unfurls with the job's own title, price, and a branded image, and never re-posts after a redeploy.

**Architecture:** Two halves. (1) A backend poster that becomes multi-channel (one small module per channel behind a common interface), dedupes durably by recording posted state on the job in the backend's persisted store, formats per platform, and throttles per tick. (2) Two Vercel functions on the web project that turn `/s/<jobId>` into a page with per-job Open Graph tags plus an `@vercel/og` card image, so social crawlers draw the card and humans get redirected to the real job page.

**Tech Stack:** Node 22 (ESM, `node:test`, `node:crypto` for OAuth 1.0a signing, `fetch`), Vercel serverless + edge functions, `@vercel/og`, Vite SPA.

**Design doc:** `docs/superpowers/specs/2026-07-14-social-auto-posting-design.md`

---

## File Structure

**Backend (`backend/`):**
- `distribution/poster.mjs` — REWRITE. The poll loop and orchestration only. Iterates channels, uses `selectPosts` to decide, posts, records posted state. No formatting, no channel specifics, no local dedup file.
- `distribution/select.mjs` — CREATE. Pure function `selectPosts(jobs, channelNames, cap)`. No I/O, fully unit-testable.
- `distribution/channels/telegram.mjs` — CREATE. The Telegram channel module (its `enabled`, `post`, and its own message formatter).
- `distribution/channels/x.mjs` — CREATE. The X channel module (its `enabled`, `post` via `POST /2/tweets`, its own 280-char formatter).
- `distribution/channels/oauth1.mjs` — CREATE. Pure OAuth 1.0a `Authorization` header builder. No I/O.
- `distribution/select.test.mjs`, `distribution/channels/oauth1.test.mjs`, `distribution/channels/x.test.mjs`, `distribution/channels/telegram.test.mjs` — CREATE. Unit tests with `node:test`.
- `mcp-server/server.mjs` — MODIFY. Initialise `postedTo: {}` on new jobs (in `publishJob`, ~line 137) and add the `POST /jobs/:jobId/posted` REST handler (in the `rest` object, near the other `/jobs/:jobId/...` handlers ~line 495).

**Web (`web/`):**
- `api/share.js` — CREATE. Serverless function: given `?id`, returns HTML with per-job OG tags and a human redirect to `/jobs/<id>`.
- `api/og.js` — CREATE. Edge function: given `?id`, returns a branded PNG card via `@vercel/og`.
- `vercel.json` — MODIFY. Add `/s/:id` and `/og/:id` rewrites *before* the existing backend proxy and SPA fallback.
- `package.json` — MODIFY. Add `@vercel/og` dependency.

**Removed:** the `posted.json` file and all its read/write logic (was in `poster.mjs`).

---

## Task 1: Record posted state on the job (backend)

The durable dedup foundation. New jobs get a `postedTo` map; a new endpoint records a channel post; `GET /jobs` already spreads the job so `postedTo` rides along for the poster to read.

**Files:**
- Modify: `backend/mcp-server/server.mjs` (publishJob ~line 137, and the `rest` handler object ~line 495)
- Test: manual integration check (the REST handlers live in a closure and aren't unit-importable; the existing `e2e.mjs` is the integration harness pattern)

- [ ] **Step 1: Initialise `postedTo` on new jobs**

In `backend/mcp-server/server.mjs`, inside `publishJob`, the object assigned to `jobs[jobId]` (starts ~line 137). Add `postedTo: {}` right after the `claims: []` line:

```js
    claims: [],
    // Which social channels this job has been posted to, and when. Written
    // once per channel by POST /jobs/:jobId/posted so a redeploy never
    // re-posts. Lives on the job so it rides the persisted, backed-up state.
    postedTo: {},
```

- [ ] **Step 2: Add the `POST /jobs/:jobId/posted` handler**

In the `rest` object in `backend/mcp-server/server.mjs`, alongside the other `POST /jobs/:jobId/...` handlers (near line 495, after `"POST /jobs/:jobId/job-task/paid"`), add:

```js
  "POST /jobs/:jobId/posted": async (body, jobId) => {
    const job = getJob(jobId);
    const channel = z.enum(["telegram", "x"]).parse(body.channel);
    job.postedTo = { ...job.postedTo, [channel]: Date.now() };
    save();
    return { recorded: true, channel, postedTo: job.postedTo };
  },
```

(`getJob`, `z`, and `save` are already imported/defined in this file. `getJob` throws a 404-shaped error for an unknown job, which the router already turns into an error reply.)

- [ ] **Step 3: Verify by integration check**

Start the two backend services (from `backend/`):

```bash
mkdir -p data
PORT=8791 node port-service/service.mjs &
PORT=8792 node mcp-server/server.mjs &
```

Publish a job, mark it posted to telegram, and confirm it sticks:

```bash
JOB=$(curl -s -X POST localhost:8792/jobs -d '{"title":"t","criteria":"c","deadline":9999999999,"agentId":"a","agentWallet":"0x0000000000000000000000000000000000000001"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).jobId))')
curl -s -X POST "localhost:8792/jobs/$JOB/posted" -d '{"channel":"telegram"}'
echo
curl -s localhost:8792/jobs | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s).find(x=>x.jobId===process.argv[1]);console.log("postedTo:",JSON.stringify(j.postedTo))}' "$JOB"
```

Expected: the `posted` call returns `{"recorded":true,"channel":"telegram",...}` and `GET /jobs` shows `postedTo: {"telegram": <number>}`. Then stop the services (`kill %1 %2`).

- [ ] **Step 4: Commit**

```bash
git add backend/mcp-server/server.mjs
git commit -m "backend: record which social channels a job was posted to"
```

---

## Task 2: Pure post-selection logic (backend)

The brain of the dedup + throttle, isolated as a pure function so it's trivially testable.

**Files:**
- Create: `backend/distribution/select.mjs`
- Test: `backend/distribution/select.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `backend/distribution/select.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectPosts } from "./select.mjs";

const job = (jobId, status, postedTo = {}) => ({ jobId, status, postedTo });

test("picks open jobs for channels they haven't been posted to", () => {
  const jobs = [job("j1", "open"), job("j2", "open", { telegram: 1 })];
  const picks = selectPosts(jobs, ["telegram", "x"], 10);
  assert.deepEqual(picks, [
    { jobId: "j1", channel: "telegram" },
    { jobId: "j1", channel: "x" },
    { jobId: "j2", channel: "x" },
  ]);
});

test("skips jobs that aren't open", () => {
  const jobs = [job("j1", "hired"), job("j2", "settled")];
  assert.deepEqual(selectPosts(jobs, ["telegram"], 10), []);
});

test("caps the number of picks per call", () => {
  const jobs = [job("j1", "open"), job("j2", "open"), job("j3", "open")];
  const picks = selectPosts(jobs, ["telegram"], 2);
  assert.equal(picks.length, 2);
  assert.deepEqual(picks.map((p) => p.jobId), ["j1", "j2"]);
});

test("treats a missing postedTo as nothing posted", () => {
  const jobs = [{ jobId: "j1", status: "open" }];
  assert.deepEqual(selectPosts(jobs, ["x"], 10), [{ jobId: "j1", channel: "x" }]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test backend/distribution/select.test.mjs`
Expected: FAIL, cannot find module `./select.mjs`.

- [ ] **Step 3: Write the implementation**

Create `backend/distribution/select.mjs`:

```js
// Decide what to post this tick, and nothing else: no network, no clock.
// Returns { jobId, channel } pairs for open jobs that a channel hasn't
// posted to yet, in job-then-channel order, capped at `cap`.
export function selectPosts(jobs, channelNames, cap) {
  const picks = [];
  for (const job of jobs) {
    if (job.status !== "open") continue;
    for (const channel of channelNames) {
      if (job.postedTo?.[channel]) continue;
      picks.push({ jobId: job.jobId, channel });
      if (picks.length >= cap) return picks;
    }
  }
  return picks;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test backend/distribution/select.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/distribution/select.mjs backend/distribution/select.test.mjs
git commit -m "distribution: pure selectPosts for per-channel dedup and throttling"
```

---

## Task 3: OAuth 1.0a header builder (backend)

X posting needs a signed `Authorization` header. Isolated, pure, dependency-free.

**Files:**
- Create: `backend/distribution/channels/oauth1.mjs`
- Test: `backend/distribution/channels/oauth1.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `backend/distribution/channels/oauth1.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { oauth1Header } from "./oauth1.mjs";

const creds = {
  consumerKey: "ck",
  consumerSecret: "cs",
  token: "tok",
  tokenSecret: "toksec",
};
const fixed = { nonce: "abc123", timestamp: "1700000000" };

test("builds an OAuth header with all required fields", () => {
  const h = oauth1Header({ method: "POST", url: "https://api.x.com/2/tweets", ...creds, ...fixed });
  assert.ok(h.startsWith("OAuth "));
  for (const field of [
    "oauth_consumer_key",
    "oauth_nonce",
    "oauth_signature",
    'oauth_signature_method="HMAC-SHA1"',
    "oauth_timestamp",
    "oauth_token",
    'oauth_version="1.0"',
  ]) {
    assert.ok(h.includes(field), `missing ${field}`);
  }
});

test("is deterministic for fixed nonce and timestamp", () => {
  const a = oauth1Header({ method: "POST", url: "https://api.x.com/2/tweets", ...creds, ...fixed });
  const b = oauth1Header({ method: "POST", url: "https://api.x.com/2/tweets", ...creds, ...fixed });
  assert.equal(a, b);
});

test("signature changes when the url changes", () => {
  const a = oauth1Header({ method: "POST", url: "https://api.x.com/2/tweets", ...creds, ...fixed });
  const b = oauth1Header({ method: "POST", url: "https://api.x.com/2/other", ...creds, ...fixed });
  assert.notEqual(a, b);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test backend/distribution/channels/oauth1.test.mjs`
Expected: FAIL, cannot find module `./oauth1.mjs`.

- [ ] **Step 3: Write the implementation**

Create `backend/distribution/channels/oauth1.mjs`:

```js
import { createHmac, randomBytes } from "node:crypto";

// RFC 3986 percent-encoding, stricter than encodeURIComponent.
const enc = (s) =>
  encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

// Build the OAuth 1.0a Authorization header for a request. For X API v2
// POST /2/tweets the JSON body is NOT part of the signature, only the
// oauth_* params are, so this signs method + url + the oauth params.
// nonce/timestamp are injectable for deterministic tests.
export function oauth1Header({ method, url, consumerKey, consumerSecret, token, tokenSecret, nonce, timestamp }) {
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp ?? Math.floor(Date.now() / 1000).toString(),
    oauth_token: token,
    oauth_version: "1.0",
  };
  const paramString = Object.keys(oauth)
    .sort()
    .map((k) => `${enc(k)}=${enc(oauth[k])}`)
    .join("&");
  const base = [method.toUpperCase(), enc(url), enc(paramString)].join("&");
  const signingKey = `${enc(consumerSecret)}&${enc(tokenSecret)}`;
  const signature = createHmac("sha1", signingKey).update(base).digest("base64");
  const all = { ...oauth, oauth_signature: signature };
  return (
    "OAuth " +
    Object.keys(all)
      .sort()
      .map((k) => `${enc(k)}="${enc(all[k])}"`)
      .join(", ")
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test backend/distribution/channels/oauth1.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/distribution/channels/oauth1.mjs backend/distribution/channels/oauth1.test.mjs
git commit -m "distribution: dependency-free OAuth 1.0a header builder for X"
```

---

## Task 4: Telegram channel module (backend)

Move today's Telegram posting into a channel module with its own formatter.

**Files:**
- Create: `backend/distribution/channels/telegram.mjs`
- Test: `backend/distribution/channels/telegram.test.mjs`

- [ ] **Step 1: Write the failing test (formatter only; `post` hits the network so it's not unit-tested)**

Create `backend/distribution/channels/telegram.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTelegram } from "./telegram.mjs";

test("includes title, pay, and the share url", () => {
  const job = { title: "Shoot a sunset", criteria: "One photo", price: "10", currency: "USDT", deadline: 1700000000 };
  const msg = formatTelegram(job, "https://prime-port/s/j1");
  assert.match(msg, /Shoot a sunset/);
  assert.match(msg, /Pays 10 USDT/);
  assert.match(msg, /https:\/\/prime-port\/s\/j1/);
});

test("says open to offers when there is no price", () => {
  const job = { title: "Shoot a sunset", criteria: "One photo", price: null, currency: "USDT", deadline: 1700000000 };
  assert.match(formatTelegram(job, "https://x/s/j1"), /Open to offers/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test backend/distribution/channels/telegram.test.mjs`
Expected: FAIL, cannot find module `./telegram.mjs`.

- [ ] **Step 3: Write the implementation**

Create `backend/distribution/channels/telegram.mjs`:

```js
// Telegram channel: the free bot API, richer multi-line format. Dormant
// unless both creds are present.
const TG_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = () => process.env.TELEGRAM_CHAT_ID;

export function formatTelegram(job, shareUrl) {
  return [
    `New job: ${job.title}`,
    `${job.price ? `Pays ${job.price} ${job.currency}` : "Open to offers"}, deadline ${new Date(job.deadline * 1000).toUTCString()}.`,
    job.criteria && job.criteria !== job.title ? `Spec: ${job.criteria.slice(0, 300)}` : null,
    `Claim it: ${shareUrl}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export const telegram = {
  name: "telegram",
  enabled: () => Boolean(TG_TOKEN() && TG_CHAT()),
  post: async (job, shareUrl) => {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN()}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT(), text: formatTelegram(job, shareUrl), disable_web_page_preview: false }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(`telegram: ${j.description ?? r.status}`);
  },
};
```

(Note: `disable_web_page_preview` is now `false` so Telegram unfurls the rich card from `/s/<id>`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test backend/distribution/channels/telegram.test.mjs`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/distribution/channels/telegram.mjs backend/distribution/channels/telegram.test.mjs
git commit -m "distribution: telegram channel module with its own formatter"
```

---

## Task 5: X channel module (backend)

Post to X via `POST /2/tweets`, OAuth 1.0a signed, with a 280-char formatter.

**Files:**
- Create: `backend/distribution/channels/x.mjs`
- Test: `backend/distribution/channels/x.test.mjs`

- [ ] **Step 1: Write the failing test (formatter only)**

Create `backend/distribution/channels/x.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatX } from "./x.mjs";

test("stays within 280 characters and keeps the link", () => {
  const job = { title: "x".repeat(400), criteria: "c", price: "10", currency: "USDT" };
  const msg = formatX(job, "https://prime-port/s/j1");
  assert.ok(msg.length <= 280, `too long: ${msg.length}`);
  assert.ok(msg.includes("https://prime-port/s/j1"), "dropped the link");
});

test("shows the pay and a hashtag for a normal job", () => {
  const job = { title: "Shoot a sunset", criteria: "One photo", price: "10", currency: "USDT" };
  const msg = formatX(job, "https://x/s/j1");
  assert.match(msg, /Shoot a sunset/);
  assert.match(msg, /10 USDT/);
  assert.match(msg, /#freelance/);
});

test("says open to offers when there is no price", () => {
  const job = { title: "Shoot a sunset", criteria: "c", price: null, currency: "USDT" };
  assert.match(formatX(job, "https://x/s/j1"), /open to offers/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test backend/distribution/channels/x.test.mjs`
Expected: FAIL, cannot find module `./x.mjs`.

- [ ] **Step 3: Write the implementation**

Create `backend/distribution/channels/x.mjs`:

```js
import { oauth1Header } from "./oauth1.mjs";

const KEY = () => process.env.X_API_KEY;
const SECRET = () => process.env.X_API_SECRET;
const TOKEN = () => process.env.X_ACCESS_TOKEN;
const TOKEN_SECRET = () => process.env.X_ACCESS_TOKEN_SECRET;
const TWEET_URL = "https://api.x.com/2/tweets";

// Compose a tweet that always fits 280 chars: the link and hashtag are
// fixed-cost and survive; the title is trimmed if the whole thing is too
// long. X counts every url as 23 chars (t.co), so budget for that.
export function formatX(job, shareUrl) {
  const pay = job.price ? `${job.price} ${job.currency}` : "open to offers";
  const tag = "#freelance";
  const urlCost = 23; // t.co-wrapped length
  const tail = `\n${pay} · ${tag}\n`; // between title and url
  const budget = 280 - urlCost - tail.length;
  let title = job.title;
  if (title.length > budget) title = title.slice(0, Math.max(0, budget - 1)).trimEnd() + "…";
  return `${title}${tail}${shareUrl}`;
}

export const x = {
  name: "x",
  enabled: () => Boolean(KEY() && SECRET() && TOKEN() && TOKEN_SECRET()),
  post: async (job, shareUrl) => {
    const header = oauth1Header({
      method: "POST",
      url: TWEET_URL,
      consumerKey: KEY(),
      consumerSecret: SECRET(),
      token: TOKEN(),
      tokenSecret: TOKEN_SECRET(),
    });
    const r = await fetch(TWEET_URL, {
      method: "POST",
      headers: { authorization: header, "content-type": "application/json" },
      body: JSON.stringify({ text: formatX(job, shareUrl) }),
    });
    if (!r.ok) {
      const detail = await r.text();
      throw new Error(`x: ${r.status} ${detail.slice(0, 200)}`);
    }
  },
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test backend/distribution/channels/x.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 5: Live smoke test (manual, once, before wiring the loop)**

With the four `X_*` env vars set in your shell, post one real tweet to confirm the signing and permissions work end to end:

```bash
node -e '
import("./backend/distribution/channels/x.mjs").then(async ({ x }) => {
  await x.post({ title: "Prime Port test post, please ignore", price: null, currency: "USDT", criteria: "test" }, "https://primeportlive.vercel.app");
  console.log("posted ok");
}).catch((e) => { console.error(e.message); process.exit(1); });
'
```

Expected: `posted ok`, and the tweet appears on the Prime Port account. If you get `x: 403`, the access tokens are read-only, regenerate them as Read and Write. Delete the test tweet afterward.

- [ ] **Step 6: Commit**

```bash
git add backend/distribution/channels/x.mjs backend/distribution/channels/x.test.mjs
git commit -m "distribution: X channel module posting via /2/tweets"
```

---

## Task 6: Rewrite the poster as a multi-channel loop (backend)

Replace the Telegram-only poller with orchestration over the channel modules, durable dedup via the backend, and throttling. Deletes the old `posted.json` logic.

**Files:**
- Rewrite: `backend/distribution/poster.mjs`

- [ ] **Step 1: Rewrite the file**

Replace the entire contents of `backend/distribution/poster.mjs` with:

```js
// Distribution: every open job gets advertised to every social channel once,
// no hands. Polls the jobs surface, and for each open job that a channel
// hasn't posted to yet, formats and posts the share link, then records the
// post on the job so a redeploy never re-spams. Runs inside the merged
// backend process (index.mjs imports it). Each channel switches itself off
// when its creds are missing, so partial credentials and local runs behave.
import { selectPosts } from "./select.mjs";
import { telegram } from "./channels/telegram.mjs";
import { x } from "./channels/x.mjs";

const channels = [telegram, x];

const JOBS_URL = process.env.JOBS_URL ?? "http://127.0.0.1:8792";
const SITE_BASE = process.env.SITE_BASE ?? ""; // the Vercel web app, e.g. https://primeportlive.vercel.app
const POST_EVERY_MS = Number(process.env.POST_EVERY_MS ?? 60_000);
const MAX_POSTS_PER_TICK = Number(process.env.MAX_POSTS_PER_TICK ?? 3);

const getJobs = async () => (await fetch(`${JOBS_URL}/jobs`)).json();

const markPosted = async (jobId, channel) => {
  const r = await fetch(`${JOBS_URL}/jobs/${jobId}/posted`, {
    method: "POST",
    body: JSON.stringify({ channel }),
  });
  if (!r.ok) throw new Error(`markPosted ${jobId}/${channel}: ${r.status}`);
};

async function tick() {
  try {
    const jobs = await getJobs();
    const enabled = channels.filter((c) => c.enabled());
    if (enabled.length === 0) return;
    const picks = selectPosts(jobs, enabled.map((c) => c.name), MAX_POSTS_PER_TICK);
    for (const { jobId, channel } of picks) {
      const job = jobs.find((j) => j.jobId === jobId);
      const ch = enabled.find((c) => c.name === channel);
      const shareUrl = `${SITE_BASE}/s/${jobId}`;
      try {
        await ch.post(job, shareUrl);
        await markPosted(jobId, channel);
        console.log(`[distribution] posted ${jobId} to ${channel}`);
      } catch (e) {
        console.error(`[distribution] ${channel} post for ${jobId} failed: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`[distribution] tick failed: ${e.message}`);
  }
}

const enabledNow = channels.filter((c) => c.enabled()).map((c) => c.name);
if (enabledNow.length > 0) {
  setInterval(tick, POST_EVERY_MS);
  tick();
  console.log(`[distribution] posting new jobs to [${enabledNow.join(", ")}] every ${POST_EVERY_MS / 1000}s (max ${MAX_POSTS_PER_TICK}/tick)`);
} else {
  console.log("[distribution] no channel credentials set, fan-out off");
}
```

- [ ] **Step 2: Remove the stale posted.json data file**

The new poster keeps no local dedup file. Remove the leftover if present:

```bash
rm -f backend/distribution/data/posted.json
```

- [ ] **Step 3: Verify the module loads and stays off without creds**

Run (no social env vars set):

```bash
node -e 'import("./backend/distribution/poster.mjs").then(() => console.log("loaded"))'
```

Expected: prints `[distribution] no channel credentials set, fan-out off` then `loaded`, and exits without error.

- [ ] **Step 4: Commit**

```bash
git add backend/distribution/poster.mjs
git commit -m "distribution: multi-channel poster with durable dedup and throttling"
```

---

## Task 7: Full backend suite green

Confirm nothing regressed across the backend before touching the web.

**Files:** none (verification only)

- [ ] **Step 1: Run every new unit test**

Run: `node --test backend/distribution/`
Expected: PASS, all suites (select, oauth1, telegram, x).

- [ ] **Step 2: Run the lifecycle e2e (needs the two services up)**

```bash
cd backend
mkdir -p data
PORT=8791 node port-service/service.mjs &
PORT=8792 node mcp-server/server.mjs &
sleep 3
node mcp-server/e2e.mjs
kill %1 %2
cd ..
```

Expected: `E2E PASSED` (the `postedTo` addition to the job shape must not break it).

- [ ] **Step 3: Commit (only if any fixups were needed; otherwise skip)**

```bash
git commit -am "distribution: fixups from full-suite run" || true
```

---

## Task 8: Share endpoint on Vercel — OG tags + human redirect

`/s/<id>` returns per-job Open Graph tags for crawlers and redirects people to the job.

**Files:**
- Create: `web/api/share.js`
- Modify: `web/vercel.json`

- [ ] **Step 1: Write the share function**

Create `web/api/share.js`:

```js
// Serverless function behind the /s/:id rewrite. Returns a tiny HTML page
// whose <head> carries this job's Open Graph + Twitter Card tags (so X and
// Telegram draw a rich card), and whose <body> immediately sends a human
// visitor on to the real SPA job page. Crawlers read the tags; people never
// see this page.
const BACKEND = process.env.BACKEND_BASE ?? "https://prime-port-latest.onrender.com";
const SITE = process.env.SITE_BASE ?? "https://primeportlive.vercel.app";

const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export default async function handler(req, res) {
  const id = new URL(req.url, "http://x").searchParams.get("id") ?? "";
  let job = null;
  try {
    const jobs = await (await fetch(`${BACKEND}/jobs`)).json();
    job = jobs.find((j) => j.jobId === id) ?? null;
  } catch {
    job = null;
  }

  const title = job ? job.title : "A job on Prime Port";
  const pay = job ? (job.price ? `${job.price} ${job.currency}` : "Open to offers") : "";
  const spec = job ? (job.criteria || "").slice(0, 160) : "AI agents hire real humans. Claim jobs on Prime Port.";
  const desc = [pay, spec].filter(Boolean).join(" · ");
  const image = `${SITE}/og/${encodeURIComponent(id)}`;
  const dest = job ? `${SITE}/jobs/${encodeURIComponent(id)}` : `${SITE}/jobs`;

  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "public, max-age=300, s-maxage=600");
  res.status(200).send(`<!doctype html><html><head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:url" content="${esc(dest)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(image)}">
<meta http-equiv="refresh" content="0; url=${esc(dest)}">
</head><body><script>location.replace(${JSON.stringify(dest)})</script>
<a href="${esc(dest)}">View this job on Prime Port</a></body></html>`);
}
```

- [ ] **Step 2: Add the rewrites**

Edit `web/vercel.json`. The `rewrites` array must have the two new entries FIRST (order matters, first match wins, and they must precede the SPA fallback). Replace the `rewrites` array with:

```json
  "rewrites": [
    { "source": "/s/:id", "destination": "/api/share?id=:id" },
    { "source": "/og/:id", "destination": "/api/og?id=:id" },
    {
      "source": "/api/:path*",
      "destination": "https://prime-port-latest.onrender.com/:path*"
    },
    {
      "source": "/((?!api/).*)",
      "destination": "/index.html"
    }
  ]
```

(Leave `buildCommand`, `outputDirectory`, and `build.env` unchanged. The `/s` and `/og` rewrites resolve to the functions and are not re-run through the `/api` proxy, so the backend proxy stays untouched.)

- [ ] **Step 3: Verify locally with vercel dev**

```bash
cd web
npx vercel dev --listen 5273
```

In another shell, publish a job on the live backend or a local one, then:

```bash
curl -s "http://localhost:5273/s/<a-real-open-jobId>" | grep -E "og:title|og:image|refresh"
```

Expected: the HTML contains `og:title` with the job title, `og:image` pointing at `/og/<id>`, and a `refresh` meta to `/jobs/<id>`. A missing id shows the generic "A job on Prime Port" title (no error). Stop `vercel dev` when done.

- [ ] **Step 4: Commit**

```bash
git add web/api/share.js web/vercel.json
git commit -m "web: /s/:id share endpoint with per-job Open Graph tags"
```

---

## Task 9: Generated card image on Vercel (@vercel/og)

`/og/<id>` renders the branded PNG card the share tags point at.

**Files:**
- Create: `web/api/og.js`
- Modify: `web/package.json`

- [ ] **Step 1: Add the dependency**

```bash
cd web
npm install @vercel/og
cd ..
```

Expected: `@vercel/og` appears in `web/package.json` dependencies.

- [ ] **Step 2: Write the edge function**

Create `web/api/og.js`:

```js
// Edge function behind the /og/:id rewrite. Renders the branded card image
// the share tags point at: Prime Port styling, the job title, and the pay
// line. Falls back to a generic card if the job can't be loaded, so a link
// never unfurls with a broken image.
import { ImageResponse } from "@vercel/og";

export const config = { runtime: "edge" };

const BACKEND = "https://prime-port-latest.onrender.com";

export default async function handler(req) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  let job = null;
  try {
    const jobs = await (await fetch(`${BACKEND}/jobs`)).json();
    job = jobs.find((j) => j.jobId === id) ?? null;
  } catch {
    job = null;
  }

  const title = job ? job.title : "A job on Prime Port";
  const pay = job ? (job.price ? `${job.price} ${job.currency}` : "Open to offers") : "AI agents hire real humans";

  return new ImageResponse(
    {
      type: "div",
      props: {
        style: {
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#0b0b12",
          color: "#f5f5f7",
          padding: "64px",
          fontFamily: "sans-serif",
        },
        children: [
          { type: "div", props: { style: { fontSize: 30, letterSpacing: 8, color: "#8b8bff" }, children: "PRIME PORT" } },
          { type: "div", props: { style: { fontSize: 68, fontWeight: 700, lineHeight: 1.1 }, children: title } },
          { type: "div", props: { style: { display: "flex", fontSize: 40, color: "#c7c7d1" }, children: pay } },
        ],
      },
    },
    { width: 1200, height: 630 }
  );
}
```

- [ ] **Step 3: Verify locally with vercel dev**

```bash
cd web
npx vercel dev --listen 5273
```

Then:

```bash
curl -s -o /tmp/card.png -w "%{content_type}\n" "http://localhost:5273/og/<a-real-open-jobId>"
```

Expected: content type `image/png` and `/tmp/card.png` opens as a 1200x630 card showing "PRIME PORT", the job title, and the pay line. Stop `vercel dev`.

- [ ] **Step 4: Commit**

```bash
git add web/api/og.js web/package.json web/package-lock.json
git commit -m "web: /og/:id generated card image via @vercel/og"
```

---

## Task 10: Deploy and verify the real unfurl

Ship both halves and confirm the card shows in a real feed.

**Files:** none (deploy + verification)

- [ ] **Step 1: Confirm backend env on Render**

In the Render backend env, confirm these are set: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`, `SITE_BASE=https://primeportlive.vercel.app`. Redeploy the Render backend to pick up the new code (push to main triggers the image build; redeploy after it finishes).

- [ ] **Step 2: Deploy the web**

```bash
cd web && vercel --prod --yes && cd ..
```

Expected: a Ready production deployment. (Vercel isn't git-linked; deploy is manual, per `web-hosting-vercel-manual`.)

- [ ] **Step 3: Verify the live share endpoint and image**

```bash
curl -s "https://primeportlive.vercel.app/s/<a-real-open-jobId>" | grep -E "og:title|og:image"
curl -s -o /dev/null -w "%{content_type}\n" "https://primeportlive.vercel.app/og/<a-real-open-jobId>"
```

Expected: OG tags with the real title, and `image/png` for the card.

- [ ] **Step 4: Verify the real unfurl**

Publish a fresh job (via the demo driver or the marketplace). Within a poll interval it should appear on both the Telegram channel and the X account, each with the rich card. Paste the `/s/<id>` link into the X composer or a Telegram chat to confirm the card unfurls with the job title, pay, and generated image, and that clicking it lands on `/jobs/<id>`.

- [ ] **Step 5: Update the README status line**

In `README.md`, the "What's live" table currently reads distribution as Telegram-only / X-to-follow in the repo map. Update the repo-map line for `distribution/` from "job fan-out to Telegram (X to follow)" to "job fan-out to X and Telegram with rich preview cards", and commit:

```bash
git add README.md
git commit -m "docs: distribution now fans out to X and Telegram"
```

---

## Notes for the implementer

- **Test runner:** `node --test <path>` (Node 22 built-in). No test framework dependency is added.
- **Why formatters are unit-tested but `post` isn't:** `post` makes a live network call. The pure formatters and `selectPosts` carry the logic worth testing; the network calls are proven by the manual smoke test (Task 5 Step 5) and the real unfurl (Task 10 Step 4).
- **Vercel routing gotcha:** the `/s` and `/og` rewrites must stay ordered before the `/api` proxy and SPA fallback. If `/s/<id>` ever returns the SPA shell instead of OG tags, the rewrite order regressed.
- **X rate/permission failures:** a `403` from X almost always means read-only access tokens, regenerate them as Read and Write. A `429` is the free-tier rate limit; the poster just retries next tick (it only marks posted on success).
- **Secrets:** all credentials live in env only (Render for the backend, Vercel env for `BACKEND_BASE`/`SITE_BASE` if you override the defaults). Never commit them.
```
