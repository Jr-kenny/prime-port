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
