import test from "node:test";
import assert from "node:assert/strict";
import { parseMarketplaceBrief } from "./brief-policy.mjs";

const NOW = 1_800_000_000;

test("generic sandbox instructions are not publishable briefs", () => {
  const result = parseMarketplaceBrief({
    title: "Post job for graphic designer",
    description: "Help me post a job for a graphic designer and set up the private port for managing it.",
  }, NOW);
  assert.equal(result.complete, false);
  assert.ok(result.missing.includes("deliverables"));
  assert.ok(result.missing.includes("acceptance criteria"));
  assert.ok(result.missing.includes("a future deadline"));
});

test("a complete structured brief is publishable with negotiable pricing", () => {
  const result = parseMarketplaceBrief({
    title: "Design a launch poster",
    description: [
      "Job description: Design a launch poster for a mobile finance application using the supplied brand kit.",
      "Deliverables: One editable Figma file and two PNG exports.",
      "Acceptance criteria: Uses supplied colors and contains all approved launch copy.",
      "Deadline: 2030-01-01T12:00:00Z",
    ].join("\n"),
  }, NOW);
  assert.equal(result.complete, true);
  assert.equal(result.brief.openingOffer, null);
});

test("an optional explicit opening offer is preserved", () => {
  const result = parseMarketplaceBrief({
    title: "Design a launch poster",
    description: [
      "Job description: Design a launch poster for a mobile finance application using the supplied brand kit.",
      "Deliverables: One editable Figma file and two PNG exports.",
      "Acceptance criteria: Uses supplied colors and contains all approved launch copy.",
      "Deadline: 2030-01-01T12:00:00Z",
      "Opening offer: 20",
    ].join("\n"),
  }, NOW);
  assert.equal(result.complete, true);
  assert.equal(result.brief.openingOffer, "20");
});
