import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const region = process.env.AWS_REGION ?? "us-east-1";
const serviceId = process.env.RENDER_SERVICE_ID ?? "srv-d9a4lsss728c73e6lflg";
const renderConfig = readFileSync(`${process.env.HOME}/.render/cli.yaml`, "utf8");
const renderToken = renderConfig.match(/^\s*key:\s*(\S+)/m)?.[1];
if (!renderToken) throw new Error("Render CLI token unavailable");

const response = await fetch(`https://api.render.com/v1/services/${serviceId}/env-vars?limit=100`, {
  headers: { authorization: `Bearer ${renderToken}` },
});
if (!response.ok) throw new Error(`Render environment fetch failed: HTTP ${response.status}`);

const renderVariables = Object.fromEntries(
  (await response.json()).map((item) => [item.envVar.key, item.envVar.value]),
);
const sessionVariables = {
  ONCHAINOS_KEYRING_B64: readFileSync(`${process.env.HOME}/.onchainos/keyring.enc`).toString("base64"),
  ONCHAINOS_MACHINE_IDENTITY_B64: readFileSync(`${process.env.HOME}/.onchainos/machine-identity`).toString("base64"),
  ONCHAINOS_SESSION_B64: readFileSync(`${process.env.HOME}/.onchainos/session.json`).toString("base64"),
  ONCHAINOS_WALLETS_B64: readFileSync(`${process.env.HOME}/.onchainos/wallets.json`).toString("base64"),
};

const excluded = new Set([
  "ENABLE_A2A_RESPONDER",
  "ENABLE_MARKETPLACE_WATCHER",
  "EXPECTED_OKX_AGENT_ID",
  "PUBLIC_BASE_URL",
  "ATTACH_BASE",
]);
const variables = {
  ...Object.fromEntries(Object.entries(renderVariables).filter(([key]) => !excluded.has(key))),
  ...sessionVariables,
};

for (const [key, value] of Object.entries(variables)) {
  if (!value) continue;
  const result = spawnSync("aws", [
    "ssm", "put-parameter",
    "--region", region,
    "--name", `/prime-port/${key}`,
    "--type", "SecureString",
    "--tier", Buffer.byteLength(value) > 4096 ? "Advanced" : "Standard",
    "--value", value,
    "--overwrite",
  ], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${key}: ${result.stderr.trim()}`);
  console.log(`${key}: stored`);
}
