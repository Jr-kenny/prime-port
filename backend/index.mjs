// Single-process entry for the Prime Port backend: port-service and
// mcp-server in one runtime behind one public port. Free hosts hand out one
// service slot with one exposed port (Hugging Face Spaces: app_port, default
// 7860), so a thin proxy on that port routes by path prefix to the two
// servers, which keep their internal defaults on localhost.
//
// The marketplace watcher rides along too: the onchainos CLI has Linux
// builds and supports non-interactive API-key login (OKX_API_KEY /
// OKX_SECRET_KEY / OKX_PASSPHRASE), so the container logs into the OKX
// wallet at boot and polls the marketplace itself. Without those env vars
// the watcher stays off and everything else runs normally.
import { createServer, request } from "node:http";
import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { restoreState, startBackupLoop } from "./state-sync.mjs";

// The public port: APP_PORT if set, else the host-assigned PORT (Render
// injects one and routes traffic to it), else 7860 (Hugging Face style).
const APP_PORT = Number(process.env.APP_PORT ?? process.env.PORT ?? 7860);
const isEnabled = (value) => ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
const runtimeStatus = {
  marketplaceWatcher: "disabled",
  a2aResponder: "disabled",
};
let hermesInferenceVerified = false;

const bytesToMiB = (bytes) => bytes == null ? null : Math.round((bytes / 1024 / 1024) * 10) / 10;
const readCgroupBytes = (path) => {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value === "max" ? null : Number(value);
  } catch {
    return null;
  }
};
const memoryStatus = () => {
  const usage = process.memoryUsage();
  return {
    processRssMiB: bytesToMiB(usage.rss),
    processHeapUsedMiB: bytesToMiB(usage.heapUsed),
    containerUsedMiB: bytesToMiB(readCgroupBytes("/sys/fs/cgroup/memory.current")),
    containerLimitMiB: bytesToMiB(readCgroupBytes("/sys/fs/cgroup/memory.max")),
  };
};
const serviceReady = () =>
  (!isEnabled(process.env.ENABLE_MARKETPLACE_WATCHER) || runtimeStatus.marketplaceWatcher === "running")
  && (!isEnabled(process.env.ENABLE_A2A_RESPONDER) || runtimeStatus.a2aResponder === "running");

const ONCHAINOS_SESSION_FILES = ["keyring.enc", "machine-identity", "session.json", "wallets.json"];
const onchainosHome = `${process.env.HOME ?? "/app"}/.onchainos`;

// Render secret files are text-only, so the encrypted OnchainOS email-login
// bundle is uploaded as base64. Restore it only when state-sync did not
// already restore a newer refreshed session.
function restoreOnchainosSessionSecrets() {
  if (ONCHAINOS_SESSION_FILES.every((name) => existsSync(`${onchainosHome}/${name}`))) return true;
  const secretDir = process.env.RENDER_SECRET_DIR ?? "/etc/secrets";
  const sources = ONCHAINOS_SESSION_FILES.map((name) => `${secretDir}/onchainos-${name}.b64`);
  if (!sources.some(existsSync)) return false;
  if (!sources.every(existsSync)) throw new Error("incomplete encrypted OnchainOS session secret bundle");
  mkdirSync(onchainosHome, { recursive: true });
  ONCHAINOS_SESSION_FILES.forEach((name, index) => {
    const encoded = readFileSync(sources[index], "utf8").trim();
    writeFileSync(`${onchainosHome}/${name}`, Buffer.from(encoded, "base64"), { mode: 0o600 });
  });
  console.log("[prime-port] restored encrypted OnchainOS email session from Render secrets");
  return true;
}

const hasOnchainosEmailSession = restoreOnchainosSessionSecrets();

// Each service reads process.env.PORT with its own fallback (8791 / 8792).
// Clearing PORT before import lets both fall back and the proxy own APP_PORT.
delete process.env.PORT;

await restoreState();
await import("./port-service/service.mjs");
await import("./mcp-server/server.mjs");
await import("./distribution/poster.mjs");
await import("./payout/register-at-hire.mjs");
startBackupLoop();

// Path prefix -> internal port. Everything the web app and agents touch:
// /mcp + /jobs + /freelancers live on mcp-server, /ports + /attachments on
// port-service. Unknown paths 404 here rather than leak internals.
const upstream = (path) => {
  if (path === "/mcp" || path === "/mcp/publish" || path.startsWith("/jobs") || path.startsWith("/freelancers")) return 8792;
  if (path.startsWith("/ports") || path.startsWith("/attachments")) return 8791;
  return null;
};

createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/" || path === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: serviceReady(), service: "prime-port", components: runtimeStatus, memory: memoryStatus() }));
  }
  const port = upstream(path);
  if (!port) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: `no surface at ${path}` }));
  }
  const up = request(
    { host: "127.0.0.1", port, path: req.url, method: req.method, headers: req.headers },
    (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    },
  );
  up.on("error", (e) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `upstream :${port}: ${e.message}` }));
  });
  req.pipe(up);
}).listen(APP_PORT, () => console.log(`[prime-port] public surface on :${APP_PORT}`));

let okxLoginPromise;
function ensureOkxLogin() {
  if (!okxLoginPromise) {
    const command = hasOnchainosEmailSession
      ? promisify(execFile)("onchainos", ["wallet", "status"], { timeout: 120_000 }).then(({ stdout }) => {
        const status = JSON.parse(stdout);
        if (!status?.ok || !status?.data?.loggedIn || status?.data?.lastLoginMode !== "email") {
          throw new Error("restored OnchainOS email session is not logged in");
        }
        console.log(`[prime-port] onchainos email session ready (${status.data.email || "email account"})`);
      })
      : promisify(execFile)("onchainos", ["wallet", "login", "--force"], { timeout: 120_000 })
        .then(() => console.log("[prime-port] onchainos wallet login ok (AK)"));
    okxLoginPromise = command
      .catch((error) => {
        okxLoginPromise = undefined;
        throw error;
      });
  }
  return okxLoginPromise;
}

async function assertExpectedAgentVisible(env) {
  const expected = String(process.env.EXPECTED_OKX_AGENT_ID ?? "5982").replace(/^#/, "");
  const { stdout } = await promisify(execFile)("onchainos", ["agent", "get", "--page", "1", "--page-size", "50"], {
    env,
    timeout: 120_000,
  });
  const payload = JSON.parse(stdout);
  const agents = (payload?.data?.list ?? []).flatMap((account) => account?.agentList ?? []);
  if (!agents.some((agent) => String(agent.agentId) === expected)) {
    throw new Error(`expected OKX agent #${expected} is not visible in this login`);
  }
  return expected;
}

// OKX marketplace watcher: opt-in so a cloud deployment can be brought up
// and verified before the old watcher is stopped. Never run two watchers for
// the same ASP.
async function startWatcher() {
  if (!isEnabled(process.env.ENABLE_MARKETPLACE_WATCHER)) {
    runtimeStatus.marketplaceWatcher = "disabled";
    console.log("[prime-port] ENABLE_MARKETPLACE_WATCHER is off, marketplace watcher disabled");
    return;
  }
  if (!process.env.OKX_API_KEY || !process.env.OKX_SECRET_KEY || !process.env.OKX_PASSPHRASE) {
    runtimeStatus.marketplaceWatcher = "blocked:missing-okx-credentials";
    console.log("[prime-port] OKX credentials not set, marketplace watcher off");
    return;
  }
  try {
    runtimeStatus.marketplaceWatcher = "starting";
    await ensureOkxLogin();
  } catch (e) {
    runtimeStatus.marketplaceWatcher = "retrying-login";
    console.error(`[prime-port] onchainos login failed, retrying in 60s: ${(e.stderr || e.message).trim().split("\n")[0]}`);
    setTimeout(startWatcher, 60_000);
    return;
  }
  const watcher = spawn(
    process.execPath,
    [new URL("./marketplace-watcher/watcher.mjs", import.meta.url).pathname, "run"],
    { stdio: "inherit", env: { ...process.env, BACKEND_URL: `http://127.0.0.1:${APP_PORT}` } },
  );
  runtimeStatus.marketplaceWatcher = "running";
  watcher.on("exit", (code) => {
    okxLoginPromise = undefined;
    runtimeStatus.marketplaceWatcher = "restarting";
    console.error(`[prime-port] watcher exited (code ${code}), restarting in 30s`);
    setTimeout(startWatcher, 30_000);
  });
}

// A2A/XMTP listener + Hermes responder. Hermes talks to NVIDIA NIM through
// its first-class OpenAI-compatible provider, so the cloud worker needs no
// desktop session and no OpenAI account. Secrets stay in environment vars.
function scheduleA2ARecycle(env, recycleMs) {
  const recycleTimer = setTimeout(async () => {
    runtimeStatus.a2aResponder = "recycling";
    console.log(`[prime-port] recycling cloud A2A responder after ${Math.round(recycleMs / 60_000)}m to bound memory`);
    try {
      await promisify(execFile)(
        "okx-a2a",
        ["daemon", "restart", "--provider", "hermes"],
        { env, timeout: 180_000 },
      );
      console.log("[prime-port] cloud A2A responder recycle complete");
      runtimeStatus.a2aResponder = "running";
      scheduleA2ARecycle(env, recycleMs);
    } catch (error) {
      runtimeStatus.a2aResponder = "retrying-setup";
      console.error(`[prime-port] cloud A2A recycle failed, repairing in 60s: ${error.message.split("\n")[0]}`);
      setTimeout(startA2AResponder, 60_000).unref();
    }
  }, recycleMs);
  recycleTimer.unref();
}

async function startA2AResponder() {
  if (!isEnabled(process.env.ENABLE_A2A_RESPONDER)) {
    runtimeStatus.a2aResponder = "disabled";
    console.log("[prime-port] ENABLE_A2A_RESPONDER is off, cloud A2A responder disabled");
    return;
  }
  if (!process.env.OKX_API_KEY || !process.env.OKX_SECRET_KEY || !process.env.OKX_PASSPHRASE) {
    runtimeStatus.a2aResponder = "blocked:missing-okx-credentials";
    console.log("[prime-port] OKX credentials not set, cloud A2A responder off");
    return;
  }
  if (!process.env.NVIDIA_API_KEY) {
    runtimeStatus.a2aResponder = "blocked:missing-nvidia-key";
    console.log("[prime-port] NVIDIA_API_KEY not set, cloud A2A responder off");
    return;
  }

  const taskHome = process.env.OKX_AGENT_TASK_HOME ?? "/app/okx-agent-task";
  const aiWorkspace = process.env.OKX_A2A_AI_CWD ?? "/app/a2a-workspace";
  const hermesHome = process.env.HERMES_HOME ?? "/app/hermes";
  const hermesModel = process.env.HERMES_NVIDIA_MODEL ?? "nvidia/nemotron-3-super-120b-a12b";
  if (!/^[a-zA-Z0-9._/-]+$/.test(hermesModel)) {
    runtimeStatus.a2aResponder = "blocked:invalid-hermes-model";
    console.error("[prime-port] HERMES_NVIDIA_MODEL contains unsupported characters");
    return;
  }
  mkdirSync(taskHome, { recursive: true });
  mkdirSync(aiWorkspace, { recursive: true });
  mkdirSync(hermesHome, { recursive: true });
  writeFileSync(
    `${hermesHome}/config.yaml`,
    `model:\n  provider: nvidia\n  default: ${hermesModel}\n`,
    { mode: 0o600 },
  );
  const env = {
    ...process.env,
    OKX_AGENT_TASK_HOME: taskHome,
    OKX_A2A_AI_CWD: aiWorkspace,
    HERMES_HOME: hermesHome,
    OKX_A2A_AI_PROVIDER: "hermes",
    OKX_A2A_AI_PERMISSION_PRESET: "bypass",
  };

  try {
    runtimeStatus.a2aResponder = "starting";
    await ensureOkxLogin();
    const agentId = await assertExpectedAgentVisible(env);
    await promisify(execFile)("onchainos", ["preflight", "--skill-version", "4.2.4"], { env, timeout: 180_000 });
    await promisify(execFile)("hermes", ["version"], { env, timeout: 30_000 });
    const { stdout: doctorStdout } = await promisify(execFile)(
      "okx-a2a",
      ["doctor", "--fix", "--json"],
      { env, timeout: 180_000 },
    );
    const doctor = JSON.parse(doctorStdout.trim());
    const doctorReady = doctor.ready ?? doctor.data?.ready;
    if (doctorReady !== true) {
      const details = [
        doctor.userMessage ?? doctor.data?.userMessage,
        ...(doctor.nextActions ?? doctor.data?.nextActions ?? []).map((action) =>
          typeof action === "string" ? action : [action.why, action.command].filter(Boolean).join(": "),
        ),
      ].filter(Boolean).join(" | ");
      throw new Error(`OKX A2A doctor did not report ready${details ? `: ${details}` : ""}`);
    }
    if (!hermesInferenceVerified) {
      runtimeStatus.a2aResponder = "testing-inference";
      const { stdout } = await promisify(execFile)(
        "hermes",
        [
          "--oneshot",
          "Reply with exactly PRIME_PORT_HERMES_OK and nothing else.",
          "--model", hermesModel,
          "--provider", "nvidia",
          "--ignore-rules",
        ],
        { env, timeout: 180_000 },
      );
      if (!stdout.includes("PRIME_PORT_HERMES_OK")) {
        throw new Error("Hermes/NVIDIA inference smoke test returned an unexpected response");
      }
      hermesInferenceVerified = true;
      console.log("[prime-port] Hermes/NVIDIA inference smoke test passed");
    }
    console.log(`[prime-port] cloud Hermes/NVIDIA A2A responder configured for #${agentId} (${hermesModel})`);
  } catch (error) {
    runtimeStatus.a2aResponder = "retrying-setup";
    console.error(`[prime-port] cloud A2A setup failed, retrying in 60s: ${error.message.split("\n")[0]}`);
    setTimeout(startA2AResponder, 60_000);
    return;
  }

  runtimeStatus.a2aResponder = "running";
  const configuredRecycleMs = Number(process.env.A2A_RECYCLE_MS ?? 4 * 60 * 60 * 1000);
  const recycleMs = Number.isFinite(configuredRecycleMs) && configuredRecycleMs > 0 ? configuredRecycleMs : 0;
  if (recycleMs > 0) scheduleA2ARecycle(env, recycleMs);
}

startWatcher();
startA2AResponder();
