# Prime Port backend, one container: port-service, mcp-server and the
# distribution poster in one process (index.mjs) behind one public port.
# The GenLayer dispute relayer is an optional child process.
#
# Build context is backend/.
FROM node:22-bookworm-slim

# git is for state-sync (mirror repo push/pull); ca-certificates for TLS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git git-lfs ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git lfs install --system

WORKDIR /app

COPY commitment/package.json commitment/package-lock.json commitment/
COPY port-service/package.json port-service/package-lock.json port-service/
COPY mcp-server/package.json mcp-server/package-lock.json mcp-server/
COPY genlayer-relayer/package.json genlayer-relayer/package-lock.json genlayer-relayer/
COPY payout/package.json payout/package-lock.json payout/
RUN cd commitment && npm ci --omit=dev \
 && cd ../port-service && npm ci --omit=dev \
 && cd ../mcp-server && npm ci --omit=dev \
 && cd ../genlayer-relayer && npm ci --omit=dev \
 && cd ../payout && npm ci --omit=dev

COPY commitment/commitment.mjs commitment/
COPY port-service/service.mjs port-service/
COPY mcp-server/server.mjs mcp-server/escrow.mjs mcp-server/escrow-watcher.mjs \
     mcp-server/candidates.mjs mcp-server/inbox.mjs mcp-server/native-payment.mjs mcp-server/
COPY genlayer-relayer/relayer.mjs genlayer-relayer/core.mjs genlayer-relayer/
COPY distribution/poster.mjs distribution/select.mjs distribution/
COPY distribution/channels/oauth1.mjs distribution/channels/telegram.mjs distribution/channels/x.mjs distribution/channels/
COPY payout/register-at-hire.mjs payout/
COPY index.mjs public-routing.mjs state-sync.mjs ./

# Spaces runs the container unprivileged; everything the process writes
# (data dirs, state mirror) lives under /app, so hand it to the node user.
RUN chown -R node:node /app
USER node
ENV NODE_ENV=production APP_PORT=7860 HOME=/app

EXPOSE 7860
CMD ["node", "index.mjs"]
