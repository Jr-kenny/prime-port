import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { STATE_GITATTRIBUTES, pruneRetiredMirrorState } from "./state-sync.mjs";

test("state mirror drops retired runtime dirs and keeps live data dirs", (t) => {
  const mirror = `${mkdtempSync(join(tmpdir(), "prime-port-state-sync-"))}/`;
  t.after(() => rmSync(mirror, { recursive: true, force: true }));
  mkdirSync(`${mirror}port-service-data/attachments`, { recursive: true });
  mkdirSync(`${mirror}mcp-server-data`, { recursive: true });
  mkdirSync(`${mirror}retired-runtime-data/sqlite`, { recursive: true });
  writeFileSync(`${mirror}port-service-data/attachments/photo.jpg`, "durable");
  writeFileSync(`${mirror}mcp-server-data/jobs.json`, "{}");
  writeFileSync(`${mirror}retired-runtime-data/sqlite/session.sqlite`, "stale");

  pruneRetiredMirrorState(mirror, ["port-service-data", "mcp-server-data"]);

  assert.equal(readFileSync(`${mirror}port-service-data/attachments/photo.jpg`, "utf8"), "durable");
  assert.equal(readFileSync(`${mirror}mcp-server-data/jobs.json`, "utf8"), "{}");
  assert.throws(() => readFileSync(`${mirror}retired-runtime-data/sqlite/session.sqlite`));
});

test("state mirror sends every durable database through Git LFS", () => {
  assert.match(STATE_GITATTRIBUTES, /\*\*\/\*\.sqlite/);
  assert.match(STATE_GITATTRIBUTES, /\*\*\/\*\.db3/);
});
