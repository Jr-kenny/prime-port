import assert from "node:assert/strict";
import test from "node:test";

import { isX402Task, taskBelongsToAgent } from "./task-routing.mjs";

test("watcher only handles tasks assigned to its configured ASP", () => {
  assert.equal(taskBelongsToAgent({ myAgentId: "5982" }, "5982"), true);
  assert.equal(taskBelongsToAgent({ myAgentId: "5982" }, "5021"), false);
  assert.equal(taskBelongsToAgent({ myAgentId: "5941" }, "5982"), false);
  assert.equal(taskBelongsToAgent({ providerAgentId: "6592" }, "6592"), true);
  assert.equal(taskBelongsToAgent({ providerAgentId: "5982" }, "6592"), false);
});

test("x402 tasks never enter the escrow apply lifecycle", () => {
  assert.equal(isX402Task({ paymentMode: 3 }), true);
  assert.equal(isX402Task({ paymentMode: "x402" }), true);
  assert.equal(isX402Task({ paymentMode: 1 }), false);
});
