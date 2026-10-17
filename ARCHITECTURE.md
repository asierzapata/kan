# Current architecture

Kan has three runnable products: a collaborative web app, an offline desktop app,
and a marketing site. This document describes the maintained code; retired
room-server/agent-runner designs and September demo plans remain in Git history.
Start with [README.md](README.md) for local setup and [DEPLOY.md](DEPLOY.md) for
operations.

## Collaborative web app

```text
Browser (apps/web, React + Vite)
  | HTTP /api/auth, /api/web, /api/assets; WebSocket /sync
  v
Node 24 (apps/server, Hono + ws)
  |-- Better Auth -> user/session/account/verification tables
  |-- rooms -> local SQLite hot store -> write-behind Postgres
  |-- catalog, memberships, threads, runs, receipts -> Postgres
  |-- assets -> local disk (dev) or private S3/R2 (hosted)
  |-- scheduler -> self-hosted eve (apps/web-agent)
  |                  | AI Gateway model inference
  |                  + authenticated canvas tool calls back to the server
  +-- serves built apps/web/dist in production
```

Development uses embedded PGlite instead of a separate Postgres service. Local
state defaults to root `data/server`; Docker uses a persistent `/data` volume.
The web Vite server on 1430 proxies API and socket requests to the Node server
on 8787. Production is one Compose project: `server` and internal-only `eve`.

### Authentication and authorization

Better Auth owns email/password accounts and sessions. Workspace memberships
carry owner/editor/viewer roles; invitations are recipient-bound links with
expiry, not automatic email delivery. HTTP writes require the configured browser
Origin. Room tickets authenticate socket upgrades; the scheduler rechecks
sessions and roles. Agent tool writes validate membership and the active run.
There is no WorkOS or installation-secret authentication in the web app.

### Room persistence

Each loaded canvas has a tldraw `TLSocketRoom` over synchronous
`SQLiteSyncStorage` in `rooms.sqlite` (WAL). SQLite acknowledges sync changes
before the debounced Postgres write-behind, which serializes per room and retries
failures. A new local store reseeds from Postgres; an up-to-date local store is
reused. Idle rooms flush and are evicted. The revision is tldraw's document clock.

Agent calls share the room queue: authorize actor/run, flush pending human edits,
check expected revision, plan and apply the change, then write a labeled durable
receipt. Identical retries use operation receipts. Cancellation preserves edits
already committed; retry/undo policy is described in [apps/web/README.md](apps/web/README.md).

**Exactly one live server process per deployment.** Rooms live in memory and local
SQLite. Shared Postgres does not make multiple active authorities safe. Supported
redundancy is active-passive; do not scale replicas or overlap deployment instances.

### Assets and database schema

Assets are scoped to a canvas, limited to supported image formats and 4 MiB.
Records accept HTTPS sources or owned application asset IDs. The Node server
serves authenticated asset URLs. R2 remains private; development stores bytes on
disk. Database exports include metadata rather than object bytes.

`packages/web-core` owns the additive `kan_web_v1` migrations, persistence/hash
helpers and canvas export/import. Append migrations; never rewrite applied files.
`apps/server` owns auth, scheduling, rooms, authorization and API behavior.

### Agent execution

The server dispatches queued runs to the self-hosted eve channel using
`KAN_SERVICE_SECRET`. Only bounded canvas/context tools are exposed; tool calls
return to `/api/web/internal` with the same secret. The agent uses AI Gateway;
web users do not connect a local subscription provider. Eve workflow state uses
a local persistent volume by default. Optional Postgres workflow storage is a
build-time and runtime choice; see [agent configuration](apps/web-agent/README.md).
A health probe verifies process readiness, not successful provider inference.

## Offline desktop app

`apps/desktop` is a Tauri 2 shell around React/tldraw. It stores offline canvases
locally and uses Rust ACP clients for local Devin or Codex agents. These child
processes use the user's own subscription or a supplied API key; the desktop
canvas tool layer is exposed through a scoped loopback MCP bridge during a turn.
The desktop is not an online room client. Native credentials, QA and release
procedures are in [AGENTS.md](AGENTS.md).

The web app imports desktop UI, styles, renderers and canvas tools. The server
and web agent import desktop node contracts. Consequently the desktop directory
is active shared source: don't remove it just because web is the main target.
Turbo's inputs, hook scope and CI cover these dependencies. Moving them into
shared packages would be a separate refactor.

## Marketing site and checks

`apps/site` is a static Vite site. Root `vercel.ts` selects its build, and
`api/waitlist.js` is the separate server-side Vercel waitlist function. The
published DMG remains a tracked site asset. This stack is independent of the
Dokploy-hosted application and still needs its Vercel configuration.

CI checks every PR and main push: documentation links, repository regressions,
all typechecks/tests/builds, Compose interpolation and a real browser smoke flow.
Server suites use HTTP, WebSockets, PGlite and actual auth. They don't prove paid
model inference, native Tauri behavior, hosted infrastructure or disaster recovery.
Live audio/video capture and automatic transcription are not part of the current
web product; meeting notes are manually supplied.
