import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildA2ASendArgs } from "./core.mjs";

const run = promisify(execFile);
const INTERNAL_URL = process.env.PRIME_PORT_INTERNAL_URL ?? "http://127.0.0.1:8792";
const TOKEN = process.env.BACKEND_SERVICE_TOKEN ?? "";
const POLL_MS = Number(process.env.A2A_BRIDGE_POLL_MS ?? 10_000);
let stopping = false;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function backend(path, body) {
  const response = await fetch(`${INTERNAL_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-backend-service-token": TOKEN,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? `Prime Port returned HTTP ${response.status}`);
  return payload;
}

function parseJsonOutput(stdout) {
  const line = String(stdout)
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value.startsWith("{"))
    .at(-1);
  if (!line) throw new Error("okx-a2a returned no JSON result");
  const result = JSON.parse(line);
  if (!result.ok) throw new Error(result.error ?? "okx-a2a send failed");
  return result;
}

async function resolveConversation(item) {
  if (item.a2aJobId) return { jobId: item.a2aJobId, sessionKey: null };
  const localAgentId = String(process.env.EXPECTED_OKX_AGENT_ID ?? "5982");
  const { stdout } = await run("okx-a2a", [
    "session", "query",
    "--my-agent-id", localAgentId,
    "--to-agent-id", item.buyerAgentId,
    "--limit", "20",
    "--json",
  ], { timeout: 30_000, env: process.env });
  const result = parseJsonOutput(stdout);
  const sessions = (result.sessions ?? [])
    .filter((session) => session.jobId && session.sessionKey)
    .sort((left, right) => Date.parse(right.updatedAt ?? right.createdAt ?? 0) - Date.parse(left.updatedAt ?? left.createdAt ?? 0));
  if (sessions.length === 0) {
    throw new Error(`no existing OKX conversation with buyer agent #${item.buyerAgentId}`);
  }
  return { jobId: String(sessions[0].jobId), sessionKey: String(sessions[0].sessionKey) };
}

async function deliver(item) {
  try {
    const conversation = await resolveConversation(item);
    const localAgentId = String(process.env.EXPECTED_OKX_AGENT_ID ?? "5982");
    const { stdout } = await run("okx-a2a", buildA2ASendArgs({
      conversation,
      buyerAgentId: item.buyerAgentId,
      localAgentId,
      message: item.message,
    }), { timeout: 120_000, env: process.env });
    const result = parseJsonOutput(stdout);
    await backend("/internal/a2a/outbox/ack", {
      eventId: item.eventId,
      leaseToken: item.leaseToken,
      success: true,
      messageId: result.messageId ?? null,
      resolvedA2AJobId: conversation.jobId,
    });
    console.log(`[a2a-bridge] delivered ${item.eventId} to agent #${item.buyerAgentId}`);
  } catch (error) {
    try {
      await backend("/internal/a2a/outbox/ack", {
        eventId: item.eventId,
        leaseToken: item.leaseToken,
        success: false,
        error: String(error?.stderr || error?.message || error).slice(0, 2_000),
      });
    } catch (ackError) {
      console.error(`[a2a-bridge] failed to record delivery error for ${item.eventId}: ${ackError.message}`);
    }
    console.error(`[a2a-bridge] delivery failed for ${item.eventId}: ${error.message}`);
  }
}

async function main() {
  if (!TOKEN) throw new Error("BACKEND_SERVICE_TOKEN is required");
  console.log("[a2a-bridge] buyer conversation relay started");
  while (!stopping) {
    try {
      const { items } = await backend("/internal/a2a/outbox/lease", { limit: 1 });
      for (const item of items) {
        if (stopping) break;
        await deliver(item);
      }
    } catch (error) {
      console.error(`[a2a-bridge] poll failed: ${error.message}`);
    }
    if (!stopping) await delay(POLL_MS);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { stopping = true; });
}

main().catch((error) => {
  console.error(`[a2a-bridge] stopped: ${error.message}`);
  process.exitCode = 1;
});
