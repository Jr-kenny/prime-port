# Prime Port backend, one container: port-service + mcp-server behind a
# single public port (index.mjs). Built for Hugging Face Spaces (docker sdk,
# app_port 7860) but nothing here is HF-specific.
#
# Build context is backend/ — the commitment module and both services ride in.
FROM node:22-bookworm-slim

# git is for state-sync (mirror repo push/pull); ca-certificates for TLS;
# curl fetches the onchainos CLI.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git git-lfs ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && git lfs install --system

# The OKX marketplace CLI. The watcher shells out to it; wallet login happens
# at boot via OKX_API_KEY/OKX_SECRET_KEY/OKX_PASSPHRASE (AK login), so no
# interactive step and no session imported from anywhere.
ARG ONCHAINOS_VERSION=v4.2.3
RUN curl -fsSL -o /usr/local/bin/onchainos \
      "https://github.com/okx/onchainos-skills/releases/download/${ONCHAINOS_VERSION}/onchainos-x86_64-unknown-linux-gnu" \
 && curl -fsSL -o /tmp/checksums.txt \
      "https://github.com/okx/onchainos-skills/releases/download/${ONCHAINOS_VERSION}/checksums.txt" \
 && cd /usr/local/bin \
 && grep "onchainos-x86_64-unknown-linux-gnu" /tmp/checksums.txt | sed "s|onchainos-x86_64-unknown-linux-gnu|onchainos|" | sha256sum -c - \
 && chmod +x /usr/local/bin/onchainos \
 && rm /tmp/checksums.txt

WORKDIR /app

COPY commitment/package.json commitment/package-lock.json commitment/
COPY port-service/package.json port-service/package-lock.json port-service/
COPY mcp-server/package.json mcp-server/package-lock.json mcp-server/
COPY payout/package.json payout/package-lock.json payout/
RUN cd commitment && npm ci --omit=dev \
 && cd ../port-service && npm ci --omit=dev \
 && cd ../mcp-server && npm ci --omit=dev \
 && cd ../payout && npm ci --omit=dev

COPY commitment/commitment.mjs commitment/
COPY port-service/service.mjs port-service/
COPY mcp-server/server.mjs mcp-server/
COPY distribution/poster.mjs distribution/select.mjs distribution/
COPY distribution/channels/oauth1.mjs distribution/channels/telegram.mjs distribution/channels/x.mjs distribution/channels/
COPY marketplace-watcher/watcher.mjs marketplace-watcher/wage-release.mjs marketplace-watcher/
COPY payout/register-at-hire.mjs payout/
COPY index.mjs state-sync.mjs ./

# Spaces runs the container unprivileged; everything the process writes
# (data dirs, state mirror) lives under /app, so hand it to the node user.
RUN chown -R node:node /app
USER node
ENV NODE_ENV=production APP_PORT=7860 HOME=/app

EXPOSE 7860
CMD ["node", "index.mjs"]
