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
import { promisify } from "node:util";
import { restoreState, startBackupLoop } from "./state-sync.mjs";

// The public port: APP_PORT if set, else the host-assigned PORT (Render
// injects one and routes traffic to it), else 7860 (Hugging Face style).
const APP_PORT = Number(process.env.APP_PORT ?? process.env.PORT ?? 7860);

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
  if (path === "/mcp" || path.startsWith("/jobs") || path.startsWith("/freelancers")) return 8792;
  if (path.startsWith("/ports") || path.startsWith("/attachments")) return 8791;
  return null;
};

createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/" || path === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, service: "prime-port" }));
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

// OKX marketplace watcher: AK login, then run as a child process (its run
// loop never returns, so it can't be imported like the servers). If it dies
// it comes back in 30s with a fresh login.
async function startWatcher() {
  if (!process.env.OKX_API_KEY || !process.env.OKX_SECRET_KEY || !process.env.OKX_PASSPHRASE) {
    console.log("[prime-port] OKX_API_KEY/OKX_SECRET_KEY/OKX_PASSPHRASE not set, marketplace watcher off");
    return;
  }
  try {
    await promisify(execFile)("onchainos", ["wallet", "login", "--force"], { timeout: 120_000 });
    console.log("[prime-port] onchainos wallet login ok (AK)");
  } catch (e) {
    console.error(`[prime-port] onchainos login failed, retrying in 60s: ${(e.stderr || e.message).trim().split("\n")[0]}`);
    setTimeout(startWatcher, 60_000);
    return;
  }
  const watcher = spawn(
    process.execPath,
    [new URL("./marketplace-watcher/watcher.mjs", import.meta.url).pathname, "run"],
    { stdio: "inherit", env: { ...process.env, BACKEND_URL: `http://127.0.0.1:${APP_PORT}` } },
  );
  watcher.on("exit", (code) => {
    console.error(`[prime-port] watcher exited (code ${code}), restarting in 30s`);
    setTimeout(startWatcher, 30_000);
  });
}
startWatcher();
