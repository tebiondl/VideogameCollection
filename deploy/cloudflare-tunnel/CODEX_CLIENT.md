# Connect Codex to the remote collection MCP

Use this runbook on the computer where Codex will use the collection. The MCP
server is already deployed behind Cloudflare Access. Do not install
`cloudflared`, copy collection credentials, or configure a bearer token on the
client computer.

The endpoints are normally switched off. Before connecting from this computer,
run the following single command on the production host:

```bash
/root/VideogameCollection/tools/mcp-up.sh
```

After the remote session, run `/root/VideogameCollection/tools/mcp-down.sh` on
the production host so the MCP containers release their resources again.

## Prompt to give Codex

> Connect this Codex installation to my two remote Streamable HTTP MCP servers.
> Add the read server as `game-collection-read` using
> `https://collection-read.epicidad.com/mcp` and the write server as
> `game-collection-write` using
> `https://collection-write.epicidad.com/mcp`. Authenticate both with OAuth,
> letting me complete the Cloudflare browser login. Verify both connections by
> calling `collection_access`. Confirm that the read server reports `read` mode
> and has no mutation tools, and that the write server reports `write` mode.
> Do not make a production mutation during verification. Never request or store
> a Cloudflare tunnel token or collection token.

## Codex CLI setup

Run these commands on the client computer:

```bash
codex mcp add game-collection-read \
  --url https://collection-read.epicidad.com/mcp
codex mcp login game-collection-read

codex mcp add game-collection-write \
  --url https://collection-write.epicidad.com/mcp
codex mcp login game-collection-write

codex mcp list
```

Each login opens Cloudflare Access in a browser. Sign in with the email address
allowed by the Access policy. The OAuth credentials stay on the client computer.

In the Codex terminal UI, enter `/mcp` to confirm that both servers are enabled.

## Codex desktop app or IDE extension

1. Open **Settings > MCP servers**.
2. Select **Add server**.
3. Choose **Streamable HTTP**.
4. Add `game-collection-read` with
   `https://collection-read.epicidad.com/mcp`.
5. Save, restart when prompted, and select **Authenticate**.
6. Complete the Cloudflare login in the browser.
7. Repeat with `game-collection-write` and
   `https://collection-write.epicidad.com/mcp`.

## Verify without changing production data

Ask Codex:

> Use `game-collection-read` and call `collection_access`. Report the username
> and mode, then list five videogames. Confirm that mutation tools are absent.

The expected account is `TebionDL` in `read` mode.

Then ask:

> Use `game-collection-write` and call `collection_access`. Report the username
> and mode and confirm that the mutation tools are available. Do not create,
> update, delete, or move any record.

The expected account is `TebionDL` in `write` mode.

Use the read server for searches and shopping tasks. Use the write server only
when an explicit collection change is required.

## Troubleshooting

- Use the exact URLs above, including `/mcp`.
- If both endpoints are unreachable, confirm that `tools/mcp-up.sh` was run on
  the production host; they are intentionally unavailable while switched off.
- An unauthenticated HTTP request returning `401` is expected; the MCP client
  must complete OAuth.
- If Cloudflare denies login, authenticate with the exact email allowed by the
  Access policy.
- Run `codex mcp list` or use `/mcp` to inspect connection status.
- Retry authentication with `codex mcp login game-collection-read` or
  `codex mcp login game-collection-write`.
- Do not add static authorization headers, tunnel tokens, or collection tokens.
