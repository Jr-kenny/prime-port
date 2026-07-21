import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createPublicClient, defineChain, http } from "viem";
import { escrowAbi } from "./escrow.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function startEscrowWatcher({ config, cursorPath, onEvent, env = process.env }) {
  if (!config.enabled) {
    console.log("[escrow-watcher] ESCROW_ADDRESS not set, watcher disabled");
    return { stop() {} };
  }

  const chain = defineChain({
    id: config.chainId,
    name: "X Layer",
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  const client = createPublicClient({ chain, transport: http(config.rpcUrl) });
  const pollMs = Number(env.ESCROW_POLL_MS ?? 5_000);
  const confirmations = BigInt(env.ESCROW_CONFIRMATIONS ?? 2);
  let stopped = false;

  const readCursor = () => {
    if (!existsSync(cursorPath)) return null;
    const parsed = JSON.parse(readFileSync(cursorPath, "utf8"));
    return BigInt(parsed.block);
  };
  const writeCursor = (block) => {
    const next = `${cursorPath}.next`;
    writeFileSync(next, JSON.stringify({ block: block.toString(), updatedAt: Date.now() }));
    renameSync(next, cursorPath);
  };

  const run = async () => {
    let cursor = readCursor();
    while (!stopped) {
      try {
        const head = await client.getBlockNumber();
        const safeHead = head > confirmations ? head - confirmations : 0n;
        if (cursor === null) {
          const configured = env.ESCROW_START_BLOCK ? BigInt(env.ESCROW_START_BLOCK) : null;
          cursor = configured === null
            ? (safeHead > 100n ? safeHead - 100n : 0n)
            : (configured > 0n ? configured - 1n : 0n);
        }
        if (safeHead > cursor) {
          const logs = await client.getContractEvents({
            address: config.address,
            abi: escrowAbi,
            fromBlock: cursor + 1n,
            toBlock: safeHead,
            strict: true,
          });
          logs.sort((a, b) => {
            if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
            return Number(a.logIndex) - Number(b.logIndex);
          });
          for (const log of logs) {
            await onEvent({
              eventName: log.eventName,
              args: log.args,
              transactionHash: log.transactionHash,
              blockNumber: log.blockNumber.toString(),
              logIndex: Number(log.logIndex),
            });
          }
          cursor = safeHead;
          writeCursor(cursor);
        }
      } catch (error) {
        console.error(`[escrow-watcher] ${error.message}`);
      }
      await sleep(pollMs);
    }
  };

  run();
  console.log(`[escrow-watcher] watching ${config.address} on eip155:${config.chainId}`);
  return { stop() { stopped = true; } };
}
