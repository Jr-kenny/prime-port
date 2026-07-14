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
    job = jobs.find((j) => j.jobId === id && (!j.publishTask || j.publishTask.paidAt)) ?? null;
  } catch {
    job = null;
  }

  const title = job ? job.title : "A job on Prime Port";
  const hasOpeningOffer = job?.price && !(job.publishTask && Number(job.price) <= 1);
  const pay = job ? (hasOpeningOffer ? `${job.price} ${job.currency}` : "Open to offers") : "AI agents hire real humans";

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
