# Kan web

Browser client for shared Kan canvases: a plain Vite SPA (React 19, TanStack
Router with file-based routes, Tailwind). It imports the desktop theme, panel/chat
primitives, rich renderers, node contracts and editor tools from `apps/desktop`
without modifying desktop source. All backend behaviour lives in `apps/server`.

Use Node 24 and the repository's npm workspaces.

## Develop

Run the server and the SPA side by side, then open http://localhost:1430:

- `npm run dev -w @kan/server` (port 8787; embedded PGlite and local disk assets
  under `data/server` when `DATABASE_URL` and `S3_BUCKET` are unset)
- `npm run dev -w @kan/web` (port 1430, strict port). Vite proxies `/api` and the
  `/sync` WebSocket to the server.

Server variables come from the environment or the repository's root `.env.local`
(see below). Other commands: `npm run typecheck -w @kan/web`,
`npm run build -w @kan/web`, `npm run test -w @kan/server`, `npm run test:web`.

## Production

`vite build` writes `apps/web/dist`. `apps/server` serves it (static assets plus
an SPA fallback for every non-`/api`, non-`/sync` GET) from `KAN_WEB_DIST`, so one
Node process serves the app, API, sync sockets, assets and scheduler. Until a
bundle exists the server answers `503 Web bundle not built`. `VITE_*` variables
(including the publishable `VITE_TLDRAW_LICENSE_KEY`) are read from the root
`.env.local` at build time.

## Access and assets

Better Auth (email + password, no email verification) authenticates users inside the server; the browser uses its client against `/api/auth/*`; PostgreSQL memberships authorize workspace
and canvas access. Owner manages invitations and members; editor writes; viewer
reads. Invitations are recipient-bound links (no email delivery), with hashed
tokens and seven-day expiry. Canvas deletion is a soft delete. HTTP handlers
enforce `Origin` (must equal `KAN_PUBLIC_URL`) on writes.

Session rows are checked server-side, with a bounded 30-second active-session cache. Room tickets admit new connections for one minute; admitted
sockets remain connected and the scheduler re-evaluates each socket's role and
session every 30 seconds, closing it on any change. Agent writes check
canvas membership and the active run row before every commit, fencing revoked
writers and cancelled or replaced runs.

PNG/JPEG/WebP/GIF uploads go through the authenticated server to S3-compatible
storage (or local disk in development). Client and server limit raw files to
**4 MiB**. Signatures are checked. Asset URLs (`/api/assets?id=…`) are
authenticated application URLs scoped by canvas ownership; bytes have
private/no-store caching and `nosniff`. Image sources inside canvas records must
be `https://` URLs or an asset id owned by that canvas; the server drops other
sources from sync pushes and rejects them from agent tools. Failed metadata
insertion can leave an unreferenced object; lifecycle reconciliation remains a
hardening gap.

## Canvas and agent

The browser uses tldraw sync, native shape utils and all eight desktop rich-node
renderers. Local camera/selection/draft state remains viewer-local.

Each open canvas is a tldraw `TLSocketRoom` on `apps/server` over a local SQLite
store, which acknowledges edits synchronously. Edits are written behind to
PostgreSQL (Neon in production, PGlite in development) as record-level events,
debounced and serialized per room, retried with backoff on failure. `revision` is
tldraw's document clock. A room restored on a fresh disk is rebuilt from
PostgreSQL. Agent tool calls run inside the same per-room queue and always write
a receipt event, even when nothing changed.

PostgreSQL owns threads, messages, run state and queueing; eve owns execution
sessions. Runs serialize per canvas. The in-process scheduler dispatches queued
runs shortly after a request, re-arms while work is pending and sweeps for stuck
canvases every minute, independently of browser polling. HTTP observation streams
scoped eve events and polls history. A disconnect does not cancel execution.

Explicit retry is author-only, editor-only and limited to twice. Saved mutation
receipts and retry limits are checked before resetting the old eve session. A
run that saved changes cannot be blindly replayed; inspect the canvas and submit
a contextual request. Ambiguous dispatch is never automatically resent. If a
parked dispatch has no started turn after five minutes, it becomes a visible
failure eligible for explicit reconciliation/retry. Cancellation preserves edits
already committed. The run ceiling (`KAN_RUN_CEILING`) is a stored-run count, not
a dollar budget; agent session limits are set in `apps/web-agent`.

Undo reverts a finished turn (complete, failed or cancelled) once, editor-only.
It removes only records the turn created whose live document still matches what
the turn committed, plus the bindings and children that depend on them. Created
records a person changed afterwards, records the turn merely updated (such as
human-authored nodes), and agent records that human-created records depend on are
left alone and reported. The turn's saved receipts stay in place, so a reverted
turn still cannot be blindly retried.

## Server environment

Names only; see `apps/server/src/config.ts` for validation. The server loads the
repository's root `.env.local` without overriding variables already set.

| Variable | Purpose |
| --- | --- |
| `PORT` | Listen port (default `8787`). |
| `KAN_DATA_DIR` | Local state: `rooms.sqlite`, `pglite/`, `assets/` (default `data/server`). |
| `DATABASE_URL` | PostgreSQL. Unset uses embedded PGlite under `KAN_DATA_DIR`. |
| `KAN_ENV` | `development` (default), `staging` or `production`; the `arm-recovery` fixture works only in `staging`. |
| `KAN_SERVICE_SECRET` | Shared bearer secret (≥16 chars) for socket tickets and the agent's `/api/web/internal` calls. |
| `KAN_PUBLIC_URL` | Browser origin (default `http://localhost:1430`); sets the OAuth redirect, cookie `Secure`, sync URL and write-origin check. |
| `BETTER_AUTH_SECRET` | Signs Better Auth sessions (≥32 chars; `openssl rand -base64 32`). Accounts are email + password, stored in the `user`/`session`/`account`/`verification` tables of the `kan_web_v1` schema. |
| `EVE_URL` | Agent runtime base URL. Required outside development; unset in development fails queued runs with `server.agent_unconfigured`. |
| `KAN_RUN_CEILING` | Maximum runs stored per database; `0` means unlimited. Defaults to `20` outside production; required when `KAN_ENV=production`. |
| `KAN_CONTEXT_RUN_CAP` | Automatic meeting-context runs per meeting before it pauses (`0` unlimited, default `20`). |
| `KAN_WEB_DIST` | Built SPA directory (default `apps/web/dist`). |
| `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | Asset storage. Unset bucket uses local disk in development and is an error elsewhere. |

## Backup and restore

`node scripts/web/backup.mjs <canvasId> <out.json>` writes one canvas (records,
events, threads, runs, messages, assets and meeting data) with mode 0600.
`node scripts/web/restore.mjs <in.json> <workspaceId>` imports it into a database
where that canvas does not exist yet. Both need `DATABASE_URL`, print row counts
only, and are operator tools. Backup exports include asset metadata but not
object bytes.

See [WEB_MIGRATION.md](../../WEB_MIGRATION.md) for earlier acceptance evidence.
Browser tests do not establish Tauri/native coverage. Live meetings, video and
transcription belong to phase 2.
