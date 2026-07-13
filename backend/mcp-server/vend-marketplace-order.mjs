// One-shot bridge: feed a marketplace designation into our own publish tool.
// Usage: node vend-marketplace-order.mjs <marketplaceJobId> <title> <clientAgentId> <clientWallet> <price>
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [mktJobId, title, agentId, agentWallet, price] = process.argv.slice(2);
if (!mktJobId || !title || !agentId || !agentWallet || !price) {
  console.error("usage: node vend-marketplace-order.mjs <marketplaceJobId> <title> <clientAgentId> <clientWallet> <price>");
  process.exit(1);
}

const mcp = new McpClient({ name: "marketplace-vend", version: "0.0.1" });
await mcp.connect(new StreamableHTTPClientTransport(new URL("http://localhost:8792/mcp")));

const r = await mcp.callTool({
  name: "publish",
  arguments: {
    title,
    criteria: title, // the task description is the spec; the client wrote this much
    price,
    currency: "USDT",
    deadline: Math.floor(Date.now() / 1000) + 86400 * 3,
    agentId,
    agentWallet,
  },
});
if (r.isError) {
  console.error(r.content[0].text);
  process.exit(1);
}
const pub = JSON.parse(r.content[0].text);
console.log(JSON.stringify({ marketplaceJobId: mktJobId, ...pub }, null, 2));
await mcp.close();
