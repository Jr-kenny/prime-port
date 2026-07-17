export function taskBelongsToAgent(task, agentId) {
  return String(task?.myAgentId ?? "") === String(agentId ?? "");
}

export function isX402Task(task) {
  return Number(task?.paymentMode) === 3 || String(task?.paymentMode ?? "").toLowerCase() === "x402";
}
