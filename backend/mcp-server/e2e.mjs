// Kept as the package's familiar `npm run e2e` entry point. The former
// shared-ASP integration scenario depended on retired `/job-task/*` routes.
// The current deterministic scenario covers both internal X Layer escrow
// paths through the real MCP and REST handlers: direct release after revision,
// and GenLayer dispute resolution.
await import("./settlement-e2e.mjs");
