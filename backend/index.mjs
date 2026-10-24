// Single-process entry for the Prime Port backend: port-service and
// mcp-server in one runtime behind one public port. Free hosts hand out one
// service slot with one exposed port (Hugging Face Spaces: app_port, default
// 7860), so a thin proxy on that port routes by path prefix to the two
// servers, which keep their internal defaults on localhost.
//
// The only optional child process is the GenLayer dispute relayer: it reads
// verdicts from GenLayer and applies them to the escrow on the settlement
// chain. It is opt-in via ENABLE_GENLAYER_RELAYER.
//
// Publication is paid in native ETH and buyers talk to the job inbox over
// HTTP, so nothing in this process needs a marketplace account.
import { createServer, request } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { restoreState, startBackupLoop } from "./state-sync.mjs";
import { publicUpstream } from "./public-routing.mjs";

// The public port: APP_PORT if set, else the host-assigned PORT (Render
// injects one and routes traffic to it), else 7860 (Hugging Face style).
const APP_PORT = Number(process.env.APP_PORT ?? process.env.PORT ?? 7860);
const isEnabled = (value) => ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
const runtimeStatus = { genlayerRelayer: "disabled" };
const processStartedAt = Date.now();
const healthStartupGraceMs = Number(process.env.HEALTH_STARTUP_GRACE_MS ?? 300_000);

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
  !isEnabled(process.env.ENABLE_GENLAYER_RELAYER) || runtimeStatus.genlayerRelayer === "running";

// The two internal services share this process in production. Generate
// private credentials before importing either service so internal HTTP calls
// are authenticated even when the deploy operator has not supplied secrets.
process.env.PORT_SERVICE_TOKEN ??= randomBytes(32).toString("hex");
process.env.SESSION_SECRET ??= randomBytes(32).toString("hex");
process.env.BACKEND_SERVICE_TOKEN ??= randomBytes(32).toString("hex");

// Each service reads process.env.PORT with its own fallback (8791 / 8792).
// Clearing PORT before import lets both fall back and the proxy own APP_PORT.
delete process.env.PORT;

await restoreState();
await import("./port-service/service.mjs");
await import("./mcp-server/server.mjs");
await import("./distribution/poster.mjs");
startBackupLoop();

// Path prefix -> internal port. Everything the web app and agents touch:
// /ports is deliberately absent. Port control is service-to-service only.
// Attachment downloads remain capability URLs containing an unguessable
// content digest. Uploads go through the authenticated API.
createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/" || path === "/health") {
    const ready = serviceReady();
    const inStartupGrace = !ready && Date.now() - processStartedAt < healthStartupGraceMs;
    const statusCode = ready || inStartupGrace ? 200 : 503;
    res.writeHead(statusCode, { "content-type": "application/json" });
    return res.end(JSON.stringify({
      ok: ready,
      service: "prime-port",
      components: runtimeStatus,
      startupGrace: inStartupGrace,
      memory: memoryStatus(),
    }));
  }
  const port = publicUpstream(path, req.method);
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

function startGenLayerRelayer() {
  if (!isEnabled(process.env.ENABLE_GENLAYER_RELAYER)) {
    runtimeStatus.genlayerRelayer = "disabled";
    console.log("[prime-port] ENABLE_GENLAYER_RELAYER is off, dispute relayer disabled");
    return;
  }
  const required = ["GENLAYER_JUDGE_ADDRESS", "GENLAYER_RPC_URL", "GENLAYER_RELAYER_KEY", "ESCROW_ADDRESS", "RELAYER_TOKEN"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    runtimeStatus.genlayerRelayer = `blocked:missing-${missing.join(",").toLowerCase()}`;
    console.error(`[prime-port] GenLayer relayer missing ${missing.join(", ")}`);
    return;
  }
  const child = spawn(
    process.execPath,
    [new URL("./genlayer-relayer/relayer.mjs", import.meta.url).pathname],
    { stdio: "inherit", env: { ...process.env, BACKEND_URL: `http://127.0.0.1:${APP_PORT}` } },
  );
  runtimeStatus.genlayerRelayer = "running";
  child.on("exit", (code) => {
    runtimeStatus.genlayerRelayer = "restarting";
    console.error(`[prime-port] GenLayer relayer exited (code ${code}), restarting in 30s`);
    setTimeout(startGenLayerRelayer, 30_000);
  });
}

startGenLayerRelayer();
