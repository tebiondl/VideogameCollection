# Codex deployment runbook: production MCP through the existing Cloudflare Tunnel

Give this file to Codex running inside the VM/LXC that hosts VideogameCollection.
It is an execution runbook, not an architecture proposal. The repository already
contains the restricted production API, read/write MCP services, tests, and
Cloudflare Access JWT validation.

## Prompt to give Codex

> Deploy the repository's Cloudflare Tunnel MCP integration by following
> `deploy/cloudflare-tunnel/CODEX_DEPLOY.md` from beginning to end. Work on the
> application VM/LXC, inspect the existing installation before changing it, and
> reuse the existing `cloudflared` tunnel. Preserve every existing tunnel route.
> Do not print or paste collection token contents, tunnel credentials, API tokens,
> cookies, or JWTs. Do not expose the backend, Docker socket, token files, database,
> or backup directory. Execute all checks and continue until the local and public
> verification criteria pass. Ask me only for a value that cannot be discovered
> safely: collection username, two unused hostnames on my Cloudflare domain,
> Cloudflare team domain, and the two Access application AUD tags. Report exactly
> what changed and any manual Cloudflare dashboard action still required.

## Required final values

Collect these without guessing:

```text
APP_DIR                 absolute repository path on this VM/LXC
COLLECTION_USERNAME     existing VideogameCollection username
MCP_READ_HOSTNAME       for example games-read.example.com
MCP_WRITE_HOSTNAME      for example games-write.example.com
CF_ACCESS_TEAM_DOMAIN   for example my-team.cloudflareaccess.com
CF_ACCESS_READ_AUD      Access application AUD for the read hostname
CF_ACCESS_WRITE_AUD     Access application AUD for the write hostname
```

The two hostnames must differ. The two Access applications should also differ so
their policies and audience claims remain independent. None of the AUD values are
collection credentials, but do not substitute placeholders for real values.
Set the resolved values in the deployment shell before running later commands:

```bash
export APP_DIR='/absolute/path/to/VideogameCollection'
export COLLECTION_USERNAME='existing-app-username'
export MCP_READ_HOSTNAME='games-read.example.com'
export MCP_WRITE_HOSTNAME='games-write.example.com'
export CF_ACCESS_TEAM_DOMAIN='my-team.cloudflareaccess.com'
export CF_ACCESS_READ_AUD='actual-read-application-aud'
export CF_ACCESS_WRITE_AUD='actual-write-application-aud'
```

## 1. Discover the deployment before changing it

Run commands from the application VM/LXC, not the Proxmox management host. Locate
the repository if the current directory is not already inside it.

```bash
pwd
git rev-parse --show-toplevel
git status --short
git remote -v
docker compose ps
cloudflared --version
systemctl status cloudflared --no-pager
systemctl cat cloudflared
ps -ef | grep '[c]loudflared'
```

Determine whether `cloudflared` is:

1. a host systemd service with a local YAML ingress configuration;
2. a host service using a remotely managed tunnel token; or
3. a container.

Record its configuration path and service arrangement. Do not display credential
JSON, tunnel tokens, environment files, or systemd environment contents. If the
working tree has unrelated changes, preserve them and stop before pulling if Git
cannot fast-forward safely.

Set `APP_DIR` to the discovered repository and update it:

```bash
cd "$APP_DIR"
git pull --ff-only origin master
git status --short
test -f docker-compose.yml
test -f docker-compose.mcp.yml
test -f deploy/cloudflare-tunnel/README.md
```

## 2. Validate the release before touching PROD

```bash
cd "$APP_DIR"
docker compose -f docker-compose.yml -f docker-compose.mcp.yml config --quiet
docker compose build backend frontend
docker compose -f docker-compose.yml -f docker-compose.mcp.yml --profile mcp \
  build mcp-read mcp-write
```

Do not continue if Compose validation or a build fails. Diagnose the failure while
leaving the currently running application in place.

## 3. Upgrade the application

```bash
cd "$APP_DIR"
docker compose up -d backend frontend
docker compose ps
docker compose logs --tail=100 backend frontend
curl --fail --silent --show-error http://127.0.0.1:8000/docs >/dev/null
```

The first deployment persists a new login signing key. Existing browser sessions
may need to sign in again. Do not remove `.auth-signing.key` or the data volume.

## 4. Create missing collection credentials

First inspect metadata and file presence. Never read the token files themselves.

```bash
cd "$APP_DIR"
docker compose exec backend python -m app.integration_tokens list
test -s data/integrations/read.token && echo 'read token file exists' || echo 'read token file is missing'
test -s data/integrations/write.token && echo 'write token file exists' || echo 'write token file is missing'
```

If both files exist and their listed integrations are active, correctly scoped,
and unexpired, reuse them. If a file is missing, create only that credential. The
command refuses to overwrite an existing file and never prints its secret.

```bash
docker compose exec backend python -m app.integration_tokens create \
  --username "$COLLECTION_USERNAME" --name remote-shopping --mode read --days 90 \
  --output /app/data/integrations/read.token

docker compose exec backend python -m app.integration_tokens create \
  --username "$COLLECTION_USERNAME" --name remote-editing --mode write --days 90 \
  --output /app/data/integrations/write.token
```

Run only the command for a missing file. Confirm the host files are not group- or
world-readable; tighten permissions when necessary:

```bash
chmod 700 data/integrations
chmod 600 data/integrations/read.token data/integrations/write.token
```

## 5. Create the Cloudflare routes and Access applications

Use the existing tunnel. Never create router port-forwarding rules.

Create these published application mappings:

```text
MCP_READ_HOSTNAME  -> http://127.0.0.1:8765
MCP_WRITE_HOSTNAME -> http://127.0.0.1:8766
```

For a remotely managed tunnel, add both routes in **Cloudflare dashboard >
Networking > Tunnels > existing tunnel > Routes > Add route > Published
application**. If Codex has an authenticated browser or an established Cloudflare
API workflow, it may perform these actions. Otherwise, ask the operator to add the
two mappings and then continue.

For a locally managed tunnel, make a timestamped backup of its YAML file. Merge
the following two rules before the existing final catch-all. Preserve all existing
rules and keep exactly one catch-all as the final rule.

```bash
export CF_CONFIG='/path/discovered/from/systemd/config.yml'
sudo cp --preserve=all "$CF_CONFIG" "$CF_CONFIG.backup.$(date -u +%Y%m%dT%H%M%SZ)"
```

```yaml
- hostname: MCP_READ_HOSTNAME
  service: http://127.0.0.1:8765
- hostname: MCP_WRITE_HOSTNAME
  service: http://127.0.0.1:8766
```

Replace the placeholder keys with the real hostnames. Validate before restarting:

```bash
cloudflared tunnel ingress validate
cloudflared tunnel ingress rule "https://$MCP_READ_HOSTNAME/mcp"
cloudflared tunnel ingress rule "https://$MCP_WRITE_HOSTNAME/mcp"
```

Each rule check must select its intended localhost service.

Create two Cloudflare Access applications, one for each hostname. In **Zero Trust
> Access controls > Applications**:

1. Create a self-hosted application for the read hostname and an allow policy for
   the identities permitted to search the collection.
2. Create a separate self-hosted application for the write hostname with a more
   restrictive allow policy.
3. Enable **Managed OAuth** in each application's advanced settings.
4. Copy each application's **Application Audience (AUD) Tag**.
5. Copy the Cloudflare Access team domain.

Do not continue with placeholder AUDs. The origin verifies the Cloudflare signing
key, issuer, expiry, subject, and endpoint-specific audience on every MCP request.

## 6. Merge the MCP values into the project `.env`

Preserve every unrelated `.env` entry. Add or replace only these keys:

```dotenv
CLOUDFLARE_ACCESS_TEAM_DOMAIN=CF_ACCESS_TEAM_DOMAIN
CLOUDFLARE_ACCESS_READ_AUD=CF_ACCESS_READ_AUD
CLOUDFLARE_ACCESS_WRITE_AUD=CF_ACCESS_WRITE_AUD
MCP_READ_HOSTNAME=MCP_READ_HOSTNAME
MCP_WRITE_HOSTNAME=MCP_WRITE_HOSTNAME
MCP_READ_PORT=8765
MCP_WRITE_PORT=8766
```

Substitute all right-hand-side placeholders with the collected values. Then ensure
the resolved Compose configuration contains the real hostnames and no `change-me`
values, without printing other environment secrets:

```bash
cd "$APP_DIR"
docker compose -f docker-compose.yml -f docker-compose.mcp.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.mcp.yml config | \
  grep -E 'MCP_PUBLIC_HOSTNAME|CLOUDFLARE_ACCESS_TEAM_DOMAIN|CLOUDFLARE_ACCESS_AUD|127.0.0.1:87(65|66)'
```

The AUD is an identifier rather than the collection secret, but avoid including
the resolved configuration in public logs.

## 7. Start the MCP services

```bash
cd "$APP_DIR"
docker compose -f docker-compose.yml -f docker-compose.mcp.yml --profile mcp \
  up -d mcp-read mcp-write
docker compose -f docker-compose.yml -f docker-compose.mcp.yml ps
docker compose -f docker-compose.yml -f docker-compose.mcp.yml logs --tail=100 mcp-read mcp-write
```

Both services must remain running. Their ports must be bound to `127.0.0.1`, not
`0.0.0.0` or a LAN address:

```bash
docker compose -f docker-compose.yml -f docker-compose.mcp.yml port mcp-read 8000
docker compose -f docker-compose.yml -f docker-compose.mcp.yml port mcp-write 8000
```

If `cloudflared` itself runs in a container, `127.0.0.1` inside that container is
not the host. Use one of these controlled arrangements and document the choice:

- run `cloudflared` with host networking on Linux and keep the localhost routes; or
- attach `cloudflared` to the application Compose network, remove the host port
  dependency, and route to `http://mcp-read:8000` / `http://mcp-write:8000`.

Do not expose the MCP ports on all interfaces as a workaround.

## 8. Restart or verify the existing tunnel

For a locally configured systemd tunnel, after ingress validation succeeds:

```bash
sudo systemctl restart cloudflared
systemctl status cloudflared --no-pager
journalctl -u cloudflared -n 100 --no-pager
```

For a remotely managed tunnel, it normally receives route updates without a local
restart. Confirm the connector is healthy in its existing logs and dashboard.

## 9. Verify security and behavior

Local health is intentionally available only through loopback. Direct MCP calls
without a valid Cloudflare assertion must fail:

```bash
curl --fail --silent --show-error http://127.0.0.1:8765/healthz
curl --fail --silent --show-error http://127.0.0.1:8766/healthz

test "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  -X POST http://127.0.0.1:8765/mcp)" = 401
test "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  -X POST http://127.0.0.1:8766/mcp)" = 401
```

Verify the public edge without following redirects or exposing returned tokens:

```bash
curl --silent --show-error --dump-header /tmp/mcp-read-headers \
  --output /dev/null "https://$MCP_READ_HOSTNAME/mcp"
curl --silent --show-error --dump-header /tmp/mcp-write-headers \
  --output /dev/null "https://$MCP_WRITE_HOSTNAME/mcp"
sed -n '1,12p' /tmp/mcp-read-headers
sed -n '1,12p' /tmp/mcp-write-headers
rm -f /tmp/mcp-read-headers /tmp/mcp-write-headers
```

An unauthenticated request should be challenged by Cloudflare Access, rather than
reach the origin as a successful MCP request. Then connect an OAuth-capable MCP
client interactively to:

```text
https://MCP_READ_HOSTNAME/mcp
https://MCP_WRITE_HOSTNAME/mcp
```

Complete the Cloudflare login. On the read endpoint:

1. Call `collection_access`; confirm the expected username and `read` mode.
2. Call `list_videogames` with a small limit.
3. Confirm mutation tools are absent.

On the write endpoint:

1. Call `collection_access`; confirm the expected username and `write` mode.
2. Confirm the four mutation tools are present.
3. Do not make a test mutation against PROD merely to prove connectivity.

Review service logs once more. They must not contain collection token values.

## Completion criteria

Deployment is complete only when all of these are true:

- the existing application and its old Cloudflare routes still work;
- `mcp-read` and `mcp-write` remain healthy/running;
- ports 8765 and 8766 are reachable only on loopback or the private Docker network;
- direct unauthenticated origin requests return 401;
- both public hostnames are protected by separate Access applications;
- Managed OAuth login completes from an MCP client;
- read access exposes no mutation tools;
- write access uses the intended collection owner;
- no backup, credential, arbitrary URL, SQL, shell, or administration tool exists;
- no secret was printed, committed, or copied into chat.

## Rollback

If the MCP deployment fails, leave the main app running and stop only the optional
services:

```bash
cd "$APP_DIR"
docker compose -f docker-compose.yml -f docker-compose.mcp.yml stop mcp-read mcp-write
```

Restore the timestamped local `cloudflared` configuration backup, validate it,
then restart `cloudflared`; or remove only the two new dashboard routes. Disable
the two new Access applications. Preserve the token files for diagnosis unless
the operator requests permanent revocation. For permanent revocation:

```bash
docker compose exec backend python -m app.integration_tokens list
docker compose exec backend python -m app.integration_tokens revoke TOKEN_ID
```

Never delete the application database, backups, auth signing key, existing tunnel,
or unrelated Cloudflare routes during rollback.
