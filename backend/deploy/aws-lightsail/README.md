# Prime Port on AWS Lightsail

The production container runs on a dedicated Lightsail instance. Caddy owns
ports 80/443 and proxies to the backend bound only to `127.0.0.1:7860`.
Application state is persisted under `/var/lib/prime-port`. Encrypted instance
snapshots are the production backup; the legacy `STATE_REMOTE` git mirror is
not the primary store.

The deployment is deliberately staged:

1. Start with `ENABLE_MARKETPLACE_WATCHER=0`,
   `ENABLE_A2A_RESPONDER=0`, and `ENABLE_GENLAYER_RELAYER=0`.
2. Verify HTTPS, persistent state, `/health`, MCP initialization, and the OKX
   `x402-check`.
3. Enable only the A2A responder for public agent #5982 and verify a real
   conversation.
4. After the GenLayer judge and X Layer escrow are deployed, configure their
   addresses, start the escrow watcher and relayer, and run tiny live tests.
5. Change the web and OKX endpoints only after a restart-preservation test.

The old shared marketplace settlement watcher stays off. Exactly one A2A
responder may be active for public agent `5982`.
