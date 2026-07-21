import { createAccount, createClient } from "genlayer-js";
import { localnet, studionet, testnetAsimov } from "genlayer-js/chains";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { disputedJobs, needsGenLayerSubmission, normalizeGenLayerVerdict } from "./core.mjs";

const env = process.env;
const required = [
  "GENLAYER_JUDGE_ADDRESS",
  "GENLAYER_RPC_URL",
  "GENLAYER_RELAYER_KEY",
  "ESCROW_ADDRESS",
  "RELAYER_TOKEN",
];
const missing = required.filter((name) => !env[name]);
if (missing.length) {
  console.log(`[genlayer-relayer] disabled; missing ${missing.join(", ")}`);
  process.exit(0);
}

const backend = env.BACKEND_URL ?? "http://127.0.0.1:7860";
const rpcUrl = env.XLAYER_RPC_URL ?? "https://rpc.xlayer.tech";
const pollMs = Number(env.GENLAYER_POLL_MS ?? 15_000);
const chain = defineChain({
  id: 196,
  name: "X Layer",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const evmAccount = privateKeyToAccount(env.GENLAYER_RELAYER_KEY);
const walletClient = createWalletClient({ account: evmAccount, chain, transport: http(rpcUrl) });
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const genLayerNetworks = { localnet, studionet, asimov: testnetAsimov };
const genLayerNetworkName = (env.GENLAYER_CHAIN ?? "studionet").toLowerCase();
const genLayerNetwork = genLayerNetworks[genLayerNetworkName];
if (!genLayerNetwork) {
  throw new Error(`GENLAYER_CHAIN must be one of ${Object.keys(genLayerNetworks).join(", ")}`);
}
const genLayerClient = createClient({
  chain: { ...genLayerNetwork, rpcUrls: { default: { http: [env.GENLAYER_RPC_URL] } } },
  account: createAccount(env.GENLAYER_RELAYER_KEY),
  endpoint: env.GENLAYER_RPC_URL,
});
console.log(`[genlayer-relayer] using ${genLayerNetworkName} at ${env.GENLAYER_RPC_URL}`);

const escrowAbi = [{
  type: "function",
  name: "resolveDispute",
  stateMutability: "nonpayable",
  inputs: [
    { name: "commitmentHash", type: "bytes32" },
    { name: "resolutionId", type: "bytes32" },
    { name: "verdictHash", type: "bytes32" },
    { name: "providerBps", type: "uint16" },
  ],
  outputs: [],
}];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const getJobs = async () => {
  const response = await fetch(`${backend}/jobs`);
  if (!response.ok) throw new Error(`backend jobs returned ${response.status}`);
  return response.json();
};
const recordSubmission = async (jobId, transactionHash) => {
  const response = await fetch(`${backend}/jobs/${jobId}/genlayer-submitted`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-relayer-token": env.RELAYER_TOKEN,
    },
    body: JSON.stringify({ transactionHash }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`backend submission marker returned ${response.status}: ${body}`);
  }
};

async function readVerdict(commitmentHash) {
  try {
    const raw = await genLayerClient.readContract({
      address: env.GENLAYER_JUDGE_ADDRESS,
      functionName: "get_case",
      args: [commitmentHash],
      stateStatus: "finalized",
    });
    return normalizeGenLayerVerdict(raw);
  } catch (error) {
    if (/not found|missing|empty/i.test(error.message)) return null;
    throw error;
  }
}

async function submitCase(job) {
  const evidenceUrl = `${backend}/evidence/${job.settlement.evidenceHash}`;
  const hash = await genLayerClient.writeContract({
    address: env.GENLAYER_JUDGE_ADDRESS,
    functionName: "adjudicate",
    args: [job.pendingHire.hash, evidenceUrl, job.settlement.evidenceHash],
  });
  console.log(`[genlayer-relayer] submitted ${job.jobId} to GenLayer: ${hash}`);
  await recordSubmission(job.jobId, hash);
  await genLayerClient.waitForTransactionReceipt({ hash, status: "ACCEPTED", retries: 60 });
}

async function relayVerdict(job, verdict) {
  if (verdict.evidenceHash !== job.settlement.evidenceHash.toLowerCase()) {
    throw new Error(`GenLayer evidence hash mismatch for ${job.jobId}`);
  }
  const hash = await walletClient.writeContract({
    address: env.ESCROW_ADDRESS,
    abi: escrowAbi,
    functionName: "resolveDispute",
    args: [job.pendingHire.hash, verdict.resolutionId, verdict.verdictHash, verdict.providerBps],
  });
  await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
  console.log(`[genlayer-relayer] resolved ${job.jobId} on X Layer: ${hash}`);
}

while (true) {
  try {
    for (const job of disputedJobs(await getJobs())) {
      const verdict = await readVerdict(job.pendingHire.hash);
      if (verdict) await relayVerdict(job, verdict);
      else if (needsGenLayerSubmission(job)) await submitCase(job);
    }
  } catch (error) {
    console.error(`[genlayer-relayer] ${error.message}`);
  }
  await sleep(pollMs);
}
