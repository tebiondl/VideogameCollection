#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

compose() {
  docker compose -f docker-compose.yml -f docker-compose.mcp.yml --profile mcp "$@"
}

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose is not available. Install the Docker Compose plugin first." >&2
  exit 1
fi

if [ ! -f data/integrations/read.token ] || [ ! -f data/integrations/write.token ]; then
  echo "The MCP token files are missing under data/integrations/. Follow deploy/cloudflare-tunnel/README.md first." >&2
  exit 1
fi

if ! docker compose -f docker-compose.yml ps --status running --services backend | grep -qx backend; then
  echo "The collection backend is not running. Start the normal app before enabling remote MCP access." >&2
  exit 1
fi

echo "Starting the read and write MCP endpoints..."
compose up -d --build --no-deps mcp-read mcp-write

# A bad hostname, Access audience, or token makes the server exit immediately.
# Give it a moment so this command can report that configuration failure.
sleep 2
running_services=$(compose ps --status running --services mcp-read mcp-write)
if ! printf '%s\n' "$running_services" | grep -qx mcp-read || \
   ! printf '%s\n' "$running_services" | grep -qx mcp-write; then
  echo "One or more MCP endpoints failed to start. Recent logs:" >&2
  compose logs --tail=60 mcp-read mcp-write >&2
  exit 1
fi

compose ps mcp-read mcp-write
echo "Remote MCP access is on. Run $ROOT_DIR/tools/mcp-down.sh when you finish."
