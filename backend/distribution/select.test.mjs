import { test } from "node:test";
import assert from "node:assert/strict";
import { selectPosts } from "./select.mjs";

const job = (jobId, status, postedTo = {}) => ({ jobId, status, postedTo });

test("picks open jobs for channels they haven't been posted to", () => {
  const jobs = [job("j1", "open"), job("j2", "open", { telegram: 1 })];
  const picks = selectPosts(jobs, ["telegram", "x"], 10);
  assert.deepEqual(picks, [
    { jobId: "j1", channel: "telegram" },
    { jobId: "j1", channel: "x" },
    { jobId: "j2", channel: "x" },
  ]);
});

test("skips jobs that aren't open", () => {
  const jobs = [job("j1", "hired"), job("j2", "settled")];
  assert.deepEqual(selectPosts(jobs, ["telegram"], 10), []);
});

test("caps the number of picks per call", () => {
  const jobs = [job("j1", "open"), job("j2", "open"), job("j3", "open")];
  const picks = selectPosts(jobs, ["telegram"], 2);
  assert.equal(picks.length, 2);
  assert.deepEqual(picks.map((p) => p.jobId), ["j1", "j2"]);
});

test("treats a missing postedTo as nothing posted", () => {
  const jobs = [{ jobId: "j1", status: "open" }];
  assert.deepEqual(selectPosts(jobs, ["x"], 10), [{ jobId: "j1", channel: "x" }]);
});
