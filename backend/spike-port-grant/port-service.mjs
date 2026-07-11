// Process A: the Prime Port side.
// Holds the port wallet (recovery identity), creates the port inbox, and exposes
// a one-shot signing endpoint so a remote party can register an installation
// without ever seeing the key. Also exposes revoke, which only this side can do.
import { createServer } from "node:http";
import { Client, IdentifierKind } from "@xmtp/node-sdk";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { toBytes } from "viem";

const portKey = generatePrivateKey(); // never leaves this process
const account = privateKeyToAccount(portKey);

const signer = {
  type: "EOA",
  getIdentifier: () => ({
    identifier: account.address.toLowerCase(),
    identifierKind: IdentifierKind.Ethereum,
  }),
  signMessage: async (message) =>
    toBytes(await account.signMessage({ message })),
};

const client = await Client.create(signer, {
  env: "dev",
  dbPath: "./data/port.db3",
});
console.log(`[port] inbox created: ${client.inboxId}`);
console.log(`[port] our installation: ${client.installationId}`);
console.log(`[port] address: ${account.address}`);

createServer(async (req, res) => {
  const body = await new Promise((r) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => r(d));
  });
  const reply = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  try {
    if (req.url === "/info") {
      return reply(200, {
        address: account.address.toLowerCase(),
        inboxId: client.inboxId,
      });
    }
    if (req.url === "/sign" && req.method === "POST") {
      const { message } = JSON.parse(body);
      console.log(`[port] grant: signing installation registration (${message.length} chars)`);
      const sig = await account.signMessage({ message });
      return reply(200, { signature: sig });
    }
    if (req.url === "/revoke" && req.method === "POST") {
      const { installationId } = JSON.parse(body);
      console.log(`[port] revoking installation ${installationId}`);
      await Client.revokeInstallations(
        signer,
        client.inboxId,
        [Buffer.from(installationId, "hex")],
        "dev",
      );
      // Force the membership commit in every conversation so the revocation
      // takes effect NOW, not at some future sync (protocol gives no timing
      // guarantee otherwise). Our own installation is a member of every
      // channel, so its sync + a closing message rotates each group's epoch.
      await client.conversations.syncAll();
      const convos = await client.conversations.list();
      for (const c of convos) {
        await c.sync();
        await c.send("[port closed]");
      }
      console.log(`[port] flushed revocation through ${convos.length} conversation(s)`);
      return reply(200, { revoked: installationId, flushed: convos.length });
    }
    reply(404, { error: "not found" });
  } catch (e) {
    console.error("[port] error:", e.message);
    reply(500, { error: e.message });
  }
}).listen(8790, () => console.log("[port] signing service on :8790, ready"));
