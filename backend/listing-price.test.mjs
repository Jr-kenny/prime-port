import test from "node:test";
import assert from "node:assert/strict";
import { clearLegacyPublicationPrice, openingOfferFromTaskAmount } from "./listing-price.mjs";

test("a task amount equal to the publication fee is not a freelancer budget", () => {
  assert.equal(openingOfferFromTaskAmount("1", "1"), null);
});

test("an explicit offer above the publication fee remains visible", () => {
  assert.equal(openingOfferFromTaskAmount("20", "1"), "20");
});

test("legacy marketplace listings are migrated to open offers", () => {
  const job = { price: "1", publishTask: { marketplaceJobId: "0xabc" } };
  assert.equal(clearLegacyPublicationPrice(job, "1"), true);
  assert.equal(job.price, null);
});

test("legacy migration preserves a genuine opening offer", () => {
  const job = { price: "20", publishTask: { marketplaceJobId: "0xabc" } };
  assert.equal(clearLegacyPublicationPrice(job, "1"), false);
  assert.equal(job.price, "20");
});
