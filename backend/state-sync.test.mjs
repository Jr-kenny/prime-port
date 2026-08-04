import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { STATE_GITATTRIBUTES, pruneGeneratedMirrorState } from "./state-sync.mjs";

test("state mirror drops generated A2A caches while preserving durable sessions", (t) => {
  const mirror = `${mkdtempSync(join(tmpdir(), "prime-port-state-sync-"))}/`;
  t.after(() => rmSync(mirror, { recursive: true, force: true }));
  for (const directory of [
    "okx-a2a-data/logs",
    "okx-a2a-data/run",
    "okx-a2a-data/sqlite",
    "okx-a2a-data/xmtp",
  ]) mkdirSync(`${mirror}${directory}`, { recursive: true });

  writeFileSync(`${mirror}okx-a2a-data/logs/llm.log`, "private generated log");
  writeFileSync(`${mirror}okx-a2a-data/run/daemon.lock`, "123");
  writeFileSync(`${mirror}okx-a2a-data/config.toml`, "generated=true");
  writeFileSync(`${mirror}okx-a2a-data/sqlite/session-store.sqlite`, "durable");
  writeFileSync(`${mirror}okx-a2a-data/sqlite/command-store.sqlite`, "generated");
  writeFileSync(`${mirror}okx-a2a-data/xmtp/agent-production.db3`, "generated");
  writeFileSync(`${mirror}okx-a2a-data/xmtp/sensitive-words.json`, "generated");
  writeFileSync(`${mirror}okx-a2a-data/xmtp/system-config.json`, "generated");

  pruneGeneratedMirrorState(mirror);

  assert.equal(readFileSync(`${mirror}okx-a2a-data/sqlite/session-store.sqlite`, "utf8"), "durable");
  assert.throws(() => readFileSync(`${mirror}okx-a2a-data/logs/llm.log`));
  assert.throws(() => readFileSync(`${mirror}okx-a2a-data/run/daemon.lock`));
  assert.throws(() => readFileSync(`${mirror}okx-a2a-data/config.toml`));
  assert.throws(() => readFileSync(`${mirror}okx-a2a-data/sqlite/command-store.sqlite`));
  assert.throws(() => readFileSync(`${mirror}okx-a2a-data/xmtp/agent-production.db3`));
  assert.throws(() => readFileSync(`${mirror}okx-a2a-data/xmtp/sensitive-words.json`));
  assert.throws(() => readFileSync(`${mirror}okx-a2a-data/xmtp/system-config.json`));
});

test("state mirror sends every durable database through Git LFS", () => {
  assert.match(STATE_GITATTRIBUTES, /\*\*\/\*\.sqlite/);
  assert.match(STATE_GITATTRIBUTES, /\*\*\/\*\.db3/);
});
