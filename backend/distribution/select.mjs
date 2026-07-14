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
