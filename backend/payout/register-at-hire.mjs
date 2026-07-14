// Register-at-hire: the first of the two payout workers (issue #24). Every
// hire-committed event (both signatures in, payout address final) becomes a
// register() call on the JobForwarder, welding that job's exit to the
// freelancer's address before any money exists. The on-chain key is the
// commitment hash, so the registration literally references the dual-signed
// deal.
//
// Runs inside the merged backend process (index.mjs imports it). Switches
// itself off with a log line when REGISTRAR_KEY is missing, so local runs
// and pre-credential deploys behave. The registrar wallet can only add new
// mappings, never change one, so the worst a leaked key or a replayed event
// can do is register a job that was already registered, which reverts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const REGISTRAR_KEY = process.env.REGISTRAR_KEY;
const FORWARDER = process.env.FORWARDER_ADDRESS ?? "0xe3f11D89e585e2F0009ee5c6f105861525f70712";
const RPC = process.env.XLAYER_RPC ?? "https://rpc.xlayer.tech";
const REGISTER_EVERY_MS = Number(process.env.REGISTER_EVERY_MS ?? 30_000);

// hire-committed events land here; mcp-server owns the file, we only read.
const EVENTS = new URL("../mcp-server/data/events.jsonl", import.meta.url).pathname;

const DATA = new URL("./data/", import.meta.url).pathname;
mkdirSync(DATA, { recursive: true });
const registeredPath = `${DATA}registered.json`;
const registered = existsSync(registeredPath) ? JSON.parse(readFileSync(registeredPath, "utf8")) : {};
const saveRegistered = () => writeFileSync(registeredPath, JSON.stringify(registered, null, 2));

const xlayer = defineChain({
  id: 196,
  name: "X Layer",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const abi = [
  {
    type: "function",
    name: "register",
    inputs: [{ type: "bytes32" }, { type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "payoutOf",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
];

function pendingHires() {
  if (!existsSync(EVENTS)) return [];
  return readFileSync(EVENTS, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter(
      (e) =>
        e.type === "hire-committed" &&
        /^0x[0-9a-f]{64}$/.test(e.commitmentHash ?? "") &&
        /^0x[0-9a-fA-F]{40}$/.test(e.payoutAddress ?? "") &&
        !registered[e.commitmentHash],
    );
}

async function start() {
  const account = privateKeyToAccount(REGISTRAR_KEY);
  const pub = createPublicClient({ chain: xlayer, transport: http(RPC) });
  const wallet = createWalletClient({ account, chain: xlayer, transport: http(RPC) });

  const balance = await pub.getBalance({ address: account.address });
  console.log(
    `[payout] register-at-hire on, registrar ${account.address}, forwarder ${FORWARDER}, ` +
      `balance ${formatEther(balance)} OKB${balance === 0n ? " — FUND THIS WALLET, registrations will fail" : ""}`,
  );

  async function tick() {
    for (const evt of pendingHires()) {
      const { jobId, commitmentHash, payoutAddress } = evt;
      try {
        // Someone (a previous run, another instance) may have won the race;
        // the chain is the source of truth, our file is just a cursor.
        const existing = await pub.readContract({ address: FORWARDER, abi, functionName: "payoutOf", args: [commitmentHash] });
        if (existing !== "0x0000000000000000000000000000000000000000") {
          registered[commitmentHash] = { jobId, payoutAddress: existing, note: "already on-chain", at: Date.now() };
          saveRegistered();
          console.log(`[payout] ${jobId} already registered on-chain, recorded`);
          continue;
        }
        const { request } = await pub.simulateContract({
          account,
          address: FORWARDER,
          abi,
          functionName: "register",
          args: [commitmentHash, payoutAddress],
        });
        const hash = await wallet.writeContract(request);
        const receipt = await pub.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error(`tx ${hash} reverted`);
        registered[commitmentHash] = { jobId, payoutAddress, tx: hash, at: Date.now() };
        saveRegistered();
        console.log(`[payout] registered ${jobId} -> ${payoutAddress} (tx ${hash})`);
      } catch (e) {
        // Not recorded: next tick retries. A dry wallet or a flaky RPC heals
        // by itself; the write-once contract makes retries safe.
        console.error(`[payout] register for ${jobId} failed: ${e.message.split("\n")[0]}`);
      }
    }
  }

  setInterval(tick, REGISTER_EVERY_MS);
  tick();
}

if (REGISTRAR_KEY) {
  start().catch((e) => console.error(`[payout] failed to start: ${e.message}`));
} else {
  console.log("[payout] REGISTRAR_KEY not set, register-at-hire off");
}
