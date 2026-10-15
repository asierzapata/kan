# Deploying Kan

Kan runs as one Docker Compose project (`docker-compose.yml`: `server` + `eve`),
deployed with [Dokploy](https://dokploy.asierzapata.com) onto a Debian VM.

## Topology

```
 Dokploy panel (control plane, home server)
        │  SSH (remote server)
        ▼
 kan-prod VM (Proxmox, Debian; Docker + Traefik installed by Dokploy)
   ├─ server  :8787  API, /sync sockets, SPA, scheduler, SQLite hot store (/data)
   └─ eve     :3000  agent (internal only, no published port)
        ▲
 Cloudflare Tunnel public hostname ──► VM Traefik :80   (TLS ends at Cloudflare)

 Off-box: Neon Postgres (DATABASE_URL, optionally WORKFLOW_POSTGRES_URL)
          Cloudflare R2   (S3_*)
```

- Use a **VM, not an LXC**: Docker in LXC needs nesting and keyctl and misbehaves.
- One stateful process per deployment: every deploy drops open `/sync` sockets
  briefly and clients reconnect.

## Environment variables

Set these on the compose service (Dokploy → Environment). Secrets never go in git.

| Variable                                                                                                   | Required   | Source / notes                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `KAN_PUBLIC_URL`                                                                                           | yes        | The public origin, exactly (e.g. `https://kan.example.com`, no trailing slash). Better Auth and the write-origin check compare against it.      |
| `KAN_SERVICE_SECRET`                                                                                       | yes        | `openssl rand -hex 32`. Shared by `server` and `eve`.                                                                                           |
| `BETTER_AUTH_SECRET`                                                                                       | yes        | `openssl rand -base64 32`. Changing it signs everyone out.                                                                                      |
| `KAN_ENV`                                                                                                  | no         | Defaults to `production`, which makes `S3_BUCKET` and `KAN_RUN_CEILING` mandatory.                                                              |
| `DATABASE_URL`                                                                                             | yes (prod) | Neon connection string. Unset falls back to embedded PGlite (development only).                                                                 |
| `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | yes (prod) | R2: bucket, `https://<account>.r2.cloudflarestorage.com`, region `auto`, an API token's key pair.                                               |
| `KAN_RUN_CEILING`                                                                                          | yes (prod) | Max stored agent runs; `0` is unlimited.                                                                                                        |
| `KAN_CONTEXT_RUN_CAP`                                                                                      | no         | Automatic meeting-context runs per meeting (default 20).                                                                                        |
| `AI_GATEWAY_API_KEY`                                                                                       | yes        | Vercel AI Gateway key for agent turns.                                                                                                          |
| `WORKFLOW_POSTGRES_URL`                                                                                    | no         | Durable agent state in Postgres. A **build arg and a runtime var**: the workflow world is baked at `eve build`, so changing it needs a rebuild. |
| `VITE_TLDRAW_LICENSE_KEY`                                                                                  | no         | Build arg for the SPA (baked into the bundle). Rebuild to change.                                                                               |

Fixed by the compose file, do not set: `EVE_URL`, `WEB_API_URL`, `KAN_DATA_DIR`, `PORT`.

## Deploying and day-to-day (UI)

1. Dokploy → Projects → your project → the compose service → **Deploy**.
2. **Deployments** tab: build logs for each deploy. **Logs** tab: running container
   logs per service (`server`, `eve`).
3. **Environment** tab: edit variables, then **redeploy** (variables are read at
   container start; build args need a rebuild).
4. **Domains** tab: point the hostname at service `server`, port `8787`, HTTPS
   **off** (the tunnel terminates TLS), and add the same hostname as a Cloudflare
   Tunnel public hostname targeting the VM's Traefik on `http://<vm>:80`.

Concrete instance (TODO, fill in after the first deploy):

| Item                      | Value |
| ------------------------- | ----- |
| Dokploy server            | TODO  |
| Project / compose service | TODO  |
| Public domain             | TODO  |
| Tunnel name               | TODO  |

## Operating it from an AI tool (MCP)

`scripts/dokploy-mcp.mjs` starts the official `@dokploy/mcp` (pinned) against the
panel, with a per-user key.

1. Dokploy → Settings → API Keys → create your own key.
2. Put `DOKPLOY_API_KEY=...` in the root `.env.local` (never in a client config or chat).
3. Register it:
   - **Devin**: already configured in `.devin/mcp_config.json`.
   - **Claude Code**: `claude mcp add dokploy -- node scripts/dokploy-mcp.mjs` (from the repo root).
   - **Cursor**: `.cursor/mcp.json`:
     ```json
     {
       "mcpServers": {
         "dokploy": { "command": "node", "args": ["scripts/dokploy-mcp.mjs"] }
       }
     }
     ```

The full Dokploy API is 500+ tools, so the script loads only the tags
`project,environment,server,compose,domain,deployment,docker` (about 105 tools; no
database or notification management). Override with `DOKPLOY_ENABLED_TAGS` and
`DOKPLOY_URL` in `.env.local`.

Example prompts: "redeploy kan and tail the build log", "show the last 100 lines of
the server container", "list the variables set on the kan compose service".

Keep `DOKPLOY_REDACT_ENV` at its default: the MCP then hides environment values from
tool output. Never paste API keys into chat.

## Scaling

Not supported beyond one live node. Horizontal scaling needs canvas-affine routing
of `/sync` and `/api/web/*` plus a lease on the canvas checked by the write-behind
flush. Redundancy is active-passive: a second VM, stopped, with state off-box in
Neon and R2. See "Web backend" in `AGENTS.md`.
