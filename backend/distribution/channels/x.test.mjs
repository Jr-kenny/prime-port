import { test } from "node:test";
import assert from "node:assert/strict";
import { formatX } from "./x.mjs";

test("stays within 280 characters and keeps the link", () => {
  const job = { title: "x".repeat(400), criteria: "c", price: "10", currency: "USDT" };
  const msg = formatX(job, "https://prime-port/s/j1");
  assert.ok(msg.length <= 280, `too long: ${msg.length}`);
  assert.ok(msg.includes("https://prime-port/s/j1"), "dropped the link");
});

test("shows the pay and a hashtag for a normal job", () => {
  const job = { title: "Shoot a sunset", criteria: "One photo", price: "10", currency: "USDT" };
  const msg = formatX(job, "https://x/s/j1");
  assert.match(msg, /Shoot a sunset/);
  assert.match(msg, /10 USDT/);
  assert.match(msg, /#freelance/);
});

test("says open to offers when there is no price", () => {
  const job = { title: "Shoot a sunset", criteria: "c", price: null, currency: "USDT" };
  assert.match(formatX(job, "https://x/s/j1"), /open to offers/i);
});
