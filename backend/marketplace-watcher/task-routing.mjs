export function taskBelongsToAgent(task, agentId) {
  return String(task?.myAgentId ?? task?.providerAgentId ?? "") === String(agentId ?? "");
}

export function isX402Task(task) {
  return Number(task?.paymentMode) === 3 || String(task?.paymentMode ?? "").toLowerCase() === "x402";
}
