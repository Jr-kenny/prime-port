// State backup/restore for hosts with ephemeral disks (Hugging Face Spaces).
// The XMTP identity databases and port keys in port-service/data are the one
// thing a container restart must not lose: a port whose db is gone can never
// speak on its inbox again, and a lost key means the archive can never be
// countersigned. So we mirror the data dirs into a private GitHub repo on a
// timer and restore them on boot.
//
// The mirror repo holds port private keys and plaintext job state. It must be
// private, and the credential in the remote URL scoped as tightly as the host
// allows.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const run = promisify(execFile);
// Full https git URL with the credential embedded. Works with any git host:
//   Hugging Face (same token as the Space):
//     https://user:hf_xxx@huggingface.co/datasets/<user>/prime-port-state
//   GitHub (fine-grained PAT, contents read/write):
//     https://x-access-token:ghp_xxx@github.com/<user>/prime-port-state.git
// Dashboard paste boxes love to smuggle newlines into long URLs, and git
// then reports "url contains a newline"; a git URL never has whitespace,
// so strip all of it.
const REMOTE = process.env.STATE_REMOTE?.replace(/\s+/g, "") || undefined;
const EVERY_MS = Number(process.env.BACKUP_EVERY_MS ?? 5 * 60_000);
const MIRROR = new URL("./.state-mirror/", import.meta.url).pathname;
const DIRS = [
  ["port-service-data", new URL("./port-service/data/", import.meta.url).pathname],
  ["mcp-server-data", new URL("./mcp-server/data/", import.meta.url).pathname],
  ["distribution-data", new URL("./distribution/data/", import.meta.url).pathname],
  ["marketplace-watcher-data", new URL("./marketplace-watcher/data/", import.meta.url).pathname],
  ["payout-data", new URL("./payout/data/", import.meta.url).pathname],
  ["okx-a2a-data", process.env.OKX_AGENT_TASK_HOME ?? new URL("./okx-agent-task/", import.meta.url).pathname],
  ["hermes-data", process.env.HERMES_HOME ?? new URL("./hermes/", import.meta.url).pathname],
  ["onchainos-data", `${process.env.HOME ?? "/app"}/.onchainos`],
];

const enabled = () => Boolean(REMOTE);
// Never log REMOTE itself: it carries the credential.
const remoteHost = () => { try { return new URL(REMOTE).host + new URL(REMOTE).pathname; } catch { return "(unparseable remote)"; } };
const safeGitError = (error) => String(error?.stderr || error?.message || error)
  .replaceAll(REMOTE, remoteHost())
  .replace(/https:\/\/[^\s@]+@/g, "https://[redacted]@")
  .trim()
  .split("\n")
  .slice(-2)
  .join(" | ");
const git = (args, cwd = MIRROR) => run("git", args, { cwd });

// On boot: clone the mirror and lay its contents under the live data dirs.
// force:false so anything already on disk wins — a restore must never clobber
// state the running service wrote after a partial start.
export async function restoreState() {
  if (!enabled()) {
    console.log("[state-sync] STATE_REMOTE not set, running without backup");
    return;
  }
  rmSync(MIRROR, { recursive: true, force: true });
  try {
    await run("git", ["clone", "--depth", "1", REMOTE, MIRROR]);
  } catch (e) {
    // Redact the credential-bearing remote before logging the git error.
    const reason = String(e.message ?? e).replace(REMOTE, remoteHost()).split("\n").slice(0, 3).join(" | ");
    console.error(`[state-sync] clone failed, starting empty: ${reason}`);
    mkdirSync(MIRROR, { recursive: true });
    await git(["init", "-b", "main"]);
    await git(["remote", "add", "origin", REMOTE]);
    return;
  }
  for (const [name, live] of DIRS) {
    const src = `${MIRROR}${name}`;
    if (!existsSync(src)) continue;
    mkdirSync(live, { recursive: true });
    cpSync(src, live, { recursive: true, force: false, errorOnExist: false });
    console.log(`[state-sync] restored ${name} (${readdirSync(src).length} entries)`);
  }
}

// Attachments can be up to 50 MB; hosts like Hugging Face require LFS for
// files that size, so the mirror tracks the attachment dirs with LFS.
const GITATTRIBUTES =
  "port-service-data/attachments/** filter=lfs diff=lfs merge=lfs -text\n" +
  "port-service-data/archive/*.attachments/** filter=lfs diff=lfs merge=lfs -text\n";

async function backupOnce() {
  writeFileSync(`${MIRROR}.gitattributes`, GITATTRIBUTES);
  for (const [name, live] of DIRS) {
    if (!existsSync(live)) continue;
    cpSync(live, `${MIRROR}${name}`, { recursive: true, force: true });
  }
  await git(["add", "-A"]);
  const { stdout } = await git(["status", "--porcelain"]);
  if (stdout.trim()) {
    await git([
      "-c", "user.name=prime-port-state-sync",
      "-c", "user.email=state-sync@prime-port.invalid",
      "commit", "-m", `state @ ${new Date().toISOString()}`,
    ]);
  }
  // App Runner briefly overlaps old and new instances during a deployment.
  // Either instance may advance the mirror first, so a plain push can become
  // non-fast-forward and then fail forever on every later tick. Fetch and
  // merge the competing snapshot as an ancestor while deliberately keeping
  // this instance's complete live snapshot. Retry in case both instances
  // race again between the fetch and push.
  let lastPushError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await git(["fetch", "origin", "main"]);
      await git([
        "-c", "user.name=prime-port-state-sync",
        "-c", "user.email=state-sync@prime-port.invalid",
        "merge", "-s", "ours", "--no-edit", "origin/main",
      ]);
      const { stdout: aheadStdout } = await git(["rev-list", "--count", "origin/main..HEAD"]);
      if (Number(aheadStdout.trim()) === 0) return false;
      await git(["push", "-u", "origin", "HEAD:main"]);
      return true;
    } catch (error) {
      lastPushError = error;
      if (attempt < 3) {
        console.log(`[state-sync] snapshot push failed, retrying (${attempt}/3): ${safeGitError(error)}`);
      }
    }
  }
  throw lastPushError;
}

export function startBackupLoop() {
  if (!enabled()) return;
  const tick = async () => {
    try {
      if (await backupOnce()) console.log("[state-sync] pushed state snapshot");
    } catch (e) {
      console.error(`[state-sync] backup failed: ${safeGitError(e)}`);
    }
  };
  setInterval(tick, EVERY_MS);
  tick();
  console.log(`[state-sync] backing up to ${remoteHost()} every ${EVERY_MS / 1000}s`);
}
