// Distribution: every job that lands on the board gets advertised, no hands.
// Polls the jobs surface and posts each new open job once to Telegram
// (free bot API). The socials are adverts only — claiming happens on our
// site, so the message is title, price, deadline, link.
//
// Runs inside the merged backend process (index.mjs imports it). Switches
// itself off with a log line when TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are
// missing, so local runs and pre-credential deploys behave.
// X/Twitter fan-out slots in here later; its API needs an approved developer
// account, which is a signup errand, not code.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const JOBS_URL = process.env.JOBS_URL ?? "http://127.0.0.1:8792";
const SITE_BASE = process.env.SITE_BASE ?? ""; // the Vercel web app, e.g. https://prime-port.vercel.app
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID; // channel/group id or @channelname
const POST_EVERY_MS = Number(process.env.POST_EVERY_MS ?? 60_000);

const DATA = new URL("./data/", import.meta.url).pathname;
mkdirSync(DATA, { recursive: true });
const postedPath = `${DATA}posted.json`;
const posted = existsSync(postedPath) ? JSON.parse(readFileSync(postedPath, "utf8")) : {};
const savePosted = () => writeFileSync(postedPath, JSON.stringify(posted, null, 2));

const jobMessage = (job) =>
  [
    `New job: ${job.title}`,
    `${job.price ? `Pays ${job.price} ${job.currency}` : "Open to offers"}, deadline ${new Date(job.deadline * 1000).toUTCString()}.`,
    job.criteria && job.criteria !== job.title ? `Spec: ${job.criteria.slice(0, 300)}` : null,
    SITE_BASE ? `Claim it: ${SITE_BASE}/#${job.jobId}` : `Job id: ${job.jobId}`,
  ]
    .filter(Boolean)
    .join("\n");

async function telegram(text) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`telegram: ${j.description ?? r.status}`);
}

async function tick() {
  try {
    const jobs = await (await fetch(`${JOBS_URL}/jobs`)).json();
    for (const job of jobs) {
      if (job.status !== "open" || posted[job.jobId]) continue;
      await telegram(jobMessage(job));
      posted[job.jobId] = Date.now();
      savePosted();
      console.log(`[distribution] posted ${job.jobId} to telegram`);
    }
  } catch (e) {
    console.error(`[distribution] tick failed: ${e.message}`);
  }
}

if (TG_TOKEN && TG_CHAT) {
  setInterval(tick, POST_EVERY_MS);
  tick();
  console.log(`[distribution] posting new jobs to telegram chat ${TG_CHAT} every ${POST_EVERY_MS / 1000}s`);
} else {
  console.log("[distribution] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set, fan-out off");
}
