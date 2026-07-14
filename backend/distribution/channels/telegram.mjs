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
