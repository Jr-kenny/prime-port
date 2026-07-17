// A marketplace designation buys the fixed-price publication service. Its
// token amount is only a freelancer budget when it is greater than that flat
// fee; otherwise the listing is intentionally open to offers.
export function openingOfferFromTaskAmount(taskAmount, publishFee) {
  const amount = Number(taskAmount);
  const fee = Number(publishFee);
  if (!Number.isFinite(amount) || !Number.isFinite(fee) || amount <= fee) return null;
  return String(taskAmount);
}

// Older watcher versions stored the publication fee as the job price. Repair
// those records when the backend loads so existing listings render correctly.
export function clearLegacyPublicationPrice(job, publishFee) {
  if (!job?.publishTask || job.price == null) return false;
  if (openingOfferFromTaskAmount(job.price, publishFee) !== null) return false;
  job.price = null;
  return true;
}
