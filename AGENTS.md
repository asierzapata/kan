# Kan — agent guide

Tauri 2 desktop app. React 19 + TypeScript, Vite, TanStack Router (file-based
routes in `apps/desktop/src/routes`), tldraw for the infinite canvas, shadcn
(`base-lyra`, remixicon) for UI primitives.

## Layout

npm workspaces, orchestrated by Turborepo. Every command below runs from the
repo root; the root scripts delegate into the workspace that owns the work.

```
apps/desktop/        the Tauri app — src/, src-tauri/, index.html, vite.config.ts
apps/server/         the single Node backend: Hono + ws, Better Auth, rooms, scheduler, assets
apps/web/            the browser app (Vite SPA, served by apps/server in production)
apps/web-agent/      self-hosted eve agent that edits canvases through apps/server
packages/web-core/   persistence, migrations, backup (shared by apps/server and scripts/web)
packages/protocol/   zod wire schemas, shared
packages/nodes/      pure shared tldraw schema (renderers live in apps/desktop)
scripts/drive.mjs    WebDriver client, stays at the root
```

The desktop app owns its own `tsconfig.json`, `components.json` and frontend
dependencies. `@/*` resolves relative to `apps/desktop/tsconfig.json`, so it
kept working across the move.

`turbo.json` defines `build`, `typecheck`, `test` and `dev`. Only the first
three go through turbo (`typecheck` and `build` cover desktop, site, web, web-agent
and server; `test` covers the workspaces that define a `test` script) — they are cacheable and fan out across workspaces, and
`build` restores `dist/` from the cache rather than re-running Vite.

`dev`, `preview` and `tauri:drive` stay as direct `-w @kan/desktop` delegation
on purpose. They are persistent single-workspace tasks, so turbo caches nothing
for them, and its `@kan/desktop:` log prefix would break the `e2e` skill's
anchored `^error` grep — the wait loop would spin for its full timeout instead
of failing fast.

`packageManager` is pinned in the root `package.json`. Turbo refuses to resolve
the workspace without it.

## Git hooks

`.githooks/`, wired through `core.hooksPath` by the `prepare` script, so they
activate on `npm install` — no husky, no dependency. If your hooks aren't
firing, you haven't run `npm install` since they landed.

| Hook         | Runs                                                  | Cost      |
| ------------ | ----------------------------------------------------- | --------- |
| `pre-commit` | typecheck, **only the workspaces the commit touches** | seconds   |
| `pre-push`   | `turbo` typecheck, `turbo` tests, `turbo` build       | ~10s warm |

Both block on failure. Bypass with `git commit --no-verify` / `git push
--no-verify`, or `KAN_SKIP_HOOKS=1` for both. Use the bypass when you are
mid-refactor and know it is broken — that is what it is for.

Two things to know about them:

- **They check the working tree, not the staged snapshot.** Stashing unstaged
  work would be more correct, but more than one agent writes in this repo at
  once and a stash mid-write is how you lose someone else's work. The trade is
  that a partially-staged commit can pass the hook and still be broken.
- **`tsx --test` exits 0 when its glob matches nothing**, which reads as a pass
  and is not one. `pre-push` counts the files in `apps/server/test` first and
  warns loudly on an empty suite rather than letting it show green.

Scoping lives in `.githooks/_scope.sh` and sets two flags. `apps/desktop/*`
turns on the desktop check (`turbo` typecheck of `@kan/desktop`).
`apps/web/*`, `apps/web-agent/*`, `apps/server/*` and `packages/web-core/*` turn
on the web check, which typechecks `@kan/web`, `@kan/web-agent` and `@kan/server`.
Any other `packages/*` change, and `package.json`, `package-lock.json` or
`turbo.json`, turn on both. `pre-push` ignores scoping: it typechecks, tests and
builds every workspace through turbo.

## Commands

| Task                      | Command                                               |
| ------------------------- | ----------------------------------------------------- |
| Dev server (browser)      | `npm run dev` — serves on **port 1420**, `strictPort` |
| Dev app (Tauri window)    | `npm run tauri dev`                                   |
| Dev app + automation      | `npm run tauri:drive` — adds WebDriver on :4445       |
| Drive the running app     | `node scripts/drive.mjs <cmd>` — see the `e2e` skill  |
| Typecheck (all)           | `npm run typecheck`                                   |
| Build one workspace       | `npx turbo run build --filter=@kan/desktop`           |
| Typecheck (frontend only) | `npm run typecheck -w @kan/desktop`                   |
| Production build          | `npm run build`                                       |
| Web server (dev)          | `npm run dev:server` — **:8787**, PGlite under `data/server` |
| Web server (plain)        | `npm run server` — `tsx apps/server/src/main.ts`      |
| Web app (dev)             | `npm run dev:web` — **:1430**, proxies `/api` and `/sync` to :8787 |
| Web agent (dev)           | `npm run dev:agent` — `eve dev`, interactive          |
| Web typecheck             | `npm run typecheck:web`                               |
| Web-core tests            | `npm run test:web`                                    |
| Server tests              | `npm run test:backend` (= `npm run test -w @kan/server`) |

`tauri.conf.json` points `devUrl` at `http://localhost:1420`, so the port is
fixed — if it's taken, the dev server fails rather than picking another.

## Always e2e test features

**A feature is not done until it has been exercised end to end in a running
app.** Typecheck and `vite build` passing is not sufficient evidence that
anything works — they only prove the code compiles.

This has already failed here twice: the tldraw integration type-checked and
built cleanly while `npm run dev` crashed on startup with 53 unresolved-asset
errors; and the thread panel's accent borders and active-tab styling both
compiled fine and both rendered wrong.

**Read the `e2e` skill before verifying anything** (`.agents/skills/e2e/`). It
has the exact commands, the wait-for-ready loops, and the traps that have
already cost time. The short version:

- Default to the **driver**: `npm run tauri:drive`, wait for port 4445, then
  `node scripts/drive.mjs snapshot | eval | clickText | fill | shot`. This is
  the real WKWebView, so Tauri IPC, native menus and window behaviour are all
  in scope, and the output is structured enough to assert on.
- Use the **browser** (`npm run dev` + chrome-devtools MCP against
  `http://localhost:1420`) only for quick CSS iteration. It cannot test Tauri
  APIs, IPC, window behaviour or native plugins — say so rather than letting a
  browser pass stand in for full coverage.
- **Read the server output before continuing.** A crash appears in the log and
  nowhere else.
- Report what was actually observed. If a step was skipped, say so plainly.

## Agent runner (Devin, OpenAI)

The ACP client lives in Rust (`apps/desktop/src-tauri/src/agent.rs`), inside the
desktop app: it spawns an ACP
server, speaks JSON-RPC over stdio, and forwards `session/update` notifications
to the webview as `agent:update` events. The webview side is
`apps/desktop/src/components/agent-context.tsx` (provider + `useAgent`), the
header control is `SignInButton`, and `ChatPanel` turns a prompt turn into a
streaming `AgentEntry`.

Two providers, one protocol — the difference between them is a command line and
an env var, so everything below the launcher is shared:

| Provider | Command                                 | Subscription                                                       | API key            |
| -------- | --------------------------------------- | ------------------------------------------------------------------ | ------------------ |
| Devin    | `devin acp`                             | `devin auth login` creds, else `authenticate` with `devin-browser` | `WINDSURF_API_KEY` |
| OpenAI   | `npx -y @agentclientprotocol/codex-acp` | `authenticate` with `chat-gpt` (opens a browser)                   | `CODEX_API_KEY`    |

`Sign In` opens a submenu per provider, each offering _With Subscription_ or
_With API Key_; the key is typed into a dialog. One `agent_sign_in(provider,
mode, apiKey)` command covers all four combinations.

- Both CLIs run under the user's own subscription; the app never holds a model
  token. A typed key goes into the child's environment and has to be re-entered
  after a restart. **Kan never writes it down, but the Codex adapter does** — it
  caches whatever it authenticated with in `$CODEX_HOME/auth.json`
  (`{"auth_mode":"apikey","OPENAI_API_KEY":…}`), so `agent_sign_out` deletes that
  file when it is in api-key mode. Don't claim in UI copy that a key never
  touches the disk; it does, just not by our hand. Devin persists nothing from
  `WINDSURF_API_KEY` — verified, `credentials.toml` is untouched by a key
  sign-in.
- Exactly one provider is connected at a time. Signing into the other replaces
  the connection, and a typed key always gets a fresh child, because a child's
  environment is fixed at spawn.
- **Don't take `authMethods[0]`.** The Codex adapter advertises `api-key` first
  and `chat-gpt` second, so the first entry is the wrong one for a subscription.
  `Conn::auth_method` matches on the shape of the id and name instead.
- Devin advertises only `devin-browser` (no api-key method), so its key path
  works purely through the env var and skips `authenticate`.
- A bundled macOS app inherits a stripped PATH, so `devin` and `npx` are probed
  at `$PATH`, `~/.local/bin`, the nvm prefixes, Homebrew and `/usr/local/bin`.
  `DEVIN_BIN` and `NPX_BIN` override.
- The child's stderr is continuously drained on a dedicated thread so it cannot
  wedge the agent. Default diagnostics retain only byte counts; the optional
  five-minute detail capture keeps a bounded, redacted tail in memory, never in
  the rotating metadata log. Devin's own log file is at
  `~/.local/share/devin/cli/logs/`.
- Sessions get a scratch cwd under the app data dir, not the repo.
- A sign-in that fails is dropped from the connection slot rather than left
  there, or the next attempt would reuse the broken child and fail identically.
  A dying reader thread only reports `agent:closed` when it still owns the slot,
  so replacing a provider does not wipe the connection that replaced it.
- Sign-out kills the child and forgets the session; stored subscription
  credentials are untouched. There is no real logout: neither adapter advertises
  `agentCapabilities.auth.logout`, and clearing credentials would mean `devin
auth logout` / `codex logout` — which would log the user out of their terminal
  too.

## Canvas nodes and the tool layer (`apps/desktop/src/nodes/`)

The agent never touches tldraw directly; it goes through the tool layer.

- `schema.ts` — zod contract (`nodeDraft`, `addNodeInput`, … and `toolSchemas`).
  This is what the future MCP server exposes; keep `.describe()` on fields.
  Pure, no React/DOM imports. Will move to `packages/protocol`.
- `draft.ts` — pure `draftToShapePartial` / `shapeToSummary` mapping. Reusable
  server-side. Will move to `packages/nodes`.
- `shapes/` — tldraw `BaseBoxShapeUtil`s for `kan-markdown`, `kan-chart`,
  `kan-table`, `kan-image`, `kan-map`, and `kan-logo`, registered via
  `createKanShapeUtils()`. Interactive state that must be shared (hidden series,
  sort, selected rows, focusX, map view and selected marker) lives in shape props.
- `tools.ts` — `createCanvasTools(editor)` → `addNode`, `addMermaidDiagram`,
  `updateNode`, `removeNodes`, `connectNodes`, `arrange`, `focusNodes`,
  `groupNodes`, `getCanvas`. Every input is zod-parsed first.
- In dev, `window.__kan = { editor, tools }` and `window.__kanErrors` exist.
  There is no node demo palette, node scenario runner, or automatic canvas
  seeding; nodes remain available through the tool layer. Existing local canvas data is
  preserved; the thread conversation simulator is gone. Drive tools with
  `node scripts/drive.mjs eval 'window.__kan.tools.getCanvas()'`.

The rich node tools currently operate on offline desktop canvases; they are
not wired into a server-side tool layer or a shared `kan-node` wire schema.
The local Devin ACP path is wired to those offline tools through a loopback
`kan-canvas` MCP bridge. The bridge is exposed only during an active prompt on
the current offline canvas, validates every request with the same zod schemas,
and approves only correlated canvas tool calls; filesystem and terminal calls
remain denied. Offline canvases register both renderers (`lib/canvas-shapes.tsx`
and `createKanShapeUtils()`), preserve initial records, and reuse
`CanvasProvider`. The web app's server-side tools live in
`apps/server/src/planner.ts`.
Run `node scripts/canvas-tools.e2e.mjs` for tool-layer coverage. It cleans its
own canvas and restores the original page. Do not drive concurrently. The old
`local-agent.e2e.mjs` drove the deleted conversation simulator and went with it;
real local-agent coverage now goes through the chat composer.

Keys: `apps/desktop/src/lib/config.ts` zod-parses `VITE_MAPTILER_KEY` and
`VITE_BRANDFETCH_CLIENT_ID` from the root `.env.local` (see `.env.example`).
Vite's `envDir` keeps that location stable after the workspace move. Both are
optional — the map falls back to MapLibre demo tiles, the logo to a favicon.
`VITE_*` vars are embedded in the frontend bundle, so only publishable keys
belong there (the Brandfetch _client id_ is publishable; its API key is not).
`kan-logo` is deliberately chromeless (no `NodeCard`), aspect-locked, and
`addNode({ near })` overlaps it on the near shape's top-right corner
(`placementByType` in `draft.ts`). The map disables MapLibre's own `dragPan`
and `scrollZoom` and forwards pointer/wheel gestures itself, otherwise tldraw's
transformed layer breaks them.

Pointer model inside a node: the `HTMLContainer` has `pointerEvents: all`; each
interactive control calls `stopEventPropagation` on `pointerdown`; the card
header is the drag handle. Custom shape types must be added to tldraw's
`TLGlobalShapePropsMap` (see `shapes/types.ts`) or `editor.createShape` won't
accept them. Arrow bindings need `snap: "none"` in tldraw 5; labels are
`richText: toRichText(...)`.

## Gotchas

- **The Devin CLI owns `~/.codex`.** It is a Codex fork, and its `auth.json`
  there holds _Devin_ tokens in Codex's format. The Codex adapter is therefore
  spawned with `CODEX_HOME` pointed at a scratch dir under the app data dir, so
  the two cannot read each other's credentials. Codex also refuses to start if
  `CODEX_HOME` does not already exist, so we create it first.
- `@tldraw/assets` is excluded from `optimizeDeps` in `vite.config.ts`. Its
  `?url` imports break Vite's dependency pre-bundler. Don't remove it.
- tldraw assets are bundled locally rather than loaded from the tldraw CDN, so
  the canvas works offline in the packaged desktop app.
- The tldraw chunk is ~1.7 MB (530 kB gzipped). Expected for a local app.
- `tauri-plugin-webdriver` is optional and gated behind the `webdriver` Cargo
  feature, not `cfg(debug_assertions)` — Cargo does not evaluate
  `debug_assertions` in `[target.'cfg(...)']`, so the README's suggested form
  would silently fail to link the crate. `cargo tree` confirms it is absent
  from a default build.
- `tsconfig.json` deliberately has no `baseUrl`; TypeScript 6 rejects it. The
  `@/*` path alias resolves relative to the tsconfig without it.
- `ui/spinner.tsx` is typed against the remixicon component, not
  `ComponentProps<"svg">`. Re-adding it via the shadcn CLI reintroduces a type
  error, because remixicon icons reject `children`.

## Web backend (apps/server)

One Node 24 process (`apps/server`, run with tsx, no build step) is the whole web
backend: Hono HTTP API, `ws` sync sockets, Better Auth, rooms, an in-process
scheduler and the asset store. It also serves the built SPA from `KAN_WEB_DIST`.
**It owns rooms in memory, so exactly one instance may run.** Two instances would
need sticky routing by canvas; that is not supported.

- **Rooms.** Each open canvas is a tldraw `TLSocketRoom` over `SQLiteSyncStorage`
  in `${KAN_DATA_DIR}/rooms.sqlite` (`node:sqlite`, WAL). `TLSyncStorage` is
  synchronous by contract, which is why Postgres cannot be the storage itself.
  Postgres is written behind: `storage.onChange` debounces 500 ms, flushes are
  serialized per room, and failures retry with backoff (1 s to 30 s). A room whose
  local disk is lost reseeds from Postgres on open; one whose local clock is at
  least the persisted one reuses the local store. `revision` is tldraw's
  `documentClock`. Idle rooms are flushed and evicted by `RoomManager.tick`.
- **Agent writes.** `RoomManager.applyTool` runs inside the room's queue: receipt
  check, `assertActor` (membership and active run), flush pending human edits,
  `expectedRevision` check (409), plan, `updateStore`, labeled flush. Every call
  leaves a `web_events` receipt with `operation = <run>:<callId>`, even when
  nothing changed. Undo (`revertRun`) reads those receipts.
- **Asset `src` rule.** A record's `src` must be `https://` or an owned
  `/api/assets?id=<uuid>` (an `https://…/api/assets?id=` URL needs an owned id
  too). It is enforced in `authorizeRecord` for `asset` records and `kan-image`
  shapes, and in `applyTool` for agent puts (400). It must not live in
  `Persistence.persist`: sync edits are acknowledged by SQLite before Postgres
  sees them, so a rejected human batch would retry forever.
- **Migrations** are in `packages/web-core/migrations/*.sql`, concatenated into
  `src/migration.mjs` (a test checks they match) and additive only. `005.sql`
  moves the `web_events` primary key from `(room, revision)` to `(room, seq)`,
  dropping the old key only if it still covers `revision`. `006.sql` creates the
  Better Auth tables (`"user"`, `"session"`, `"account"`, `"verification"`) in
  schema `kan_web_v1`. Append new files; never edit applied ones.
- **Auth.** Better Auth, email + password, no verification, mounted at
  `/api/auth/*`, `BETTER_AUTH_SECRET`. Sessions are local rows;
  `assertActiveSession(userId, sessionId)` is a DB check cached for 30 s (512
  entries). It guards HTTP, sync upgrades, run dispatch and the scheduler's
  30 s `recheck`, which kicks sockets whose session or role changed.
- **Scheduler** (`scheduler.ts`) replaces the old Durable Object alarm, cron and
  `/wake`: `wake(canvas)` dispatches queued runs after 100 ms, re-arms every 3 s
  while pending (backoff to 30 s on error), and a 60 s sweep finds stuck canvases.
- **Internal API.** `POST /api/web/internal` needs `Authorization: Bearer
  ${KAN_SERVICE_SECRET}`. It accepts only `tool` (agent calls) and `arm-recovery`
  (works only with `KAN_ENV=staging`).
- **Environment** (`apps/server/src/config.ts`, zod; root `.env.local` is loaded
  without overriding the environment): `PORT` (8787), `KAN_DATA_DIR`
  (`data/server`), `DATABASE_URL` (unset = embedded PGlite, development only),
  `KAN_ENV`, `KAN_SERVICE_SECRET`, `KAN_PUBLIC_URL` (browser origin; write-origin
  check, cookies, sync URL), `BETTER_AUTH_SECRET`, `EVE_URL` (required outside
  development; unset in development fails runs with `server.agent_unconfigured`),
  `KAN_RUN_CEILING`, `KAN_CONTEXT_RUN_CAP`, `KAN_WEB_DIST`, and `S3_BUCKET`,
  `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
  `S3_FORCE_PATH_STYLE` (unset bucket = local disk assets, development only).
- **Agent.** `apps/web-agent` is a self-hosted eve agent:
  `cd apps/web-agent && npx eve build && PORT=3100 KAN_SERVICE_SECRET=… WEB_API_URL=http://localhost:8787/api/web AI_GATEWAY_API_KEY=… npx eve start --port 3100`,
  with the server's `EVE_URL=http://localhost:3100`. `WORKFLOW_POSTGRES_URL` (set at
  build/start) switches durable workflow state to `@workflow/world-postgres`.
- **Tests.** `npm run test -w @kan/server` (65 tests: real HTTP/WS, genuine tldraw
  pushes, PGlite, real Better Auth; no paid provider) and `npm run test:web`
  (web-core: meeting, migration, policy). End-to-end was driven with Playwright
  (not committed): sign up two users, create workspace and canvas, invite the
  second as editor, check edits sync both ways, then restart the server with
  SIGINT, once deleting `rooms.sqlite*` (restore from Postgres) and once not
  (`server.room_loaded` logs `source: postgres` or `local`).
- **Known limitations.** `run/revert` runs outside a transaction (it calls
  `applyTool`, which needs its own connection), so concurrent reverts can both
  run. The PGlite Kysely dialect (`src/kysely-pglite.ts`) shares one connection and
  does not serialize concurrent transactions (dev only). The agent turn has not
  yet been exercised against a live eve in this topology (no
  `AI_GATEWAY_API_KEY` was available). The desktop app no longer has online
  rooms: it keeps offline canvases and the local ACP agent only.

`@kan/nodes` supplies the pure shared schema; the renderer is in
`apps/desktop/src/lib/canvas-shapes.tsx`. SQLite files/WAL files and `/data/` are
ignored; use temporary `KAN_DATA_DIR` fixtures for verification. Never log
credentials, service secrets or ticket URLs.

## Timeline and calendar nodes

- `kan-timeline` and `kan-calendar` share date-only events: stable unique `id`,
  `title`, `start` (`YYYY-MM-DD`), optional inclusive `end`, `description`, and
  `sourceNote`. Years 0001–9999 are supported; no timed events or external sync.
- Timeline expansion (`selectedEventId`), calendar month (`YYYY-MM`), and
  `selectedDate` live in shape props. Selecting a date through `updateNode`
  reveals its month; changing months clears an out-of-month selection.
- Unit checks: `node --test scripts/date-nodes.test.mjs` (Node 22.18+ or 24).
  Repeat with `TZ=America/Los_Angeles` to check date-only timezone handling.
- Running-app regression: start `npm run tauri:drive`, then run
  `node scripts/date-nodes.e2e.mjs`. It creates and removes only its own test
  nodes and restores the camera. Avoid driving the same window concurrently.

## Canvas thinking effect

- `InteractiveCanvas` in `apps/desktop/src/components/ui/` is a parent-sized,
  pointer-transparent soft-blue dot field. `CanvasThinkingOverlay` positions it
  over the current local agent targets, without persisting activity in shapes.
- A prompt captures the selected node IDs; successful scoped canvas tools retarget
  the effect. Broad `getCanvas` reads do not light up the entire board. Completion,
  cancellation, disconnection, and sign-out clear it. Reduced motion is static.
- Unit checks: `npm run test -w @kan/desktop` includes target extraction tests.
- From the canvas catalog in `npm run tauri:drive`, run
  `node scripts/agent-thinking.e2e.mjs`. It mounts an isolated fixture, simulates
  agent replies at the IPC fetch boundary, and sends real native canvas events.
  It exercises the actual provider and canvas, but is not live-provider coverage.
  Do not drive concurrently. The script cleans up its fixture and restores fetch
  and media-query handling. Tauri's internal invoke is read-only; Vite context
  imports must retain their HMR query strings to avoid duplicate providers.

## Canvas/chat regression checks

- The tldraw theme in `apps/desktop/src/styles.css` is scoped to UI roots,
  including portaled menus/popovers, not `.tl-container` itself: shared radius,
  font and color tokens also style canvas content. Preserve round swatches and
  handles. `node scripts/canvas-theme.e2e.mjs` checks the native UI theme and
  tool switching with a temporary canvas, then restores the original route.
  Do not drive concurrently.
- `WorkspacePanels` must give its inner canvas wrapper explicit full height;
  panel dimensions alone do not prevent a zero-height canvas and clipped toolbar.
  Keep both panels mounted when collapsing chat to preserve editor and draft state.
- `addNode` supports native `geo` drafts (`geo: "rectangle"` or `"ellipse"`);
  equal ellipse dimensions make a circle. `focusNodes` fits current-page targets
  without changing shape records or selection and is exposed by the Rust MCP bridge.
- `npm run test:desktop` supplies the desktop tsconfig for component-render tests.
  Pure node helpers import runtime validation/schema utilities from `@tldraw/validate`
  and `@tldraw/tlschema`, avoiding browser-runtime timers in Node tests.
- With `npm run tauri:drive` running, `node scripts/canvas-chat.e2e.mjs` checks
  canvas/toolbar visibility, resizing, chat state preservation, native shapes,
  camera focus, and controlled streaming feedback in an isolated canvas. A connected
  agent is required; add `--live` to also exercise the reported prompts with the
  real provider. The script restores the original page and cleans its test canvas.

## Local QA reports

- The bottom-left Report bug dialog freezes diagnostic context when opened.
  `useQaSource` registers canvas, chat, composer, thread view, and agent state;
  closed panels retain a last snapshot marked `mounted: false`. Sources are
  scoped to the route, not collected from credentials, storage, or environment.
- Native `qa_save_report` writes immutable UUID JSON reports and `bugs.csv` to
  this worktree's gitignored `qa_bugs/` in development. Packaged apps use the
  app-local-data `qa_bugs/` directory instead. `KAN_QA_DIR` can override either
  with an absolute path. The success dialog shows the full report path.
- Reports include private canvas/chat text; known credentials and URL queries
  are redacted and embedded assets omitted, but this is not a guarantee that
  arbitrary user text is secret-free. Do not upload or commit reports.
- `/qa-fix` uses `.devin/agents/qa-fable.md` (Fable 5.1 Medium), one foreground
  subagent at a time. `python3 scripts/qa_queue.py list|claim|update` manages
  `open`, `solving`, and `finished` rows, owners, and verification notes.
  Pass `--dir /absolute/qa_bugs` before the command to use another queue.
  Both Rust and Python share `.queue.lock` and atomic CSV replacement; never
  hand-edit the CSV or remove a lock without checking for an active writer.
- Checks: `npm run test:desktop`, `npm run typecheck -w @kan/desktop`,
  `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml qa::tests`, and
  `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts -p qa_queue_test.py -v`.
- Native regression: `node scripts/qa-report.e2e.mjs` against a running driver.
  Start on catalog/onboarding with a fresh QA queue; it refuses an existing CSV
  and cleans only its fixture reports/canvas. An optional `KAN_QA_DIR` must match
  the app launch environment. Keep the window visible: hidden WKWebViews freeze
  CSS exit animations and can return stale screenshots.
- For simultaneous worktrees, use launch-time Tauri `--config` overrides for
  `identifier`, `build.devUrl`, and `build.beforeDevCommand` (Vite `--port`). Set
  `TAURI_WEBDRIVER_PORT` for the app and `TAURI_WEBDRIVER_URL` for the driver.
  Do not stop or drive somebody else's app on the default ports.

## Queued bug regressions

- `python3 scripts/qa_queue.py repair` repairs only recognized joined CSV rows,
  validates the entire queue first, and saves the original in a private
  `.bugs-backup-*.csv` file. Use the command rather than hand-editing the queue.
- Structured assistance now supports calendar drafts, including `selectedDate`,
  and a bounded `style` mutation for native geo colors. Offline additions create
  `kan-calendar`; shared `kan-node` calendar drafts reuse the same interactive
  `CalendarView`. Other rich-node types still require shared-schema integration.
- From the catalog after completing onboarding, run
  `node scripts/qa-queue.e2e.mjs` against the Tauri driver. It mounts an isolated
  canvas/chat fixture, tests native color changes, Ask Kan structured completions,
  native/shared calendar controls, and the thread header. Provider replies are
  controlled at the IPC fetch boundary, not live-provider coverage. Do not drive
  concurrently. `TAURI_WEBDRIVER_URL` selects a separately launched QA instance.
- Desktop node schemas remain independently constructed: the desktop and protocol
  currently resolve different Zod versions, so composing their Zod object types
  directly fails typechecking. Keep desktop date helpers importable by the plain
  `node --test scripts/date-nodes.test.mjs` command as well as tsx.
- Backend test fixtures must register server/socket cleanup with `t.after`; an
  assertion before end-of-test cleanup otherwise leaves the pre-push runner open.
  Await `classifierIdle` after debounced human edits before inspecting decisions.
- Classifier persistence failures reject `classifierIdle` while retaining durable
  causes for retry; later jobs must still run. Open suggestions/offers and recent
  resolved contributions have separate bounded context lists so neither crowds
  out the other.

## Agent diagnostics and fault injection

- `packages/protocol/src/diagnostics.ts` defines content-free events and typed
  failures. Desktop traces join frontend, Rust ACP, and native MCP events by
  turn/request IDs. Structured assistant turns use the lease run ID as their
  turn ID. Regular chat/Ask Kan uses structured turns; prompts on an offline
  canvas use the local canvas MCP path. Do not assume a failed Ask Kan request
  used MCP.
- `Report bug` → `View diagnostics` previews/copies the recent trace. Local agent
  entries also expose per-turn diagnostics. QA reports include frozen metadata
  traces. Optional error-stack/stderr capture is memory-only, expires after five
  minutes, and can still contain private text; preview before copying.
- Native metadata logs live under app-local-data `diagnostics/`, with two bounded
  files and private permissions. Neither log contains prompts, raw tool
  arguments, result contents, or credentials by default.
- Desktop mutation `requestId` UUIDs deduplicate identical retries within the
  current canvas agent session, including across turns. Conflicting reuse is
  rejected. Deduplication is not durable across process/session replacement;
  inspect the canvas after an unknown outcome rather than blindly replaying.
- Native fault regression: launch an isolated app with
  `DEVIN_BIN="$PWD/scripts/diagnostics-fake-agent.mjs" TAURI_WEBDRIVER_PORT=4449 KAN_QA_DIR=/tmp/kan-diagnostics-qa npm run tauri:drive -w @kan/desktop -- --config '{"identifier":"com.asierzapata.kan.diagnostics-qa","build":{"devUrl":"http://localhost:1426","beforeDevCommand":"npm run dev -- --port 1426"}}'`.
  Complete onboarding with the fixture subscription provider, then run
  `TAURI_WEBDRIVER_URL=http://127.0.0.1:4449 node scripts/agent-diagnostics.e2e.mjs`.
  It refuses a real provider, uses actual ACP/MCP subprocesses and native IPC,
  injects result-delivery faults, and exercises both tool and structured paths.
  It cleans its canvas and leaves its report in the isolated QA directory.
- Dynamic test harness imports must preserve Vite's `?v=` dependency hashes as
  well as HMR queries. Resolve React/ReactDOM URLs from transformed `src/main.tsx`;
  importing bare optimized-dependency URLs can create a second React dispatcher.
- Focused tests: `npx tsx --tsconfig apps/desktop/tsconfig.json --test apps/desktop/test/agent-diagnostics.test.ts`,
  `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`.

## Prompts and drawing

- All behavioral prompt text lives in `packages/protocol/src/prompts.ts`: shared
  core, explicit/context modes, drawing contract and local MCP.
  `assistant-policy.ts` retains scheduling and explicit-invocation helpers.
- A bounded `diagram` mutation creates native editable geo nodes, bound arrows,
  and named frames in one batch. Layout is shared in `packages/nodes/src/diagram.ts`.
  `label` updates an existing geo node's text without replacing its ID.
- Literal creation/recolor commands use `directCanvasResult`, without a model call.
  Ambiguous targets, incomplete canvas context and broader requests fall through
  to the agent.
- Native regression: `node scripts/drawing.e2e.mjs` from the catalog with the Tauri
  driver running. `--live` exercises the connected provider. It uses a temporary
  canvas and restores the page; do not drive concurrently. `TAURI_WEBDRIVER_URL`
  selects an isolated app.

## Galtea native evaluations

- `node scripts/galtea.mjs <CLI arguments>` runs `galtea-cli==5.2.0` through
  `uv`, loading `GALTEA_API_KEY` or `GALTEA` from the ignored root `.env.local`.
  Never enable verbose HTTP logging: it exposes the Authorization header.
- `scripts/galtea-evaluate.mjs` manages generated datasets, explicit versions,
  result ingestion and summaries. Generation and judging consume Galtea credits.
  Runtime evidence lives in ignored `galtea-results.local/`; it contains synthetic
  fixtures only. Existing manifests and uploaded evaluations are reused.
- `TAURI_WEBDRIVER_URL=http://127.0.0.1:4448 node scripts/galtea-native.e2e.mjs
  <version-label> [suite-or-case-id]` runs the actual native AgentProvider, Rust
  ACP connection, local completion validation and tldraw executor. Use a separate
  app identifier and Vite port when other agents are working. The comparison
  pins `gpt-5-6-luna-high`, matching the captured baseline.
- `--baseline` uses the archived original executor, never restores old code over
  the working tree. `--replay` applies previously recorded provider output and
  must not be described as a fresh model call. Dynamic executor imports use a
  versioned URL: importing the same bare path can reuse stale WKWebView code even
  after HMR. Each new run records the executor hash.
- `npm run test:desktop` includes batch-write regression and deterministic scoring
  checks. `KAN_GALTEA_CANVAS_MODULE=/absolute/path/to/baseline-canvas.ts` selects an
  archived executor for the batch regression test; the old implementation fails
  seven checks. `node scripts/galtea-report.mjs` builds the local HTML evidence pack
  after the discovery and held-out versions have been run and scored.
- Round 2 uses `node scripts/galtea-round2.mjs prepare` to upload 20 curated
  cases (five ordinary, compound, protection and conversation cases each) and
  freeze both executors. It requires the existing Round 1 baseline artifacts.
  Run `scripts/galtea-native.e2e.mjs round2-before --round2 --baseline`, then
  `round2-after --round2`, and `round2-repeats --round2 --repeats`, with the
  isolated driver URL above. Never drive two native runs concurrently.
- Round 2 retains real local thread entries and canvas state within each three-turn
  conversation. Expected values, protected fields, IDs and binding endpoints are
  checked independently of emitted operations. Model-format and application errors
  remain failures; the three predeclared repeats never replace first-pass results.
  The harness records raw synthetic structured responses locally for diagnosis.
- `node scripts/galtea-round2.mjs submit|results <label>` ingests complete sessions
  and scores them in Galtea. `audit <label>...` checks fixture isolation/history;
  `summary` aggregates the three versions. `node scripts/galtea-report.mjs --round2`
  writes `submission-round2.html` without overwriting the original evidence page.
  Round 2 uses uploaded curated cases, not new Galtea-generated prompts. API judge
  metrics require `input` and `actual_output`; `conversation_turns` is rejected by
  the current API, so complete conversations are ingested as session traces.

## Thread panel header

- The header is one row: `Thread` badge, channel, the assistant chip, search,
  close. The three-way filter tabs (Everything / Messages / Agent activity) are
  gone; `buildThreadRows(entries, search, view)` takes a search query instead,
  matched by `matchesSearch` over body text plus anchors, attachments, agent
  step summaries, suggestion quotes and offer titles. Contextual and propose
  triggers are now always hidden, since only the deleted tab revealed them.
- `AssistantMenu` (`components/thread/AssistantMenu.tsx`) is the single
  assistant control. Scope, eagerness, background checks and the room pause all
  live in it. `lib/assistant-settings.ts` collapses scope+eagerness into one
  `ChimeIn` ladder (`asked` = `scope: "manual"`, then the four eagerness
  levels). It derives rather than migrates: `kan-assistant:<roomId>` and the
  server's `assistantEagerness` keep their existing shape. Whose triggers the
  agent runs (`own` vs `room`) stays a separate switch, shown only online.
- Assistant settings are read at **first render**, not restored in an effect.
  A reader effect and the writer effect run in the same commit, so the writer
  persisted the defaults over the restore and StrictMode's second pass read
  those defaults back: every setting reverted on reload. Room changes reset the
  state during render for the same reason.
- `ThreadPanel` has three slots: `headerAction` (the chip), `status` (one
  transient line, rendered only when non-empty: agent busy with Cancel, then
  errors) and `footerStatus` (ambient state such as the call transcript). Do
  not put always-set text in `status` or the slot becomes permanent. The old
  `toolbar` slot went away with the conversation simulator that used it.
- `lib/config.ts` treats a blank `VITE_*` key as absent. Vite injects `""` for a
  key present but empty in `.env.local`, and the old `.min(1).optional()`
  crashed the whole app on boot over an optional key.

## App icon packaging

- `apps/desktop/src-tauri/icons/Kan.icon` is the editable Icon Composer source.
  Releases bundle the checked-in `icons/Assets.car`; Tauri discovers its icon name
  and sets `CFBundleIconName`. Keep `icon.icns` for older macOS versions. This
  avoids recompiling unchanged artwork on every release: Xcode 27's `actool` has
  returned `Bad file descriptor` even when its version check succeeds.
- Run `node scripts/generate-icons.mjs` on macOS after changing the artwork.
  It refreshes both `Assets.car` and the macOS fallback through `actool`, and
  desktop PNG/ICO sizes through Tauri from `icons/source.png`, the flattened
  Composer PNG export. Update that export too when the design changes. Commit
  the source and generated assets together. Regeneration requires working full
  Xcode 26+ with first-launch components installed. Mobile outputs stay temporary.
- For an icon-only update to an already-built alpha, run
  `npm run tauri -- bundle --bundles app,dmg --config '{"productName":"Kan Alpha","identifier":"com.asierzapata.kan.alpha","bundle":{"macOS":{"signingIdentity":"-"}}}'`.
  This repackages the existing release executable; it does not compile current
  source. Use `build` instead of `bundle` for a fresh full build. Outputs live in
  `apps/desktop/src-tauri/target/release/bundle/`. Ad-hoc signing is not notarization.
- Verify both `CFBundleIconFile` and `CFBundleIconName` in the packaged plist,
  inspect `Assets.car` with `xcrun assetutil --info`, verify the signature with
  `codesign --verify --deep --strict`, and launch the actual `.app` to check the
  macOS icon. A dev WebDriver window does not exercise packaged icon resources.
- `components/KanBrand.tsx` provides the compact, theme-aware SVG plus wordmark
  for both headers and the full bundled Composer PNG for onboarding. The icon is
  decorative beside the welcome heading; the canvas link retains its explicit
  back arrow and accessible navigation label. Header foreground/background must
  use the paired theme tokens, not the legacy always-white `--surface`.
- Branding checks: `npx tsx --tsconfig apps/desktop/tsconfig.json --test
  apps/desktop/test/kan-brand.test.tsx`. Native verification should cover both
  onboarding steps, the catalog and canvas headers, back navigation, and light/dark
  contrast. Use a separate app identifier and Vite port for fresh onboarding so
  the user's profile and canvases are not changed.

## Deploying a new alpha download

The landing site serves the current macOS Apple Silicon alpha from
**`apps/site/public/kan-alpha.dmg`**, at the stable URL **`/kan-alpha.dmg`**.
Replace that file for each release. The site is currently waitlist-first: public
download links are hidden, but this direct URL remains available.

From the repo root, on an Apple Silicon Mac:

1. Commit the app changes to release. Keep version metadata consistent if bumping
   the version; the build script reads the DMG version from `tauri.conf.json`.
2. Run `node scripts/build-alpha.mjs`. It performs a fresh Tauri release build
   (not `tauri bundle` of an old executable), using product name `Kan Alpha`,
   identifier `com.asierzapata.kan.alpha`, ad-hoc signing, and no WebDriver feature.
   It checks the app signature and DMG integrity, then atomically replaces
   `apps/site/public/kan-alpha.dmg` and prints its size and SHA-256.
3. Smoke-test `apps/desktop/src-tauri/target/release/bundle/macos/Kan Alpha.app`.
   Exercise the actual packaged app and keep a canvas open beyond five seconds
   to catch production-only licensing failures. The script requires a nonempty
   `VITE_TLDRAW_LICENSE_KEY` from the build environment/root `.env.local`; presence
   alone does not establish that the license is valid. Never commit env files.
4. Run `npm run build -w @kan/site`. Vite copies the public DMG into
   `apps/site/dist/kan-alpha.dmg`. Preview the built site with
   `npm run preview -w @kan/site`, verify the download returns the real DMG (not
   HTML), and compare its SHA-256 with the staged file.
5. Commit `apps/site/public/kan-alpha.dmg` together with any release/site changes,
   then deploy the landing site through its Vercel project. Root `vercel.json`
   builds `@kan/site` and publishes `apps/site/dist`. Only push or trigger the
   hosted deployment when explicitly asked; a local build is not a live deploy.

For a local CLI deployment, use `npx --yes vercel@59.16.0 deploy --prod
--project kan --scope asier-zapata-fernndezs-projects` from the repo root.
Run the same command with `--dry --json` instead of `--prod` first and inspect
its file list. The CLI does not honor this repo's Git ignore rules: without
`.vercelignore`, it includes native build caches and local database files.
The checked-in allowlist uploads only the site's source/assets, workspace
manifests, lockfile, and build configuration. Add new site assets explicitly.
Avoid `vercel link` here: it can replace root `.env.local` with pulled values.
After deployment, verify `https://www.getkan.dev/kan-alpha.dmg` against the
staged SHA-256; `https://getkan.dev` redirects to the `www` domain.

The current download is arm64-only, not an Intel/universal build. The build helper
rejects other host architectures so it cannot silently replace the advertised
Apple Silicon download with an incompatible binary. Ad-hoc signing is not Apple
notarization; retain the site's Gatekeeper warning. Do not ship an automation
build or substitute a previous DMG when a fresh build fails.

## Desktop visual language

- Prefer Mac-native clarity: system sans-serif typography, neutral surfaces, blue
  interaction accents, and restrained translucency. Keep canvas content solid.
- Shared radii live in `apps/desktop/src/styles.css`: xs 4px, sm 6px, md 8px,
  lg 12px, xl 16px. Controls use md, menus lg, cards/dialogs xl. Retain square
  inner edges for joined controls and circular slider/scrollbar handles.
- Composer disabled styling must target the input control, not any disabled
  descendant: an empty draft disables Send but must not fade the textarea.
- UI styling can be checked in an isolated native instance with a separate app
  identifier, Vite port and WebDriver port; do not drive the user's active window.
- The landing site is static HTML and Tailwind, not React/shadcn. Its independent
  tokens in `apps/site/src/styles.css` mirror the app's system fonts, neutral
  surfaces, blue accents and radii. Keep them aligned without importing desktop
  CSS. Verify the production preview at desktop and mobile widths, including
  keyboard FAQ toggles, anchor navigation and the unchanged direct DMG download.

## Landing-site waitlist and media

- The public page is waitlist-first; the alpha link is retained in an inert HTML
  template, not rendered or focusable. Keep `/kan-alpha.dmg` available unless
  explicitly asked to disable direct downloads.
- Root `api/waitlist.js` is a Vercel Web-standard function. Set server-only
  `GOOGLE_SHEETS_WEBHOOK_URL` and `WAITLIST_WEBHOOK_SECRET`; never use `VITE_`.
  It POSTs to the Apps Script `/exec` URL and follows Google's content redirect
  with a GET only to `script.googleusercontent.com`, without forwarding the secret.
  Only JSON `{ "ok": true }` confirms persistence: Google login/error HTML with
  HTTP 200 must fail. Missing configuration returns 503. Honeypot and same-origin
  checks are basic filtering, not distributed bot/rate protection.
  Turbo may warn that these variables are absent from the static build; keep
  them out of that build. Vercel injects them separately into the API runtime.
- Google setup: create a private Sheet, open **Extensions → Apps Script**, paste
  `apps/site/google-apps-script.gs` into `Code.gs`, save, and run `setupWaitlist`.
  Authorize it as the owner. It creates a dedicated `Waitlist` tab with Email,
  Signed up at (UTC), and Consent columns, and stores the spreadsheet ID and a
  generated secret in **Project Settings → Script properties**. Setup is
  idempotent; existing rows and a previously generated secret are retained.
  Deploy as **Web app**, executing as **Me**, accessible to **Anyone** including
  unauthenticated callers. The Sheet itself stays **Restricted**, not public.
  Copy the deployment `/exec` URL into `GOOGLE_SHEETS_WEBHOOK_URL` in Vercel and
  the `WAITLIST_WEBHOOK_SECRET` script property into the matching server-only
  Vercel variable. Never paste the secret into chat or commit it. If Workspace
  policy prevents anonymous web apps, ask the owner rather than changing policy.
  After script edits, update the existing deployment to a new version.
- The Apps Script authenticates before accessing storage, validates consent,
  locks the dedupe/append operation, and escapes formula-like email cells. A
  retry keeps the original row and signup timestamp. It sends no email; removals
  and future outreach are manual. Do not promise automated unsubscribe links.
  A real deployed signup and duplicate retry still need verification before launch.
- Run `npm run test -w @kan/site` for handler checks and `npm run build -w @kan/site`
  for the static build. The site test task's Turbo inputs include the root API.
- For browser verification, run `node apps/site/test/server.mjs fixture` on :1434
  and the site dev/preview server. Vite proxies `/api` with the original Host.
  The fixture calls the real handler and executes the actual Apps Script in a
  Node VM with in-memory Google services. It never calls Google or sends mail.
  `unavailable@example.com`, `limited@example.com`, and `login@example.com`
  simulate storage failure, lock contention, and an HTML login response.
  Fixture-only `GET /api/__test/waitlist` exposes a row count, not email addresses.
  Without `fixture`, the helper verifies unconfigured failures. Live Google
  authorization and persistence still need separate verification before launch.
- `scripts/capture-site-media.mjs` captures the actual canvas renderer through a
  dedicated Chromium debugging endpoint on :9333. Start Chrome with a fresh
  temporary profile and an about:blank tab. `KAN_MEDIA_ORIGIN` defaults to
  `http://localhost:1432`; `FFMPEG_BIN` can point at a standalone encoder. Output
  refuses replacement unless `--replace` is supplied. Never target a user profile.
  These are sample-data browser captures, not native IPC or live AI coverage.
  The native capture attempt reported a hidden WKWebView and frozen chart bars;
  do not use that incomplete capture as evidence or product media.
- New public assets and root functions must be explicitly included in
  `.vercelignore`. V1 is screenshot-only: the demo player and video links are
  removed, with the integrated video deferred. Existing media files remain local;
  the unused video and poster are excluded from CLI deployment uploads. Verify
  mobile layout, signup failure/retry behavior, FAQ keyboard controls, and image
  requests in a production preview.

## Editorial landing design

- The landing remains static HTML/Tailwind by design, with the existing waitlist
  handler and screenshot-only media. Its marketing typography now intentionally
  differs from the desktop: self-hosted Space Grotesk and DM Sans, warm paper,
  cobalt actions, and a muted green canvas stage. Do not change desktop tokens.
- Keep prototype evidence and limitations explicit; do not invent testimonials,
  customer counts, or availability. Both signup forms and the inert alpha template
  stay intact. Reduced motion disables entrance/scroll animation; content remains
  visible when JavaScript or IntersectionObserver is unavailable.
- Fontsource 5.2 variable packages use `wght.css`, not `latin.css`; unicode ranges
  ensure the browser only downloads the subsets it needs. `robots.txt` is included
  in the deployment allowlist so Vite's HTML fallback is not served to crawlers.
- Decorative landing-page arrows use inline SVG paths with `currentColor`, not
  Unicode arrow characters: iOS Safari can render the diagonal arrow as a colored
  emoji. Keep the icons hidden from assistive technology and outside the tab order.
  The page regression test guards against reintroducing font-dependent arrows.
