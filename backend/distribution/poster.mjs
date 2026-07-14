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
