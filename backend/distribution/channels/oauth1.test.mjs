import { test } from "node:test";
import assert from "node:assert/strict";
import { oauth1Header } from "./oauth1.mjs";

const creds = {
  consumerKey: "ck",
  consumerSecret: "cs",
  token: "tok",
  tokenSecret: "toksec",
};
const fixed = { nonce: "abc123", timestamp: "1700000000" };

test("builds an OAuth header with all required fields", () => {
  const h = oauth1Header({ method: "POST", url: "https://api.x.com/2/tweets", ...creds, ...fixed });
  assert.ok(h.startsWith("OAuth "));
  for (const field of [
    "oauth_consumer_key",
    "oauth_nonce",
    "oauth_signature",
    'oauth_signature_method="HMAC-SHA1"',
    "oauth_timestamp",
    "oauth_token",
    'oauth_version="1.0"',
  ]) {
    assert.ok(h.includes(field), `missing ${field}`);
  }
});

test("is deterministic for fixed nonce and timestamp", () => {
  const a = oauth1Header({ method: "POST", url: "https://api.x.com/2/tweets", ...creds, ...fixed });
  const b = oauth1Header({ method: "POST", url: "https://api.x.com/2/tweets", ...creds, ...fixed });
  assert.equal(a, b);
});

test("signature changes when the url changes", () => {
  const a = oauth1Header({ method: "POST", url: "https://api.x.com/2/tweets", ...creds, ...fixed });
  const b = oauth1Header({ method: "POST", url: "https://api.x.com/2/other", ...creds, ...fixed });
  assert.notEqual(a, b);
});
