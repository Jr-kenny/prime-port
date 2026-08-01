# Prime Port backend, one container: port-service + mcp-server behind a
# single public port (index.mjs). Built for Hugging Face Spaces (docker sdk,
# app_port 7860) but nothing here is HF-specific.
#
# Build context is backend/ — the commitment module and both services ride in.
FROM node:22-bookworm-slim

# git is for state-sync (mirror repo push/pull); ca-certificates for TLS;
# curl fetches the onchainos CLI.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git git-lfs ca-certificates curl python3 python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && git lfs install --system

# The OKX marketplace CLI. The watcher shells out to it; wallet login happens
# at boot via OKX_API_KEY/OKX_SECRET_KEY/OKX_PASSPHRASE (AK login), so no
# interactive step and no session imported from anywhere.
ARG ONCHAINOS_VERSION=v4.4.1
RUN curl -fsSL -o /usr/local/bin/onchainos \
      "https://github.com/okx/onchainos-skills/releases/download/${ONCHAINOS_VERSION}/onchainos-x86_64-unknown-linux-gnu" \
 && curl -fsSL -o /tmp/checksums.txt \
      "https://github.com/okx/onchainos-skills/releases/download/${ONCHAINOS_VERSION}/checksums.txt" \
 && cd /usr/local/bin \
 && grep "onchainos-x86_64-unknown-linux-gnu" /tmp/checksums.txt | sed "s|onchainos-x86_64-unknown-linux-gnu|onchainos|" | sha256sum -c - \
 && chmod +x /usr/local/bin/onchainos \
 && rm /tmp/checksums.txt

# OKX A2A receives marketplace conversations over XMTP. Hermes is its
# server-side responder and uses the configured Hermes inference provider.
ARG HERMES_VERSION=v2026.7.7.2
ARG OKX_A2A_VERSION=0.1.10
RUN npm config set fetch-retries 5 \
 && npm config set fetch-retry-mintimeout 20000 \
 && npm config set fetch-retry-maxtimeout 120000 \
 && npm install -g @okxweb3/a2a-node@${OKX_A2A_VERSION} \
 && python3 -m venv /opt/hermes \
 && git config --global http.version HTTP/1.1 \
 && for attempt in 1 2 3 4 5; do \
      if /opt/hermes/bin/pip install --no-cache-dir --timeout 120 \
        "git+https://github.com/NousResearch/hermes-agent.git@${HERMES_VERSION}"; then \
        break; \
      fi; \
      if [ "$attempt" -eq 5 ]; then exit 1; fi; \
      sleep "$((attempt * 5))"; \
    done \
 && ln -s /opt/hermes/bin/hermes /usr/local/bin/hermes \
 && plugin_work="$(mktemp -d)" \
 && npm pack "@okxweb3/a2a-hermes@${OKX_A2A_VERSION}" --pack-destination "$plugin_work" \
 && tar -xzf "$plugin_work"/okxweb3-a2a-hermes-*.tgz -C "$plugin_work" \
 && tar -xzf "$plugin_work"/package/dist/okx-a2a-hermes-plugin-*.tar.gz -C "$plugin_work" \
 && mkdir -p /app/hermes \
 && HERMES_HOME=/app/hermes bash "$plugin_work"/okx-a2a-hermes-plugin/scripts/install-or-upgrade.sh \
      --target /app/hermes/plugins/platforms/okx-a2a \
 && HERMES_HOME=/app/hermes hermes version \
 && okx-a2a --version \
 && onchainos --version \
 && rm -rf "$plugin_work"

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
COPY mcp-server/server.mjs mcp-server/escrow.mjs mcp-server/escrow-watcher.mjs mcp-server/x402-request.mjs mcp-server/
COPY genlayer-relayer/relayer.mjs genlayer-relayer/core.mjs genlayer-relayer/
COPY distribution/poster.mjs distribution/select.mjs distribution/
COPY distribution/channels/oauth1.mjs distribution/channels/telegram.mjs distribution/channels/x.mjs distribution/channels/
COPY marketplace-watcher/watcher.mjs marketplace-watcher/wage-release.mjs marketplace-watcher/task-routing.mjs marketplace-watcher/
COPY payout/register-at-hire.mjs payout/
COPY index.mjs public-routing.mjs state-sync.mjs listing-price.mjs brief-policy.mjs settlement-routing.mjs ./

# Spaces runs the container unprivileged; everything the process writes
# (data dirs, state mirror) lives under /app, so hand it to the node user.
RUN chown -R node:node /app
USER node
ENV NODE_ENV=production APP_PORT=7860 HOME=/app HERMES_HOME=/app/hermes OKX_AGENT_TASK_HOME=/app/okx-agent-task OKX_A2A_AI_CWD=/app/a2a-workspace

EXPOSE 7860
CMD ["node", "index.mjs"]
