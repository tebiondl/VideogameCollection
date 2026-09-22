# VideogameCollection

For protected remote access to the production collection, see the
[Cloudflare Tunnel setup guide](deploy/cloudflare-tunnel/README.md). To connect
Codex from another computer, use the
[Codex client connection runbook](deploy/cloudflare-tunnel/CODEX_CLIENT.md).

## On-demand remote MCP access

The remote read and write MCP containers are intentionally off by default. On
the production host, from any directory, enable both endpoints with:

```bash
/root/VideogameCollection/tools/mcp-up.sh
```

When the remote session is finished, stop and remove both MCP containers with:

```bash
/root/VideogameCollection/tools/mcp-down.sh
```

The production repository is installed at `/root/VideogameCollection`.
These commands affect only `mcp-read` and `mcp-write`; the web application,
database, scheduled jobs, and shared Cloudflare tunnel remain running. Because
the MCP containers have no automatic restart policy, they also stay off after a
host reboot. Full setup and troubleshooting are covered in the
[Cloudflare Tunnel guide](deploy/cloudflare-tunnel/README.md).
