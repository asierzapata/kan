# Deploying and operating Kan

Local setup is in [README.md](README.md); personal infrastructure access and MCP
client setup are in [docs/MCP.md](docs/MCP.md).

## Application topology

The collaborative app runs as one Docker Compose project (`docker-compose.yml`):

```text
Cloudflare Tunnel -> VM Traefik :80 -> server :8787 (API, sockets, SPA, scheduler)
                                      |
                                      +-> eve :3000 (internal only)
State: local persistent volumes + Neon Postgres + private Cloudflare R2
```

Use one live server instance. Room ownership is in memory with a local SQLite
hot store; increasing replicas is unsupported. Deployments briefly disconnect
sockets. Use a VM with Docker/Compose; the current installation is Debian on
Proxmox. The separate Dokploy panel controls the VM through SSH.

## Production configuration

Set variables in Dokploy's compose **Environment** tab, never in Git. Treat
staging as a separate compose project with its own URL, database/branch, bucket,
secrets and volumes. `KAN_ENV=staging` enables the narrowly scoped recovery QA
fixture, so don't point staging tests at production data.

| Variable | Requirement |
| --- | --- |
| `KAN_PUBLIC_URL` | Exact browser origin, e.g. `https://app.getkan.dev`, no trailing slash. Controls cookies, sockets and write-origin validation. |
| `KAN_SERVICE_SECRET` | Shared server/eve bearer secret. Generate with `openssl rand -hex 32`. |
| `BETTER_AUTH_SECRET` | Session secret, at least 32 chars; `openssl rand -base64 32`. Rotation signs users out. |
| `DATABASE_URL` | Production Postgres/Neon connection string. Keep it off laptops unless needed for an authorized operation. |
| `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | Private R2 bucket, account S3 endpoint, region `auto`, bucket-scoped credentials and path-style flag. |
| `KAN_ENV` | Compose defaults to `production`. PGlite/disk assets are only for local development. |
| `KAN_RUN_CEILING` | Required in production: stored-run count limit; `0` means unlimited. This is not a dollar budget. |
| `KAN_CONTEXT_RUN_CAP` | Optional context-run cap (default 20). |
| `AI_GATEWAY_API_KEY` | Required for actual AI turns. |
| `WORKFLOW_POSTGRES_URL` | Optional eve workflow store, supplied at build AND runtime. Changing it requires a rebuild and separate workflow-table bootstrap. |
| `VITE_TLDRAW_LICENSE_KEY` | SPA build argument. Required for a working hosted canvas; changing it requires rebuilding the server image. |

Compose fixes `EVE_URL`, `WEB_API_URL`, `KAN_DATA_DIR` and `PORT`. Don't override
those in the panel. Keep eve unpublished; only the server receives a public
route. The local overlay explicitly selects development storage and browser
origin http://localhost:8787. `npm run stack:up` applies it for laptop use.

## Deployment procedure

1. Merge/push reviewed code to **main**, wait for **Repository checks** to pass,
   and record the intended Git commit SHA.
2. Run `npm run mcp:check` with your own Dokploy key. Confirm the `Kan` project,
   `kan` compose service, source branch, compose path and latest deployment status.
   If this times out, resolve panel/network access before attempting a deploy.
3. In Dokploy, configure the service's Git source as
   `https://github.com/asierzapata/kan.git`, branch **main**, compose path
   `./docker-compose.yml`. Check environment/build arguments before deploying.
   The last recorded setup used `single-server`; changing the repo does not
   change that panel setting. Verify it explicitly rather than assuming main
   pushes are already live.
4. Deploy staging first when available. In the compose **Deployments** tab, wait
   for both images to build and the deployment to finish. **Logs** shows runtime
   output for each service. Check both service health statuses.
5. Verify `/healthz` on the app origin returns `{"ok":true}`. Sign in, create a
   disposable canvas, edit, wait for sync and reload. Use a second authorized
   member/browser for bidirectional sync. If agent configuration changed, send a
   small real prompt and verify completion and its persisted canvas result.
   A health probe or successful image build does not establish model inference.
6. Deploy production from the same reviewed revision/configuration, then repeat
   health and browser checks. Record the deployed revision and observed checks.

The current service uses a plain Git source. A push does not imply a deployment;
inspect the service's webhook/auto-deploy configuration. Don't paste its private
webhook URL or socket tickets into issues or chat. Apply environment edits with a
redeploy; changes to build arguments need a rebuild.

With the current tunnel arrangement, Dokploy **Domains** routes the hostname to
service `server`, port `8787`, with HTTPS off on that internal route. Cloudflare's
public hostname targets the VM's Traefik port 80; TLS terminates at Cloudflare.
Do not copy that internal HTTP setting to a direct-public deployment.

## Instance inventory

These are last-recorded identifiers to locate resources, not live health claims.
Recheck with your own access before acting; private IPs require the team's LAN
or an owner-provided VPN route.

| Resource | Last recorded value |
| --- | --- |
| Panel | https://dokploy.asierzapata.com |
| Project / service | `Kan` / `kan`, app name `kan-se2scu` |
| VM | `kan-prod`, Debian, `192.168.1.75`, SSH user `kan` |
| App origin | https://app.getkan.dev |
| Tunnel route | `app.getkan.dev` -> `http://192.168.1.75:80` |
| Neon | Project `kan-prod`, `aws-eu-central-1`; databases `kan`, `kan_workflow` |
| R2 | Private bucket `kan-prod-assets` (WEUR) |
| Volumes | `kan-data` for server state, `eve-data` for local workflow state (Compose prefixes actual names) |

The last recorded workflow setup uses the eve volume; `WORKFLOW_POSTGRES_URL`
was unset. Don't switch storage worlds without planning workflow-state recovery.
At the 17 October repository check, the MCP initialized but panel API requests
timed out. Live branch configuration and deployment access therefore still need
verification from a reachable network. See the diagnostics in [docs/MCP.md](docs/MCP.md).

## Rollback

Keep the previous working commit SHA and configuration before a deployment.
If the new release fails, stop it and select the previous reviewed Git revision
in the service's source settings (or a temporary branch pinned to that commit),
then deploy one instance and repeat health/browser checks. Use Dokploy's rollback
only after checking which image/revision it restores. Don't assume it rolls back
secrets, database migrations or volumes.

Migrations are additive: don't delete migration rows or restore an old database
just to match older application code. If a migration is incompatible with an old
release, fix forward or execute a separately planned restore. Never delete
`kan-data`/`eve-data` as a routine deployment repair.

## Backup and recovery

Canvas-level operator exports:

```sh
npm run backup:canvas -- <canvasId> /absolute/private/canvas.json
npm run restore:canvas -- /absolute/private/canvas.json <targetWorkspaceId>
```

These load root `.env.local`. For a Postgres operation, set `DATABASE_URL` in a
private environment; for local PGlite, stop the local server first and use an
absolute `KAN_DATA_DIR`. Restore requires an existing target workspace and a
canvas ID that is not already present. Files contain private canvas/chat data;
keep them outside the checkout and don't upload them into reviews.

A canvas export is not a complete disaster-recovery backup. Back up:

- Postgres data and auth/membership tables using the database provider's backup
  and restore controls; verify retention/recovery window on the actual plan.
- R2 object bytes as well as asset metadata; use a retained object backup/copy
  policy and verify objects can be restored. Local development assets live in
  the server data directory instead.
- The eve workflow volume (or separately configured workflow database). The
  application database does not contain all workflow execution state.
- Deployment configuration and secrets in the team's approved secret manager.

For a consistent volume backup, stop writes/server/agent and back up the stopped
volumes. Copying an active SQLite file without its WAL is not a consistent
backup. After loss of the server's local hot store, rooms reseed from Postgres;
unflushed SQLite changes are not guaranteed to survive disk loss.

Test restoration into an isolated deployment with separate volumes/URLs/secrets.
Verify login, membership, canvas contents, image downloads and workflow behavior
before any production cutover. Keep the old system stopped for active-passive
recovery: two live nodes against the same canvases are unsupported. Backup and
restore commands are covered by isolated server tests; an actual infrastructure
restore still needs an operator rehearsal.

## Marketing site

The landing site uses root `vercel.ts`, `.vercelignore`, `apps/site` and
`api/waitlist.js`. It is independent of the application's Dokploy service.
Vercel project/team membership is a separate invitation. Configure server-only
`GOOGLE_SHEETS_WEBHOOK_URL` and `WAITLIST_WEBHOOK_SECRET` for the waitlist;
`VITE_*` values are public browser build inputs.

Use `npm run test -w @kan/site` and `npm run build -w @kan/site`, preview and
verify the waitlist before publishing. The site's DMG is
`apps/site/public/kan-alpha.dmg`, served at `/kan-alpha.dmg`; native release and
Google Apps Script procedures are in [AGENTS.md](AGENTS.md). Old app deployment
configuration should not replace this active site configuration.
