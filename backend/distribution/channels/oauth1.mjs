import { createHmac, randomBytes } from "node:crypto";

// RFC 3986 percent-encoding, stricter than encodeURIComponent.
const enc = (s) =>
  encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

// Build the OAuth 1.0a Authorization header for a request. For X API v2
// POST /2/tweets the JSON body is NOT part of the signature, only the
// oauth_* params are, so this signs method + url + the oauth params.
// nonce/timestamp are injectable for deterministic tests.
export function oauth1Header({ method, url, consumerKey, consumerSecret, token, tokenSecret, nonce, timestamp }) {
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp ?? Math.floor(Date.now() / 1000).toString(),
    oauth_token: token,
    oauth_version: "1.0",
  };
  const paramString = Object.keys(oauth)
    .sort()
    .map((k) => `${enc(k)}=${enc(oauth[k])}`)
    .join("&");
  const base = [method.toUpperCase(), enc(url), enc(paramString)].join("&");
  const signingKey = `${enc(consumerSecret)}&${enc(tokenSecret)}`;
  const signature = createHmac("sha1", signingKey).update(base).digest("base64");
  const all = { ...oauth, oauth_signature: signature };
  return (
    "OAuth " +
    Object.keys(all)
      .sort()
      .map((k) => `${enc(k)}="${enc(all[k])}"`)
      .join(", ")
  );
}
