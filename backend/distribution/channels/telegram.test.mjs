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
