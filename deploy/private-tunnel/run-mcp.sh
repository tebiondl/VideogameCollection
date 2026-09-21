#!/bin/sh
set -eu
mode=${1:-read}
case "$mode" in
  read|write) ;;
  *) echo 'Usage: run-mcp.sh read|write' >&2; exit 2 ;;
esac
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
# Stdout is reserved for MCP JSON-RPC. Never add banners or echo secrets here.
exec docker compose --project-directory "$repo_dir" \
  -f "$repo_dir/docker-compose.yml" -f "$repo_dir/docker-compose.mcp.yml" \
  run --rm --no-deps -T "mcp-$mode"
