# Remote collection MCP through a general Cloudflare Tunnel

To connect Codex from another computer after deployment, give it
[`CODEX_CLIENT.md`](CODEX_CLIENT.md). That runbook contains the exact remote
URLs, OAuth login commands, and read-only verification prompts.

This deployment uses your normal `cloudflared` tunnel. It is not tied to OpenAI:
any remote MCP client that supports Streamable HTTP and OAuth can connect. The
same tunnel may continue routing your other applications.

```text
MCP client -> HTTPS + Cloudflare Access -> existing cloudflared tunnel
                                          -> 127.0.0.1:8765 (read MCP)
                                          -> 127.0.0.1:8766 (write MCP)
                                          -> restricted API -> PROD data
```

Only the two MCP services are published. The backend integration API remains on
the Docker network, and backup routes are absent from the MCP and integration API.
The read and write endpoints use separate collection credentials and separate
Cloudflare Access applications, so shopping access does not imply edit access.

## 1. Deploy and create the collection credentials

Run this in the VM/LXC that hosts the app (not on the Proxmox management host).
Examples use `/opt/VideogameCollection`; adjust the path for your installation.

```bash
cd /opt/VideogameCollection
git pull --ff-only origin master
docker compose up -d --build backend frontend

docker compose exec backend python -m app.integration_tokens create \
  --username YOUR_APP_USERNAME --name remote-shopping --mode read --days 90 \
  --output /app/data/integrations/read.token

docker compose exec backend python -m app.integration_tokens create \
  --username YOUR_APP_USERNAME --name remote-editing --mode write --days 90 \
  --output /app/data/integrations/write.token
```

The output files contain secrets and are ignored by Git. The database stores only
their hashes. Each credential is limited to one collection owner, expires, can be
revoked, and cannot authenticate to normal app or backup routes.

This release persists the app's login signing key and changes browser sessions to
seven days. Existing browser sessions must sign in again after the first upgrade.

## 2. Add two hostnames to the existing tunnel

Choose two hostnames on a domain managed by Cloudflare, for example:

```text
games-read.example.com  -> http://127.0.0.1:8765
games-write.example.com -> http://127.0.0.1:8766
```

For a remotely managed tunnel, open **Cloudflare dashboard > Networking >
Tunnels**, select your existing tunnel, and add both **Published application**
routes with those service URLs.

For a locally managed tunnel, merge these entries into the existing `ingress`
list before its final catch-all rule:

```yaml
ingress:
  # Keep your existing routes here.
  - hostname: games-read.example.com
    service: http://127.0.0.1:8765
  - hostname: games-write.example.com
    service: http://127.0.0.1:8766
  - service: http_status:404
```

Do not create a second tunnel. Validate and restart the existing one:

```bash
cloudflared tunnel ingress validate
cloudflared tunnel ingress rule https://games-read.example.com/mcp
sudo systemctl restart cloudflared
```

The MCP ports bind only to loopback. Do not forward them on your router. If
`cloudflared` runs in a container rather than on the host, route it to the host
gateway or attach it to the Compose network and use `http://mcp-read:8000` and
`http://mcp-write:8000` instead.

## 3. Protect each hostname with Cloudflare Access

In **Zero Trust > Access controls > Applications**, create a self-hosted Access
application for each hostname. Give the read application the people/identity
providers allowed to search the collection. Use a narrower policy for the write
application. Enable **Managed OAuth** under each application's advanced settings.

Copy these values from Cloudflare:

- Your team domain, such as `my-team.cloudflareaccess.com`.
- The read application's **Application Audience (AUD) Tag**.
- The write application's **Application Audience (AUD) Tag**.

Create `.env` beside the Compose files on the app host:

```dotenv
CLOUDFLARE_ACCESS_TEAM_DOMAIN=my-team.cloudflareaccess.com
CLOUDFLARE_ACCESS_READ_AUD=read-application-audience-tag
CLOUDFLARE_ACCESS_WRITE_AUD=write-application-audience-tag
MCP_READ_HOSTNAME=games-read.example.com
MCP_WRITE_HOSTNAME=games-write.example.com
MCP_READ_PORT=8765
MCP_WRITE_PORT=8766
```

The origin validates the signed `Cf-Access-Jwt-Assertion`, including its issuer,
signature, expiry, and the endpoint-specific audience. A copied header, a token
for another Access application, or a direct request to the origin is rejected.

## 4. Start and stop the endpoints on demand

The MCP containers do not start with the normal application and do not restart
after a host reboot. Leave them off until remote collection access is needed.
The helper can be called from any directory because it resolves the repository
root itself:

```bash
/opt/VideogameCollection/tools/mcp-up.sh
```

Optional verification and logs:

```bash
cd /opt/VideogameCollection

curl --fail http://127.0.0.1:8765/healthz
curl -i http://127.0.0.1:8765/mcp
docker compose -f docker-compose.yml -f docker-compose.mcp.yml logs --tail=100 mcp-read mcp-write
```

The health request returns `ok`. The direct `/mcp` request must return `401`
because it did not pass Cloudflare Access. Opening either public hostname should
prompt for the identity allowed by its Access policy.

Connect an OAuth-capable MCP client to one of these exact URLs:

```text
https://games-read.example.com/mcp
https://games-write.example.com/mcp
```

For ChatGPT/Codex, add the read URL as `Game collection - shopping` and the write
URL as `Game collection - editing`. Complete the Cloudflare login when prompted.
Other clients use the same standard URL and OAuth flow.

First call `collection_access` and confirm the expected username and mode. A useful
shopping request is: "List games rated at least 8 where I have no physical Nintendo
Switch copy, then search the web for copies sold in Spain." Old copies do not count
as current ownership. Store searches use the client's separate web access.

Writes require the exact revision from a fresh read. Concurrent changes return a
conflict instead of overwriting data. Create, update, delete and copy-history moves
are audited in the database.

When the remote session is over, turn both endpoints off with one command:

```bash
/opt/VideogameCollection/tools/mcp-down.sh
```

This stops and removes only the `mcp-read` and `mcp-write` containers, releasing
their memory and CPU. It does not stop the web app, backend, database, scheduled
jobs, or the existing shared `cloudflared` service. The public MCP hostnames will
be unavailable until `tools/mcp-up.sh` is run again.

## Revoke or rotate access

```bash
docker compose exec backend python -m app.integration_tokens list
docker compose exec backend python -m app.integration_tokens revoke TOKEN_ID
docker compose -f docker-compose.yml -f docker-compose.mcp.yml stop mcp-write
```

To rotate a token, stop that MCP service, revoke the old token, remove its token
file, create a replacement at the same path, and restart the service. Disable or
delete the corresponding Cloudflare Access application to stop remote OAuth access.

## Development checks

```bash
backend/.venv/bin/python -m unittest backend.tests.test_integration
uv sync --directory mcp_server --frozen
mcp_server/.venv/bin/python -m unittest discover -s mcp_server/tests
docker compose -f docker-compose.yml -f docker-compose.mcp.yml config --quiet
```

Tests use isolated SQLite and mocked HTTP. They do not contact PROD or Cloudflare.
