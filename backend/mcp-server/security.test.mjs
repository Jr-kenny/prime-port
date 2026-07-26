import test from "node:test";
import assert from "node:assert/strict";
import { publicUpstream } from "../public-routing.mjs";

test("public proxy never exposes port control routes", () => {
  for (const [method, path] of [
    ["POST", "/ports"],
    ["GET", "/ports/job-1/conversations"],
    ["GET", "/ports/job-1/channel?peer=inbox"],
    ["POST", "/ports/job-1/messages"],
    ["POST", "/ports/job-1/scrap"],
    ["POST", "/ports/job-1/attachments"],
  ]) assert.equal(publicUpstream(path.split("?")[0], method), null, `${method} ${path}`);
});

test("public proxy permits only exact content-addressed attachment downloads", () => {
  const digest = "a".repeat(64);
  assert.equal(publicUpstream(`/attachments/job-1/${digest}`, "GET"), 8791);
  assert.equal(publicUpstream(`/attachments/job-1/${digest}`, "POST"), null);
  assert.equal(publicUpstream("/attachments/job-1/not-a-digest", "GET"), null);
});
