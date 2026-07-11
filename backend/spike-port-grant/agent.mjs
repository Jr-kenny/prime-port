// Process B: the agent side, plus a freelancer to talk to. The freelancer's
// key here is a locally generated stand-in for the real MPC embedded wallet
// a claimer gets in production; to XMTP the two signers look identical.
// Proves the full port story against the live XMTP dev network:
//   1. GRANT   - agent registers its own installation on the port inbox via the
//                remote /sign endpoint; the port wallet key never comes here.
//   2. OPERATE - a freelancer DMs the port; the agent reads and replies AS the
//                port, first person, with no further help from the port service.
//   3. REVOKE  - port service revokes the agent's installation; the agent's
//                next send must fail.
import { Client, IdentifierKind } from "@xmtp/node-sdk";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { toBytes } from "viem";

const PORT_SVC = "http://localhost:8790";
const info = await (await fetch(`${PORT_SVC}/info`)).json();
console.log(`[agent] port identity: ${info.address} (inbox ${info.inboxId.slice(0, 12)}…)`);

// --- 1. GRANT ------------------------------------------------------------
// Standard XMTP signer whose signMessage is proxied to the port service.
const remoteSigner = {
  type: "EOA",
  getIdentifier: () => ({
    identifier: info.address,
    identifierKind: IdentifierKind.Ethereum,
  }),
  signMessage: async (message) => {
    console.log("[agent] asking port service to sign my installation…");
    const r = await (
      await fetch(`${PORT_SVC}/sign`, {
        method: "POST",
        body: JSON.stringify({ message }),
      })
    ).json();
    return toBytes(r.signature);
  },
};

const agentClient = await Client.create(remoteSigner, {
  env: "dev",
  dbPath: "./data/agent.db3",
});
const sameInbox = agentClient.inboxId === info.inboxId;
console.log(`[agent] GRANT ok: my installation ${agentClient.installationId.slice(0, 12)}… on inbox ${agentClient.inboxId.slice(0, 12)}…`);
console.log(`[agent] same inbox as port? ${sameInbox}`);
if (!sameInbox) throw new Error("installation landed on a different inbox");

// --- 2. OPERATE ----------------------------------------------------------
const flKey = generatePrivateKey();
const flAccount = privateKeyToAccount(flKey);
const flSigner = {
  type: "EOA",
  getIdentifier: () => ({
    identifier: flAccount.address.toLowerCase(),
    identifierKind: IdentifierKind.Ethereum,
  }),
  signMessage: async (message) => toBytes(await flAccount.signMessage({ message })),
};
const flClient = await Client.create(flSigner, {
  env: "dev",
  dbPath: "./data/freelancer.db3",
});
console.log(`[freelancer] my own inbox: ${flClient.inboxId.slice(0, 12)}…`);
const { writeFileSync } = await import("node:fs");
writeFileSync("./data/fl-address.txt", flAccount.address.toLowerCase());

const dm = await flClient.conversations.newDm(info.inboxId);
await dm.send("hi, I claimed your job. can we talk price?");
console.log("[freelancer] sent DM to the port");

await agentClient.conversations.syncAll();
const convos = await agentClient.conversations.list();
const portSide = convos[0];
await portSide.sync();
const inbound = (await portSide.messages()).filter(
  (m) => m.senderInboxId === flClient.inboxId,
);
console.log(`[agent] received as port: "${inbound.at(-1)?.content}"`);
await portSide.send("sure - budget is 40 USDT, deadline friday. convince me.");

await dm.sync();
const replies = (await dm.messages()).filter(
  (m) => m.senderInboxId === info.inboxId,
);
console.log(`[freelancer] port replied (sender inbox matches port: ${replies.length > 0}): "${replies.at(-1)?.content}"`);

// --- 3. REVOKE -----------------------------------------------------------
const r = await (
  await fetch(`${PORT_SVC}/revoke`, {
    method: "POST",
    body: JSON.stringify({ installationId: agentClient.installationId }),
  })
).json();
console.log(`[agent] port service revoked my installation: ${JSON.stringify(r)}`);

// Let the freelancer's client process the revocation commit BEFORE the agent
// tries to speak again — this is the realistic post-scrap state.
await new Promise((res) => setTimeout(res, 2000));
await flClient.conversations.syncAll();
await dm.sync();

try {
  await agentClient.conversations.syncAll();
  await portSide.send("am I still here?");
  await new Promise((res) => setTimeout(res, 5000));
  await flClient.conversations.syncAll();
  await dm.sync();
  const after = (await dm.messages()).filter(
    (m) => m.content === "am I still here?",
  );
  console.log(
    after.length === 0
      ? "[agent] REVOKE ok: post-revoke message never reached the freelancer"
      : "[agent] REVOKE LEAK: post-revoke message was delivered!",
  );
} catch (e) {
  console.log(`[agent] REVOKE ok: send after revoke failed (${e.message.slice(0, 120)})`);
}
console.log("[agent] spike complete");
process.exit(0);
