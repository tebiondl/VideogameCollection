# Private collection MCP on Proxmox

This adds a stdio MCP adapter to the existing Docker Compose deployment. It has
no listening port. `tunnel-client` launches the adapter locally and carries MCP
messages through an outbound HTTPS connection to OpenAI. Run it in the VM/LXC
that hosts the app, not on the Proxmox management host.

```text
ChatGPT / Codex -> OpenAI private tunnel -> tunnel-client in your VM/LXC
                                          -> stdio MCP container
                                          -> restricted backend API -> PROD data
```

The read connection exposes collection search, detail, schema and options tools.
The separate write connection adds create, partial update, delete and move-copy-
to-history tools. Supported records: videogames (including copies, old copies,
DLCs and tags), wanted games, board games, board-game players and matches.
Server administration, global configuration, account credentials, backup files
and backup operations are deliberately unavailable. Tools cannot run SQL, shell
commands, fetch arbitrary URLs, or call arbitrary API routes.

## 1. Deploy the app changes and build the adapter

Use the repository on your app host. Examples assume `/opt/VideogameCollection`;
adjust paths in the environment files and service unit if yours differs.

```bash
cd /opt/VideogameCollection
docker compose up -d --build backend frontend
docker compose -f docker-compose.yml -f docker-compose.mcp.yml build mcp-read mcp-write
```

The backend creates the integration token/audit tables on startup. Login now uses
a generated signing key persisted beside the database (or `AUTH_SECRET_KEY`),
and tokens last seven days by default. **Existing browser sessions must sign in
again after this upgrade.** Keep `.auth-signing.key` in the persistent data volume;
`ACCESS_TOKEN_EXPIRE_DAYS` may be configured from 1 to 90.

The frontend proxy denies `/api/integration/*`; the adapter accesses the backend
on the internal Docker network. Do not forward backend port 8000 from your router.
The existing Compose file still publishes that port for local access; if nothing
else uses it, change its mapping to `127.0.0.1:8000:8000` on your deployment host.
No new ports, public DNS or router port forwarding are required for MCP.

## 2. Create dedicated collection credentials

Replace `YOUR_APP_USERNAME` with the existing account whose collection to use.
This is your collection username, not your OpenAI username. Credentials are
generated into private files and never printed. Only their hashes are stored in
the database. The MCP containers mount only their own token, not the data or backups.

```bash
docker compose exec backend python -m app.integration_tokens create \
  --username YOUR_APP_USERNAME --name chatgpt-shopping --mode read --days 90 \
  --output /app/data/integrations/read.token

docker compose exec backend python -m app.integration_tokens create \
  --username YOUR_APP_USERNAME --name codex-editing --mode write --days 90 \
  --output /app/data/integrations/write.token

docker compose exec backend python -m app.integration_tokens list
```

The files must not already exist; the command refuses to overwrite credentials.
Read access is enforced in the backend even if a read token is used with the write
adapter. Both tokens are rejected by the normal app API, including every backup
route, even when their owner is an administrator. Browser login tokens cannot
authenticate to the integration API. Each integration can access only its owner's data.

## 3. Configure OpenAI's private tunnel

Open [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels).
Create separate tunnels for shopping and editing, associated with the ChatGPT
workspace/Platform organization that will use them. The operator needs Tunnels
Read + Manage to create tunnels and Read + Use to run/connect them. Account and
workspace availability must be checked in your account.

Download the Linux `tunnel-client` binary for your host's architecture from the
download link in those settings or the
[official latest release](https://github.com/openai/tunnel-client/releases/latest).
Follow its release verification/install instructions and install it at
`/usr/local/bin/tunnel-client`. Then run:

```bash
tunnel-client --version
tunnel-client help quickstart
```

Create a **runtime** OpenAI API key with tunnel access using your account settings.
Do not use an admin key for the running service. This key belongs to the tunnel
client; it is different from the collection tokens and is never passed to the MCP
container. Do not paste any of these keys into a chat or commit them to Git.

Copy the supplied `read.env.example` and `write.env.example` to
`/etc/videogame-collection/tunnel-read.env` and `tunnel-write.env`. Replace the
tunnel IDs, runtime key and repository paths using a local editor. Protect the
directory with mode 700 and the files with mode 600. Keep the distinct loopback
health ports in the examples.

To test the read connection in a foreground shell on the app host:

```bash
set -a
. /etc/videogame-collection/tunnel-read.env
set +a
tunnel-client doctor --explain
tunnel-client run
```

Leave it running while adding the connection. Stop it before starting the systemd
service below. **Only one tunnel-client instance per tunnel ID may run at a time
for this stdio setup.** Repeat with the write configuration when needed.

## 4. Keep the tunnel running after reboot

The included `vgc-tunnel@.service` uses a dedicated `vgc-tunnel` OS account with
Docker access. Create that account on the application VM/LXC if needed:

```bash
sudo useradd --system --create-home --home-dir /var/lib/vgc-tunnel --groups docker vgc-tunnel
sudo install -m 644 deploy/private-tunnel/vgc-tunnel@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now vgc-tunnel@read
sudo systemctl status vgc-tunnel@read
```

Ensure that this account can read the repository and that its Docker CLI can
access the app's Docker daemon. Docker group membership grants host-level Docker
control; keep that permission inside the app VM/LXC. The MCP container itself has
no Docker socket or host administration tools. Adjust the service for rootless
Docker rather than granting access to a different daemon.

Enable `vgc-tunnel@write` separately for the editing connection. Check
`http://127.0.0.1:8781/readyz` (read) and `http://127.0.0.1:8782/readyz` (write),
and the local `/ui`, to verify the tunnel is ready. Outbound HTTPS to OpenAI and
the app's internal Docker networking must be available. This does not require a
publicly exposed management UI.

## 5. Attach and verify in ChatGPT/Codex

Enable Developer mode in the account's settings where available. Add a personal
MCP connection/plugin, choose **Tunnel**, and select the read tunnel. Name it
`Game collection — shopping`. Add the write tunnel separately as
`Game collection — editing`. Attach only the appropriate connection to each task.
Availability and exact menus depend on the product/account; follow the
[official connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt).

First ask: “Use collection_access and tell me the connected username and access
mode.” Then try:

> Find games I rated at least 8/10 where I have no Nintendo Switch copy. Check
> which have Switch releases and search for physical copies available in Spain.

The query checks all current copies before pagination and sorts by personal
rating. Old copies do not count as ownership. For games missing a *physical*
Switch copy, supply `missing_format="Physical"`; omit it to exclude any current
Switch ownership. Use `collection_options` to check exact platform names. The MCP
supplies collection data; store searches use the assistant's separate web tools.

For editing, ask to read one record first and make a specific change. Updates and
deletions require the exact `revision` returned by the read. A concurrent change
returns a conflict instead of overwriting it. Partial updates preserve omitted
fields; supplied arrays replace the entire array. Changes and their audit record
are committed together. Deletion follows existing app semantics, including
preserving board-game matches and suppressing deleted Steam copies.

## Revoke, rotate, or stop access

```bash
docker compose exec backend python -m app.integration_tokens list
docker compose exec backend python -m app.integration_tokens revoke TOKEN_ID
sudo systemctl stop vgc-tunnel@write
```

Revocation and expiry are checked on every API request. To rotate a credential,
stop its tunnel, revoke the old token, move its file to a private archive or remove
it, then create a fresh token at the same output path and restart the tunnel. The
fresh container mounts the new file. Tokens expire after 90 days in these examples.
No automatic renewal is configured. Never share the editing tunnel with a
workspace/account that should only have shopping access: tunnel access grants the
capabilities of the collection credential assigned to that tunnel.

Audit rows are stored in `integration_audit` (token ID, operation, resource, record
ID, prior data and requested changes). Inspect them locally as the operator; token
secrets and runtime OpenAI keys are never audit fields.

## Development checks

```bash
backend/.venv/bin/python -m unittest backend.tests.test_integration
uv sync --directory mcp_server --frozen
mcp_server/.venv/bin/python -m unittest discover -s mcp_server/tests
docker compose -f docker-compose.yml -f docker-compose.mcp.yml config --quiet
```

These tests use isolated SQLite and mocked HTTP. Running tests does not contact
PROD or create an OpenAI tunnel. A real deployment still requires credentials,
tunnel IDs, account access and an end-to-end connection test on your host.

References: [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels),
[tunnel-client](https://github.com/openai/tunnel-client),
[MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk).
