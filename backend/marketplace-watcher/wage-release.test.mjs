// The wage-release state machine, walked through every phase with a stubbed
// chain and CLI. Encoder outputs are pinned to real `cast calldata` results
// so hand-rolled ABI encoding can never drift silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWageRelease, enc, pad, usdtUnits, SEL, FORWARDED_TOPIC } from "./wage-release.mjs";

test("usdtUnits: exact 6-decimal string arithmetic, no floats", () => {
  assert.equal(usdtUnits("48"), 48_000_000n);
  assert.equal(usdtUnits("39.5"), 39_500_000n);
  assert.equal(usdtUnits("0.000001"), 1n);
  assert.equal(usdtUnits("1000000"), 1_000_000_000_000n);
});

const FWD = "0xe3f11D89e585e2F0009ee5c6f105861525f70712";
const HASH = "0xaffb82ff02f584b69c3fb349a7ec7d9f8ea54cedd5db71d39133bcf050c47145";

test("enc matches cast calldata for all three write shapes", () => {
  // cast calldata "approve(address,uint256)" <forwarder> 48000000
  assert.equal(
    enc(SEL.approve, FWD, 48_000_000n.toString(16)),
    "0x095ea7b3000000000000000000000000e3f11d89e585e2f0009ee5c6f105861525f707120000000000000000000000000000000000000000000000000000000002dc6c00",
  );
  // cast calldata "deposit(bytes32,uint256)" <hash> 48000000
  assert.equal(
    enc(SEL.deposit, HASH, 48_000_000n.toString(16)),
    "0x1de26e16affb82ff02f584b69c3fb349a7ec7d9f8ea54cedd5db71d39133bcf050c471450000000000000000000000000000000000000000000000000000000002dc6c00",
  );
  // cast calldata "forward(bytes32)" <hash>
  assert.equal(
    enc(SEL.forward, HASH),
    "0x41977d5faffb82ff02f584b69c3fb349a7ec7d9f8ea54cedd5db71d39133bcf050c47145",
  );
});

// A controllable fake chain + CLI. Each scenario sets balances and watches
// which calls the state machine makes.
function rig(chain) {
  const calls = { cli: [], events: [] };
  const zero = "0x" + "0".repeat(64);
  const word = (v) => "0x" + pad(v.toString(16));
  const release = createWageRelease({
    agentId: "5021",
    rpcUrl: "stub://",
    forwarder: FWD,
    usdt: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
    log: { log: () => {}, error: () => {} },
    emit: (type, payload) => calls.events.push({ type, ...payload }),
    cli: async (args) => {
      calls.cli.push(args.join(" "));
      if (args[1] === "addresses") return { data: { xlayer: [{ address: "0x7ab4daee18a449eb76a8a7d66cb02cf34a28563e" }] } };
      if (args[1] === "contract-call") return { data: { txHash: "0x" + "ab".repeat(32) } };
      if (args[1] === "asp-claim-rewards") {
        if (chain.claimFails) throw new Error("no rewards");
        chain.walletUsdt = chain.claimYields ?? chain.walletUsdt;
        return { data: {} };
      }
      throw new Error(`unexpected cli: ${args.join(" ")}`);
    },
  });
  // fetch stub: route eth_* by method
  globalThis.fetch = async (_url, { body }) => {
    const { method, params } = JSON.parse(body);
    const reply = (result) => ({ json: async () => ({ result }) });
    if (method === "eth_getLogs") return reply(chain.forwardedLog ? [{ transactionHash: "0x" + "cd".repeat(32) }] : []);
    if (method === "eth_getTransactionReceipt") return reply(chain.receipt);
    if (method === "eth_call") {
      const { to, data } = params[0];
      if (data.startsWith(SEL.jobBalance)) return reply(word(chain.jobBalance ?? 0n));
      if (data.startsWith(SEL.erc20Balance)) return reply(word(chain.walletUsdt ?? 0n));
      if (data.startsWith(SEL.allowance)) return reply(word(chain.allowance ?? 0n));
      throw new Error(`unexpected eth_call ${to} ${data}`);
    }
    return reply(zero);
  };
  return { release, calls };
}

const tasks = () => ({
  "mkt-1": { kind: "job", portJobId: "job-1", done: { deliver: 1 } },
});
const board = [
  { jobId: "job-1", status: "settled", pendingHire: { hash: HASH, commitment: { terms: { price: "48", currency: "USDT" } } } },
];

test("no funds: attempts a rewards claim and waits", async () => {
  const { release, calls } = rig({ walletUsdt: 0n, claimFails: true });
  const t = tasks();
  await release(t, board);
  assert.ok(calls.cli.some((c) => c.includes("asp-claim-rewards")));
  assert.equal(calls.events.at(-1).step, "awaiting-funds");
  assert.ok(!t["mkt-1"].forwarded);
});

test("funds but no allowance: sends exact-amount approve", async () => {
  const { release, calls } = rig({ walletUsdt: 48_000_000n, allowance: 0n });
  await release(tasks(), board);
  const call = calls.cli.find((c) => c.includes("contract-call"));
  assert.ok(call.includes(enc(SEL.approve, FWD, 48_000_000n.toString(16))));
  assert.equal(calls.events.at(-1).step, "approve-sent");
});

test("allowance ready: deposits under the commitment hash and remembers the tx", async () => {
  const { release, calls } = rig({ walletUsdt: 48_000_000n, allowance: 48_000_000n });
  const t = tasks();
  await release(t, board);
  const call = calls.cli.find((c) => c.includes("contract-call"));
  assert.ok(call.includes(enc(SEL.deposit, HASH, 48_000_000n.toString(16))));
  assert.equal(t["mkt-1"].depositTx, "0x" + "ab".repeat(32));
});

test("deposit in flight: never deposits again while the tx is pending", async () => {
  const { release, calls } = rig({ walletUsdt: 48_000_000n, allowance: 48_000_000n, receipt: null });
  const t = tasks();
  t["mkt-1"].depositTx = "0x" + "ab".repeat(32);
  await release(t, board);
  assert.ok(!calls.cli.some((c) => c.includes("contract-call")));
  assert.equal(calls.events.at(-1).step, "deposit-pending");
});

test("job balance on the forwarder: sends forward", async () => {
  const { release, calls } = rig({ jobBalance: 48_000_000n });
  await release(tasks(), board);
  const call = calls.cli.find((c) => c.includes("contract-call"));
  assert.ok(call.includes(enc(SEL.forward, HASH)));
});

test("Forwarded event on chain: marks done, touches nothing", async () => {
  const { release, calls } = rig({ forwardedLog: true });
  const t = tasks();
  await release(t, board);
  assert.ok(t["mkt-1"].forwarded);
  assert.equal(t["mkt-1"].forwardTx, "0x" + "cd".repeat(32));
  assert.ok(!calls.cli.some((c) => c.includes("contract-call")));
  assert.equal(calls.events[0].type, "wage-forwarded");
});

test("not due: unsettled board job or missing deliver never touches the chain", async () => {
  const { release, calls } = rig({ forwardedLog: true });
  await release({ "mkt-1": { kind: "job", portJobId: "job-1", done: {} } }, board);
  await release({ "mkt-2": { kind: "publish", portJobId: "job-1", done: { deliver: 1 } } }, board);
  await release(tasks(), [{ ...board[0], status: "hired" }]);
  assert.equal(calls.cli.length, 0);
  assert.equal(calls.events.length, 0);
});

test("FORWARDED_TOPIC is the keccak of the event signature", () => {
  // pinned to `cast keccak "Forwarded(bytes32,address,uint256)"`
  assert.equal(FORWARDED_TOPIC, "0x7ea449a5c5193ff0f4ec38210c8fe9cee712a56dab517b2b2424351f18ac0856");
});
