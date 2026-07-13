// The release watcher: second payout worker (issue #24). When a job task's
// escrow releases, the wage lands as claimable ASP rewards at OKX; this
// module walks it the rest of the way: claim -> approve -> deposit into the
// JobForwarder under the commitment hash -> forward to the freelancer.
//
// The ASP wallet signs everything through `onchainos wallet contract-call`
// (the wallet is OKX-managed, its key never exists on our side), and gas is
// OKB on X Layer. Zero dependencies: calldata for the four fixed call shapes
// is hand-encoded with selectors precomputed via `cast sig`.
//
// One step per job per poll cycle, and every decision is re-derived from the
// chain, never from local memory: the Forwarded event log says "done", the
// forwarder's per-job balance says "deposited, push it out", the wallet's
// USDT balance and allowance say what comes next. A crash at any point
// resumes exactly where the chain says we are. The one guard the chain can't
// give us is a deposit tx that's still in flight (its balance isn't visible
// yet), so the deposit tx is remembered and checked before ever depositing
// again: deposit is the single non-idempotent step, and paying a wage twice
// is the one mistake this module exists to make impossible.
export const SEL = {
  approve: "0x095ea7b3", // approve(address,uint256)
  deposit: "0x1de26e16", // deposit(bytes32,uint256)
  forward: "0x41977d5f", // forward(bytes32)
  jobBalance: "0x6c7f1542", // balanceOf(bytes32) on the forwarder
  erc20Balance: "0x70a08231", // balanceOf(address) on USDT
  allowance: "0xdd62ed3e", // allowance(address,address)
};
// keccak256("Forwarded(bytes32,address,uint256)")
export const FORWARDED_TOPIC = "0x7ea449a5c5193ff0f4ec38210c8fe9cee712a56dab517b2b2424351f18ac0856";

export const pad = (word) => String(word).replace(/^0x/, "").toLowerCase().padStart(64, "0");
export const enc = (selector, ...words) => selector + words.map(pad).join("");

// USDT units (6 decimals) from a commitment price string ("48", "39.5").
// Exact string arithmetic: floats never touch money.
export const usdtUnits = (price) => {
  const [whole, frac = ""] = price.split(".");
  return BigInt(whole + frac.padEnd(6, "0").slice(0, 6));
};

// How many cycles to trust an in-flight deposit whose tx hash we couldn't
// learn from the CLI reply before assuming it never landed and retrying.
const DEPOSIT_PATIENCE = 10;

export function createWageRelease({ cli, emit, agentId, rpcUrl, forwarder, usdt, chainId = "196", log = console }) {
  const rpc = async (method, params) => {
    const r = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const j = await r.json();
    if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
    return j.result;
  };
  const ethCall = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
  const contractCall = (to, inputData) =>
    cli(["wallet", "contract-call", "--to", to, "--chain", chainId, "--input-data", inputData, "--force"]);

  let aspAddr;
  const aspWallet = async () =>
    (aspAddr ??= (await cli(["wallet", "addresses"])).data.xlayer[0].address.toLowerCase());

  // Decide and perform the single next step for one job's wage. Returns the
  // step name for the event trail.
  async function step(rec, job) {
    const hash = job.pendingHire.hash;
    const units = usdtUnits(job.pendingHire.commitment.terms.price);

    // Done? The Forwarded event is the definitive receipt.
    const forwardedLogs = await rpc("eth_getLogs", [
      { address: forwarder, fromBlock: "0x0", toBlock: "latest", topics: [FORWARDED_TOPIC, hash] },
    ]);
    if (forwardedLogs.length > 0) {
      rec.forwarded = Date.now();
      rec.forwardTx = forwardedLogs[0].transactionHash;
      delete rec.depositTx;
      delete rec.depositWaits;
      emit("wage-forwarded", { portJobId: job.jobId, commitmentHash: hash, tx: rec.forwardTx });
      log.log(`[watcher] wage forwarded for ${job.jobId} (tx ${rec.forwardTx})`);
      return "forwarded";
    }

    // Deposited but not pushed out? Forward is permissionless and pays the
    // registered address in full; nothing to get wrong.
    const jobBal = BigInt(await ethCall(forwarder, enc(SEL.jobBalance, hash)));
    if (jobBal > 0n) {
      await contractCall(forwarder, enc(SEL.forward, hash));
      return "forward-sent";
    }

    // A deposit is in flight: never send another until this one is
    // conclusively dead. Real hash -> ask the chain; no hash -> bounded wait.
    if (rec.depositTx) {
      if (/^0x[0-9a-f]{64}$/i.test(rec.depositTx)) {
        const tx = rec.depositTx;
        const receipt = await rpc("eth_getTransactionReceipt", [tx]);
        if (!receipt) return "deposit-pending";
        delete rec.depositTx;
        if (receipt.status !== "0x1") log.error(`[watcher] deposit ${tx} reverted, retrying from scratch`);
        return "deposit-settled"; // success shows up as jobBalance next cycle
      }
      rec.depositWaits = (rec.depositWaits ?? 0) + 1;
      if (rec.depositWaits < DEPOSIT_PATIENCE) return "deposit-pending";
      delete rec.depositTx;
      delete rec.depositWaits;
      log.error(`[watcher] deposit for ${job.jobId} never surfaced after ${DEPOSIT_PATIENCE} cycles, retrying`);
    }

    // Money in the ASP wallet yet? If not, pull claimable rewards and wait.
    const wallet = await aspWallet();
    const balance = BigInt(await ethCall(usdt, enc(SEL.erc20Balance, wallet)));
    if (balance < units) {
      try {
        await cli(["agent", "asp-claim-rewards", "--agent-id", agentId]);
        emit("wage-claim-attempted", { portJobId: job.jobId });
      } catch (e) {
        log.log(`[watcher] nothing claimable yet for ${job.jobId}: ${e.message.split("\n")[0]}`);
      }
      return "awaiting-funds";
    }

    // Exact-amount approval, then deposit. Approving only the committed
    // price keeps the forwarder's pull power as small as the deal itself.
    const allowance = BigInt(await ethCall(usdt, enc(SEL.allowance, wallet, forwarder)));
    if (allowance < units) {
      await contractCall(usdt, enc(SEL.approve, forwarder, units.toString(16)));
      return "approve-sent";
    }

    const result = await contractCall(forwarder, enc(SEL.deposit, hash, units.toString(16)));
    rec.depositTx = result?.data?.txHash ?? result?.data?.hash ?? "sent";
    emit("wage-deposited", { portJobId: job.jobId, commitmentHash: hash, units: units.toString(), tx: rec.depositTx });
    return "deposit-sent";
  }

  // Jobs are due once our side settled (agent approved, port archived) and
  // the job task's deliverable went in. From there the money-driven state
  // machine simply waits for escrow to actually release.
  return async function releaseWages(tasks, boardJobs) {
    for (const [mktJobId, rec] of Object.entries(tasks)) {
      if (rec.kind !== "job" || !rec.portJobId || rec.forwarded || !rec.done?.deliver) continue;
      const job = boardJobs.find?.((j) => j.jobId === rec.portJobId);
      if (!job || job.status !== "settled" || !job.pendingHire?.hash) continue;
      try {
        const did = await step(rec, job);
        if (did !== "forwarded") emit("wage-step", { jobId: mktJobId, portJobId: job.jobId, step: did });
      } catch (e) {
        emit("wage-release-failed", { jobId: mktJobId, portJobId: rec.portJobId, error: e.message });
        log.error(`[watcher] wage release for ${rec.portJobId} failed: ${e.message.split("\n")[0]}`);
      }
    }
  };
}
