// Follow-up: what does the network say about the revoked installation, and can
// the revoked agent client still be used after everyone syncs?
import { Client, IdentifierKind } from "@xmtp/node-sdk";
import { toBytes } from "viem";

const PORT_SVC = "http://localhost:8790";
const info = await (await fetch(`${PORT_SVC}/info`)).json();

const remoteSigner = {
  type: "EOA",
  getIdentifier: () => ({
    identifier: info.address,
    identifierKind: IdentifierKind.Ethereum,
  }),
  signMessage: async (message) => {
    console.log("[post] WARNING: SDK requested a signature (should not happen for existing db)");
    const r = await (
      await fetch(`${PORT_SVC}/sign`, { method: "POST", body: JSON.stringify({ message }) })
    ).json();
    return toBytes(r.signature);
  },
};

// 1. What does the network say about the inbox's installations now?
const state = await Client.inboxStateFromInboxIds([info.inboxId], "dev");
console.log(
  "[post] installations on port inbox per network:",
  state[0].installations.map((i) => i.id.slice(0, 12) + "…"),
);

// 2. Can the revoked agent client even come back up from its local db?
try {
  const agentClient = await Client.create(remoteSigner, {
    env: "dev",
    dbPath: "./data/agent.db3",
  });
  console.log(`[post] revoked client rebuilt, installation ${agentClient.installationId.slice(0, 12)}…`);
  console.log(`[post] isRegistered: ${agentClient.isRegistered}`);
  try {
    const authorized = await Client.isInstallationAuthorized(
      info.inboxId,
      new Uint8Array(Buffer.from(agentClient.installationId, "hex")),
      "dev",
    );
    console.log(`[post] network says this installation authorized: ${authorized}`);
  } catch (e) {
    console.log(`[post] isInstallationAuthorized errored: ${e.message.slice(0, 100)}`);
  }
  await agentClient.conversations.syncAll();
  const convos = await agentClient.conversations.list();
  await convos[0].sync();
  try {
    await convos[0].send("second post-revoke message, after full sync");
    console.log("[post] LEAK persists: send still accepted after sync");
  } catch (e) {
    console.log(`[post] send rejected after sync: ${e.message.slice(0, 140)}`);
  }
} catch (e) {
  console.log(`[post] revoked client unusable: ${e.message.slice(0, 140)}`);
}
process.exit(0);
