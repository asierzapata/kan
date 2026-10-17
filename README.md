# Kan

Kan is a collaborative canvas with a shared chat and an AI assistant. The web app
is the main collaborative product. The Tauri desktop app remains available for
offline canvases and local ACP agents; its renderers and UI are also used by the
web app. The marketing site is a separate Vercel deployment.

## First checkout

Use Git, **Node 24** and **npm 11.6.0**. With nvm installed:

```sh
git clone https://github.com/asierzapata/kan.git
cd kan
nvm install
nvm use
npm install --global npm@11.6.0
npm ci
cp .env.example .env.local
npm run dev:stack
```

Run commands from the repository root. On Windows use WSL2 for the shell/Docker
workflow; native Windows development has not been verified. Node is pinned in
`.nvmrc`; `packageManager` and `engines` record the npm requirement. Check
`node --version` and `npm --version` if install reports engine warnings.

Open **http://localhost:1430**, choose **Create account**, then create a workspace
and a canvas. Local accounts/data are independent of the hosted app. Workspace
owners can use **Members & invites** to create a recipient-bound invitation link;
share it with the teammate manually. No invitation email is sent automatically.

No cloud database, object store or deployment access is needed locally. The
server initializes PGlite, SQLite rooms and disk assets under `data/server`.
The example secrets are only for local development. Set `AI_GATEWAY_API_KEY` in
`.env.local` to enable AI turns; sign-up and canvas editing work without it.
A running agent process alone does not establish working model credentials.
Optional publishable map/logo keys and the tldraw license are explained in
`.env.example`. Never commit environment files or put private keys in `VITE_*`.

`dev:stack` starts these processes together; Ctrl+C stops the stack. To run them
individually, use separate terminals:

| Process | Command | Readiness |
| --- | --- | --- |
| Backend | `npm run dev:server` | http://localhost:8787/healthz returns `{"ok":true}` |
| Web | `npm run dev:web` | http://localhost:1430 returns the app |
| Agent | `npm run dev:agent` | http://localhost:3100/eve/v1/health returns HTTP 200 |

Ports are fixed. Inspect the process logs if startup fails; do not stop another
developer's process to free a port. Use `localhost` consistently for the browser
origin and cookies. Changing the browser origin also requires matching
`KAN_PUBLIC_URL` and Vite proxy configuration.

## Pulling updates

Commit or set aside your own work first. From a clean checkout on main:

```sh
git switch main
git pull --ff-only
nvm use
npm ci
npm run typecheck
```

Keep your existing `.env.local`: compare `.env.example` for new variable names
and add them without overwriting personal credentials. Restart the stack after
pulling. Database migrations run automatically on server startup and are additive.
Keep `data/server`; resetting it deletes your local accounts and canvases. Local
hooks are installed by `npm ci`; CI runs independently on every PR and main push.

## Verify changes

```sh
npm run typecheck
npm test                         # server, desktop components, web-core
npx turbo run test               # also desktop helpers and marketing-site tests
npm run test:repo                # shared-source cache invalidation and hook scope
npm run check:docs
npm run build
npx agent-browser install        # once per machine; Linux CI uses --with-deps
npm run test:smoke
```

The smoke test starts its own server/web processes on **8787/1430** and refuses
occupied ports. Stop your dev stack first. It uses a temporary database and an
isolated browser session, signs up, creates a workspace/canvas, adds a node,
waits for persistence, reloads and checks the result. It cleans its processes and
data and writes a screenshot to the OS temp directory (`kan-smoke.png`). It does
not call a paid AI provider. See the [e2e guide](.agents/skills/e2e/SKILL.md) for
manual browser/sync checks and native regression commands in [AGENTS.md](AGENTS.md).

Turbo tracks shared desktop/server sources and root env files as inputs. The
agent build is deliberately uncached because eve keeps build and runtime files
under `.eve/`. Do not delete or cache that directory indiscriminately.

## Other local targets

- **Containers:** install Docker with Compose v2+, copy/configure `.env.local`,
  then `npm run stack:up`. Open http://localhost:8787. Use `npm run stack:logs`
  and `npm run stack:down`. Named volumes preserve data across stops; avoid
  `down -v` unless you intend to delete local container data. Container data and
  the source dev server's `data/server` are independent.
- **Desktop:** install Rust and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/),
  then `npm run tauri dev`. `npm run dev` alone serves the desktop frontend on
  1420 and does not provide native IPC. Native releases/QA are maintained on
  macOS; see [AGENTS.md](AGENTS.md) for signing, WebDriver and release procedures.
- **Marketing site:** `npm run dev -w @kan/site` on http://localhost:1421.
  Its waitlist requires separate server-side Google Sheets credentials in
  production. See [deployment](DEPLOY.md#marketing-site).

## Repository map and operations

| Directory | Purpose |
| --- | --- |
| `apps/web` | Collaborative Vite/React browser app |
| `apps/server` | Hono HTTP API, Better Auth, WebSocket rooms, scheduler and assets |
| `apps/web-agent` | Self-hosted eve agent and canvas tools |
| `apps/desktop` | Offline Tauri app and shared UI/renderers/tool contracts |
| `apps/site`, `api/waitlist.js` | Marketing site and Vercel waitlist handler |
| `packages/protocol`, `packages/nodes`, `packages/web-core` | Shared contracts, schemas and persistence |
| `scripts` | Development, QA, backup and MCP helpers |

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the current system,
[DEPLOY.md](DEPLOY.md) for deployment/recovery, and
[docs/MCP.md](docs/MCP.md) for personal access, Codex/Claude/Cursor setup and a
read-only deployment check. Your teammates need their own service invitations
and credentials; cloning the repo does not copy anyone's MCP connections.
