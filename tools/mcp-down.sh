#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose is not available. Install the Docker Compose plugin first." >&2
  exit 1
fi

echo "Stopping and removing the read and write MCP endpoints..."
docker compose -f docker-compose.yml -f docker-compose.mcp.yml --profile mcp \
  rm --stop --force mcp-read mcp-write
echo "Remote MCP access is off. The collection app and shared Cloudflare tunnel are still running."
