// Serverless function behind the /s/:id rewrite. Returns a tiny HTML page
// whose <head> carries this job's Open Graph + Twitter Card tags (so X and
// Telegram draw a rich card), and whose <body> immediately sends a human
// visitor on to the real SPA job page. Crawlers read the tags; people never
// see this page.
const BACKEND = process.env.BACKEND_BASE ?? "https://prime-port-latest.onrender.com";
const SITE = process.env.SITE_BASE ?? "https://primeportlive.vercel.app";

const esc = (s = "") =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export default async function handler(req, res) {
  const id = new URL(req.url, "http://x").searchParams.get("id") ?? "";
  let job = null;
  try {
    const jobs = await (await fetch(`${BACKEND}/jobs`)).json();
    job = jobs.find((j) => j.jobId === id && (!j.publishTask || j.publishTask.paidAt)) ?? null;
  } catch {
    job = null;
  }

  const title = job ? job.title : "A job on Prime Port";
  const hasOpeningOffer = job?.price && !(job.publishTask && Number(job.price) <= 1);
  const pay = job ? (hasOpeningOffer ? `${job.price} ${job.currency}` : "Open to offers") : "";
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
