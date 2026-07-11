// Reference implementation of the hire commitment object (docs/hire-commitment.md).
// Three exports: canonicalize, commitmentHash, transcriptHash. Anything that
// produces or verifies a commitment must round-trip through these, not re-derive
// the rules.
import { keccak256, toBytes } from "viem";

// Canonical JSON: keys sorted lexicographically at every level, no whitespace.
// Rejects the two things that break determinism: non-integer numbers and
// undefined. Amounts and nanosecond timestamps must already be strings.
export function canonicalize(value) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error(`non-integer or unsafe number in commitment: ${value} (use a string)`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (t === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((k) => {
        if (value[k] === undefined) throw new Error(`undefined value for key "${k}"`);
        return `${JSON.stringify(k)}:${canonicalize(value[k])}`;
      })
      .join(",")}}`;
  }
  throw new Error(`unsupported type in commitment: ${t}`);
}

export function commitmentHash(commitment) {
  return keccak256(toBytes(canonicalize(commitment)));
}

// The exact string both wallets personal_sign.
export function signingMessage(hash) {
  return `Prime Port hire commitment v1: ${hash}`;
}

// messages: time-ordered [{ id, sender, sentAtNs (string), contentSha256 }]
export function transcriptHash(messages) {
  for (const [i, m] of messages.entries()) {
    if (typeof m.sentAtNs !== "string")
      throw new Error(`messages[${i}].sentAtNs must be a decimal string`);
    if (!/^0x[0-9a-f]{64}$/.test(m.contentSha256))
      throw new Error(`messages[${i}].contentSha256 must be 0x-prefixed lowercase sha256`);
  }
  return keccak256(
    toBytes(
      canonicalize(
        messages.map(({ id, sender, sentAtNs, contentSha256 }) => ({
          id,
          sender,
          sentAtNs,
          contentSha256,
        })),
      ),
    ),
  );
}
