#!/usr/bin/env bash
set -euo pipefail

dnf install -y docker
systemctl enable --now docker

install -d -m 0700 /etc/prime-port
install -d -m 0755 /opt/prime-port
install -d -m 0700 \
  /var/lib/prime-port/onchainos \
  /var/lib/prime-port/okx-agent-task \
  /var/lib/prime-port/port-service-data \
  /var/lib/prime-port/mcp-server-data \
  /var/lib/prime-port/genlayer-relayer-data \
  /var/lib/prime-port/distribution-data \
  /var/lib/prime-port/marketplace-watcher-data \
  /var/lib/prime-port/payout-data \
  /var/lib/prime-port/caddy-data \
  /var/lib/prime-port/caddy-config

docker pull ghcr.io/jr-kenny/prime-port:latest
docker pull caddy:2.10-alpine
