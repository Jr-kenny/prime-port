#!/usr/bin/env node

import { activeA2AContext } from "./core.mjs";

const INTERNAL_URL = process.env.PRIME_PORT_INTERNAL_URL ?? "http://127.0.0.1:8792";
const TOKEN = process.env.BACKEND_SERVICE_TOKEN ?? "";

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith("--")) throw new Error(`unexpected argument ${value}`);
    const name = value.slice(2);
    const next = rest[index + 1];
    if (next == null || next.startsWith("--")) {
      options[name] = true;
    } else {
      options[name] = next;
      index += 1;
    }
  }
  return { command, options };
}

const required = (options, name) => {
  const value = options[name];
  if (value == null || value === true || String(value).trim() === "") throw new Error(`--${name} is required`);
  return String(value).trim();
};

const actionFor = ({ command, options }) => {
  switch (command) {
    case "jobs":
      return { action: "jobs", args: {} };
    case "context":
      return { action: "context", args: {} };
    case "send":
      return {
        action: "send",
        args: { candidateId: required(options, "candidate"), message: required(options, "message") },
      };
    case "shortlist":
      return {
        action: "shortlist",
        args: { candidateIds: required(options, "candidates").split(",").map((value) => value.trim()).filter(Boolean) },
      };
    case "hire":
      return {
        action: "hire",
        args: {
          candidateId: required(options, "candidate"),
          price: required(options, "price"),
          deadline: Number(required(options, "deadline")),
          ...(options.criteria ? { criteria: String(options.criteria) } : {}),
        },
      };
    case "cancel-hire":
      return { action: "cancel-hire", args: {} };
    case "confirm-hire":
      return { action: "confirm-hire", args: { signature: required(options, "signature") } };
    case "review":
      return {
        action: "review",
        args: {
          submissionId: required(options, "submission"),
          decision: required(options, "decision"),
          ...(options.feedback ? { feedback: String(options.feedback) } : {}),
        },
      };
    case "approve":
      return { action: "approve", args: { ...(options.note ? { note: String(options.note) } : {}) } };
    case "dispute":
      return { action: "dispute", args: { reason: required(options, "reason") } };
    case "rate":
      return {
        action: "rate",
        args: { stars: Number(required(options, "stars")), ...(options.note ? { note: String(options.note) } : {}) },
      };
    case "confirm-rate":
      return { action: "confirm-rate", args: { signature: required(options, "signature") } };
    default:
      return null;
  }
};

function printHelp() {
  process.stdout.write(`${[
    "Prime Port buyer-conversation bridge",
    "",
    "jobs",
    "context [--job job-...]",
    "send --candidate C1 --message <text>",
    "shortlist --candidates C1,C3",
    "hire --candidate C1 --price 40 --deadline <unix-seconds> [--criteria <text>]",
    "cancel-hire",
    "confirm-hire --signature 0x...",
    "review --submission <id> --decision <accept|request_changes> [--feedback <text>]",
    "approve [--note <text>]",
    "dispute --reason <text>",
    "rate --stars <1-5> [--note <text>]",
    "confirm-rate --signature 0x...",
    "",
    "The active OKX A2A session supplies the conversation and buyer agent IDs. Use --job when one conversation contains more than one Prime Port job.",
  ].join("\n")}\n`);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const action = actionFor(parsed);
  if (!action) {
    printHelp();
    return;
  }
  if (!TOKEN) throw new Error("BACKEND_SERVICE_TOKEN is required");

  const { conversationJobId, buyerAgentId } = activeA2AContext(
    process.env,
    process.env.EXPECTED_OKX_AGENT_ID ?? "5982",
  );

  const response = await fetch(`${INTERNAL_URL}/internal/a2a/action`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-backend-service-token": TOKEN,
    },
    body: JSON.stringify({
      conversationJobId: String(conversationJobId),
      buyerAgentId: String(buyerAgentId),
      ...(parsed.options.job ? { primePortJobId: String(parsed.options.job) } : {}),
      action: action.action,
      args: action.args,
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? `Prime Port returned HTTP ${response.status}`);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = 1;
});
