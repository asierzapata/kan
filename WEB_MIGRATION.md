# Kan web migration — plan and implementation evidence

Plan date: 2026-10-04. Implementation audit: 2026-10-12.
M1–M4 have maintained workspaces and staging implementations; the M3 live
crash/retry gate and the M4 browser acceptance passed on hosted staging on
2026-10-12 (see the ledger). M5 (release/cutover) is open. Do not label the
migration complete from builds or older M0 evidence. All existing desktop sources
are preserved.

## Current maintained implementation

| Milestone | Implemented | Acceptance observed in this continuation |
| --- | --- | --- |
| M1 | Start/AuthKit, onboarding/workspaces, owner/editor/viewer membership, recipient-bound invitation links, canvas catalog CRUD, HTTP/socket/tool authorization | Synthetic hosted HTTP/invitation/isolation checks; real browser canvas create/open; hosted role downgrade, membership revocation and WorkOS remote session revocation |
| M2 | Desktop theme/panels/renderers/tools reused, eight rich types plus native shapes, private R2 assets, bounded Neon record deltas, commit-before-ack, fencing/receipts, reconstruction | Two hosted tldraw clients across reconnect/expiry; two actual Arc clients share a calendar edit; eight visible rich types and authenticated PNG; draft preservation and keyboard panel resizing |
| M3 | Neon threads/messages/runs, scoped streaming observer, eve/Gateway tools, per-canvas queue, cancellation, retry limits/receipts, dispatch reconciliation | Hosted paid acceptance passed 2026-10-12: post-commit process crash recovered from the durable receipt, queued Mermaid native graph committed, retry API requeued a failed run with a fresh session, missing-node retry failed without mutation, completed-run retry denied. Fresh live-browser streaming acceptance remains open |
| M4 | Synthetic meeting sessions and transcript segments (partial/final/duplicate/stale), buffered automatic context runs (8 s settle, 45 s max wait, explicit-request priority, per-session and staging caps), `readMeetingContext` tool, evidence links, pause/resume/end, human-edit-preserving undo (`run/revert`), narrow layout | Hosted browser acceptance passed 2026-10-12 with two real automatic runs: transcript display, context notes, "Based on transcript" evidence highlighting, pause suppressed scheduling, resume scheduled the follow-up for exactly the new segment, end hid the feed, reload restored history, 390 px layout has no horizontal overflow and keeps the canvas mounted across the Chat/Canvas toggle; undo removed an untouched agent node and kept an agent node that a later run had modified. 17 new local regressions (meeting + revert). Synthetic transcript only — no live capture |

Deployment is only https://staging.getkan.dev, in the dedicated `kan-staging`
Vercel project. Current web deployment: `7Y6jhbCjLXs15HKjra1ZbwDHWow4` (READY;
M4 complete) with Worker version `08c6c389-30d1-487c-96fe-9bc52bbacbd7`.
`dpl_4Mef8v3JYgczvrvKiRUjR7Ycb5DX` carried the server-bundle fix below. The previous
`dpl_C3bYnm7xP5pe6UYKrk6WVAzHHmww` passed the anchor/thread visual checks but
returned 503 on every hosted `addMermaidDiagram`. The Worker configuration now
retains `WEB_API_URL=https://staging.getkan.dev/api/web`; omitting it on deployment
caused a real browser loading failure, which was diagnosed and fixed. Read-only
inspection confirms marketing still serves `dpl_CbLDWZMQysdgRgnHV5N3sJrHNsAR`.

Maintained sources: [web](apps/web/README.md), [realtime](apps/realtime/README.md),
[agent](apps/web-agent/README.md), [persistence](packages/web-core/README.md).
Use Node 24.13.0, npm 11.6.2, and deploy from the isolated source prepared by
`scripts/web/stage.mjs`; never deploy the repository's marketing root.

### Validation ledger (2026-10-12)

- **37 web regression tests pass** (`npm run test:web`): the 20 below plus 11
  meeting tests (segment upsert outcomes, settle and max-wait scheduling with an
  injected clock, follow-up for arrivals during a run, explicit-request priority,
  pause/resume/end, revoked creator → denied, per-session and global run caps,
  `readMeetingContext` range/finality, migration-string guard) and 6 revert tests
  (untouched creations removed while a human-edited node and its human arrow are
  kept, update-only runs revert nothing, double revert 409, running run 409,
  viewer 403, receipts survive so retry still refuses, stale agent revision is
  rejected and succeeds after re-reading). The original 20: role/isolation, bounded atomic persistence,
  fencing, duplicate/conflicting operations, post-commit recovery, rich state,
  graph tools, fractional indices beyond ten nodes, revocation/cancellation at
  commit, Mermaid native graphs, queue snapshots, retry checks before resetting
  eve, ambiguous dispatch without automatic resend, and stream observation past an
  initially parked `session.waiting` event.
- Web, web-agent, desktop and backend typechecks pass; local web build passes.
  All **151 desktop regression tests pass** with private loopback fixtures.
  The final staged Start/eve source also built on Vercel Linux with Node 24.
- `scripts/web/acceptance.mjs` passes against hosted staging: signed-out denial,
  catalog lifecycle, invitation recipient checks, viewer write denial,
  cross-workspace isolation, private image storage/read, revoked membership.
- `scripts/web/realtime-acceptance.mjs` passes with two genuine headless tldraw
  clients: all eight rich types, shared calendar-state update, reconstruction,
  ticket-expiry reconnect and subsequent editing. This is transport coverage.
- `scripts/web/security-acceptance.mjs` passes: editor-to-viewer closes the existing
  socket; viewer HTTP writes fail; membership revocation closes the viewer socket
  and denies reconnect; remote WorkOS revocation closes realtime and denies HTTP.
  Active WorkOS status is cached for at most 30 seconds; socket alarms run every
  30 seconds. This verifies revocation, not waiting for a naturally expired session.
- Actual Arc browser: authenticated refresh, catalog canvas creation/open, eight
  renderers, private PNG upload, calendar day controls, two tabs sharing edits,
  canvas/chat visibility, collapse/reopen draft preservation and keyboard resizing.
  On the final deployment, the anchor control is visible above navigation, selecting
  one node adds one composer anchor, and collapse/reopen retains the unsent draft.
  New thread clears existing messages and remains selected after refresh; choosing
  the existing thread restores its history. The canvas reconnects after refresh.
  The pre-existing owned QA canvas and its history are preserved. Browser checks
  are not Tauri/native UI coverage. Invitation permissions have hosted synthetic
  coverage, not a real-recipient browser invitation grant.
- `scripts/web/stream-acceptance.mjs` passes against the final deployment by
  replaying an existing paid synthetic run read-only: text deltas, tool activity,
  turn completion and cross-canvas denial. This starts no inference and does not
  establish fresh live-browser streaming.
- `scripts/web/agent-recovery-acceptance.mjs` passes against
  `dpl_4Mef8v3JYgczvrvKiRUjR7Ycb5DX` (results in
  `/tmp/kan-web-final-agent-recovery-results.json`): a run armed with the
  staging-only fault hook exited the process after its `addNode` commit and its
  resumed step received the saved receipt (`duplicate: true`); exactly one
  "QA crash recovery" node exists; a second turn was observed `queued` and then
  committed a native Mermaid flowchart (two geo nodes, one bound arrow, revision 5);
  a turn targeting a missing node failed, the retry API requeued the **same** run
  with a **different** eve session, which failed again without any mutation; and
  retrying the completed run returned 409. Four sessions, **$0.00369896** of model
  steps. The crash-recovery turn was bought once and reused across three attempts
  (`KAN_RESUME_RECOVERY_RUN`); the two earlier attempts failed on the hosted
  Mermaid bug below and cost about $0.001 more.
- **M4 hosted browser acceptance** (headless Chromium via `agent-browser` with
  the synthetic fixture cookie; screenshots in `/tmp/kan-m4-browser/` and
  `/tmp/kan-m4c-browser/`): started "QA synthetic standup", a partial segment was
  replaced by its final (`replaced #1`), two more finals (`#2`, `#3`); after the
  settle window one automatic run (`auto`/`complete`) added a `kan-markdown`
  "Web alpha — meeting notes" and replied citing segments 1–3; "Based on
  transcript 1–3" highlighted #1–#3. Pause + segment #4 → no run after 40 s;
  Resume → one follow-up run for 4–4 updated the same note. End hid the feed and
  the header badge; reload restored both context notes and the transcript. Undo
  on run 1–3 kept the note (modified later), undo on 4–4 removed nothing, undo on
  the earlier "QA crash recovery" request removed exactly that node and set
  `reverted_at`. Two paid runs; **7 of the 20 staging runs are consumed**. Known
  gap: the partial-segment ellipsis was never on screen because the UI then
  refreshed only on the 2 s poll (now refetched immediately after each post).
- **Hosted Mermaid bug, found and fixed by this gate.** Nitro inlined `jsdom` into
  the server bundle as ESM, so its CJS `__dirname` read of `default-stylesheet.css`
  threw `ReferenceError` on first import (503 on every `addMermaidDiagram`). Local
  tests never saw it because they import the TypeScript source, not the bundle.
  `traceDeps: ["jsdom", "dompurify", "mermaid"]` keeps them external; then the
  Vercel `nodejs24.x` runtime rejected jsdom 29's `require()` of the ESM-only
  `@exodus/bytes` (`ERR_REQUIRE_ESM`), so `jsdom` is pinned to 26.1.0. The new
  `npm run check:web-bundle` imports the built `diagrams-*.mjs` chunk under
  `--no-experimental-require-module` and runs in CI after `build:web`.
  `web.request.failed` now logs a bounded error message.
- A raw **4 MiB + 1 byte** upload returns HTTP 413. The client and server now
  cap raw image uploads at 4 MiB, below the function's
  [4.5 MB payload limit](https://vercel.com/docs/functions/limitations#request-body-size).
  A signed direct-upload path is not implemented.

Private evidence stays in `/tmp/kan-web-final-*.log` and results JSON, never in
version control. The original `/tmp/kan-web-agent-results.json` was corrected:
its queued calendar tool failed, despite an incorrect historical `complete`
status. The later successful calendar request is **not** retry API coverage.

Observed paid model-step usage before this continuation: **$0.005058315** for the
three reported batches (M0 $0.001513415, first web checks $0.002614615, corrected
calendar $0.000930285). No new paid calls have run in this continuation. A read-only audit of every canvas/run accessible to the synthetic identity
reconciled its four sessions to **$0.0035449**, matching the two web batches above.
The earlier real browser parity run was subsequently audited through its
authenticated stream: one run, five completed model steps, **$0.000519495**.
The combined audited M0 and migration checks total **$0.00557781**. This is
model-step evidence, not an account-wide or invoice reconciliation. The $10
authorization and $9 soft project budget remain; no
credit reload is enabled.

### Remaining acceptance and release limitations

- Final anchor placement, composer anchoring, draft preservation and thread
  selection/history checks passed in Arc. Fresh live **browser-observed**
  streaming/queued/retry/cancel/recovery acceptance remains open (the hosted
  evidence above is HTTP/eve-stream evidence, not a browser session). Two-client
  calendar convergence and eight rendered rich-node types have browser evidence;
  these do not establish full M3 acceptance.
- Synthetic fixture canvases are retained for the pending acceptance. Cleanup is
  deferred until those checks finish; user and M0 data are untouched.
- Meeting context is synthetic (typed segments) by design for Part 1; a partial
  segment that finalizes after a later final has already been processed falls
  below `processed_cursor` and is never read by the agent; a budget pause is not
  undone by Resume. Undo reverts only records the run created and that are
  unchanged since; agent updates to human nodes are reported, not undone.
- Prolonged offline editing, realistic room load/latency,
  event retention/compaction, durable outbox delivery monitoring, abandonment
  cleanup for R2 uploads, backup/restore and production concurrency/billing policy
  remain release hardening work. Events/receipts are durable, but there is no
  separate operational outbox-consumer service or documented retention policy.
- The web and desktop node contracts are reused rather than fully consolidated
  into a single new shared package. Mermaid supports simplified native flowchart,
  state, sequence and mindmap graphs; it is not SVG-layout parity.
- Phase 2 live meetings/video/transcription, desktop data import and retirement
  are outside M1–M3. The staging-only privileged fault hook must be removed or
  explicitly disabled before any production release.

### M5 status — release readiness and cutover decisions (2026-10-12)

What is implemented and locally proven for M5:

- **Backup/restore**: `scripts/web/backup.mjs <canvas> <out.json>` and
  `scripts/web/restore.mjs <in.json> <workspace>` export and re-import one canvas
  (rooms, records, events, threads, runs, messages, assets metadata, meeting
  sessions and segments) preserving ids, revisions and cursors. The regression
  test restores into a fresh database, reconstructs the coordinator to the same
  revision and record hashes, and commits a further change on the restored room.
  Asset bytes in R2 are **not** part of the export; restoring to a different R2
  bucket needs an object copy that is not scripted.
- **Migration drills**: `migrate()` is idempotent; a 002-era database migrates
  forward with seeded rows intact; the migration string is guarded against
  `DROP`/`DELETE`/`TRUNCATE`. Rollback is forward-fix only, by design.
- **Policy is explicit configuration**: `KAN_RUN_CEILING` and
  `KAN_CONTEXT_RUN_CAP` replace the hard-coded staging numbers. In
  `KAN_ENV=production` the run ceiling is required (0 = unlimited), so a
  production deploy cannot silently inherit the staging evaluation budget. The
  `arm-recovery` fault hook is 403 outside `KAN_ENV=staging`; it remains in the
  codebase and must stay disabled in production configuration.

What M5 still needs, and who decides:

| Decision | Options | Needed before |
| --- | --- | --- |
| Production resources | New Vercel project (not the marketing one), production WorkOS environment with real redirect URIs, Neon production branch in the chosen region, a production Cloudflare Worker/DO namespace and R2 bucket, Gateway budget | First production deploy |
| Billing policy | `KAN_RUN_CEILING` (0 = unlimited) and per-session eve limits in `apps/web-agent/agent/agent.ts` (currently $0.10/session, 100k input tokens) | First production deploy |
| Desktop data import | (a) none — web starts empty, desktop stays available; (b) one-time export of local SQLite canvases into web canvases via the backup format (identity remap required: installation ids → WorkOS users) | Cutover |
| Desktop retirement | Keep the Tauri app as-is until web parity is accepted by its users; remove ACP/Vonage/classifier code in a separate cleanup | After cutover |
| Retention | Event compaction/snapshotting and transcript retention are unimplemented; current growth is one `web_events` row per commit | Before sustained production use |

Rollout order once decided: provision → deploy with `KAN_ENV=production` and an
explicit ceiling → run `scripts/web/acceptance.mjs`, `security-acceptance.mjs`,
`realtime-acceptance.mjs` and one bounded `agent-recovery-acceptance.mjs` against
production with a disposable QA workspace → take a `backup.mjs` export and restore
it into a scratch database → invite real users. Staging stays as the rehearsal
environment; nothing in this repository deploys to production automatically.

The sections below retain the architecture and future milestone plan. Earlier M0
acceptance statements describe the historical spike; they do not override the
maintained-workspace evidence above.

## Outcome and scope

Migrate Kan from a Tauri app with participant-owned ACP agents into a browser
product with centrally operated eve sessions. Preserve the shared canvas and thread
experience while replacing native identity, agent launch, peer claims and storage.

**Part 1 is the usable web product:** authentication, workspaces, persistent shared
canvases, chat and a centralized agent that can update the canvas. Typed requests
are the real input. A synthetic transcript adapter exercises the future automatic
meeting-context path without depending on meeting capture.

**Part 2 is live meeting integration:** launch Kan inside Google Meet, select or
create a canvas, automatically start internal capture, and update the canvas from
live speech. Zoom and Teams follow through platform-specific adapters.

No live transcription, Meet bot, extension, Marketplace publication, calendar sync,
or actual meeting capture is required for Part 1 completion. Do not rebuild the old
Jev/Nebius classifiers or ACP trigger/offer/claim system. A new server scheduler is
still necessary to serialize runs, process pending context and enforce budgets.

## Decisions and working defaults

| Topic | Decision or default | Status |
| --- | --- | --- |
| Frontend | TanStack Start, React, TypeScript, existing visual language | Selected |
| Deployment | Vercel for web app and eve | Selected |
| Agent | eve with Vercel AI SDK and AI Gateway | Selected; compatibility spike required |
| Database | Neon PostgreSQL owns all durable application and room data | Selected |
| Realtime | WebSockets; Cloudflare Durable Objects coordinate rooms with disposable caches | Selected architecture; hosted Neon-before-ack/reconstruction/idle hibernation spike passes |
| Auth | WorkOS AuthKit, not user-supplied model credentials | Recommended default; confirm before provisioning |
| Product hierarchy | Workspace → persistent canvas → meeting sessions | Working default |
| Access | Workspace owner/editor/viewer; canvases inherit workspace access | Working default; defer guests/public links |
| Automatic changes | No routine approval; initially change agent-owned content and fulfill scoped explicit requests | Working default; avoid unsolicited deletion/overwriting human work |
| Assets | Object storage; evaluate R2 for existing Cloudflare deployment | Provider decision during foundation milestone |
| Data access | Server-side authenticated APIs; no direct browser database credentials | Proposed implementation |
| SQL layer | Drizzle with explicit SQL migrations, subject to runtime compatibility | Proposed default |
| First meeting host | Google Meet add-on | Selected for Part 2 |
| Capture | Internal implementation; compare caption collection and audio/STT in a spike | Preferred; unresolved mechanism |
| Desktop migration | Preserve local data; no automatic destructive conversion | Selected principle; import requirement remains open |

Authentication proves identity; Kan owns resource authorization. A meeting invitation
or a speaker's name does not grant canvas access. A centralized agent means shared
operations and configuration, with isolated state per workspace/canvas/session.

## Inventory and disposition

Source inspection informed this inventory; running-app parity is not yet verified.
ARCHITECTURE.md contains implemented and historical sections. Use source contracts
when they disagree; this document governs proposed web work only.

| Existing area | Treatment | Concrete migration |
| --- | --- | --- |
| React/TanStack Router/Vite setup | Reuse concepts | New apps/web with Start; keep native app alongside it |
| Canvas.tsx, WorkspacePanels, toolbar, canvas context and theme | Extract/adapt | Preserve canvas interaction, panel resizing, selection and styling; load browser-only code client-side |
| apps/desktop/src/nodes: schema, draft mapping, tools and renderers | Consolidate | Pure validation/planning separated from editor operations and React rendering |
| packages/nodes and lib/canvas-shapes.tsx | Evolve | One versioned schema shared by server, agent tools and all browser renderers |
| ThreadPanel/ChatPanel/thread components | Extract/simplify | Keep messages, anchors, streaming activity, search and transcript grouping; remove executor offers/claims |
| room-server validation, mutation planning, provenance and idempotency | Extract selectively | Preserve safety and correctness invariants without porting the entire engine |
| TLSocketRoom + SQLiteSyncStorage | Adapt | Prove Neon persistence and commit acknowledgement; retain tldraw reconciliation |
| packages/protocol | Add versioned web contracts | Do not break desktop's existing wire protocol during coexistence |
| Jev/Nebius classification and decision policy | Retire from web | New buffered-context scheduler and eve behavior; no old probability-based trigger layer |
| apps/agent-runner, Rust ACP and local MCP bridge | Retire from web | Server tools and eve execution replace child processes and run leases |
| AgentProvider, setup, sign-in and controller | Rewrite | Browser observes server-owned runs; no subscription/API-key dialogs |
| Vonage prejoin/video/caption capture | Retire from web | Later external-meeting adapters; retain reusable transcript presentation |
| Installation identity/local catalog/thread storage/publication | Replace | WorkOS identity, cloud catalog and Neon persistence; preserve old data |
| Diagnostics and QA sources | Adapt | Correlated metadata traces and private reports suitable for browser/server |
| apps/site | Preserve | Keep marketing site separate initially |
| Existing tests | Reuse cases, adapt harnesses | Browser automation plus real server/database tests; native regressions for extracted shared code |

The offline and shared-room node implementations are only partly aligned. The shared
chart renderer is a placeholder. During extraction, audit every current shape type
(markdown, chart, table, image, map, logo, timeline, calendar, native geo and diagrams)
and record supported web parity. Do not claim parity based only on schema acceptance.

## Target architecture

```text
Browsers ── authenticated HTTP ──> TanStack Start / Vercel
   │                                  │             │
   │ WebSockets                       │             └─ eve / AI Gateway
   ▼                                  ▼                        │
Cloudflare room coordinator <──── authorized mutation commands ─┘
   │                                  │
   └────── shared commit service ──────┘
                      │
                      ▼
                 Neon PostgreSQL
            records + revisions + events + outbox
                      │
                      └─ retryable delivery → room clients/run observers

Part 2: meeting host → capture adapter → normalized context → same persistence/run path
```

The commit service is a logical boundary, not necessarily another deployed service.
Choose where it runs after the spike; there must be one defined mutation protocol.

### Persistence and synchronization invariants

1. Neon is authoritative for canvas records, revisions, transcripts, chat and durable
   agent progress. Cloudflare is not a primary store backed up periodically to Neon.
2. Browser edits and agent tools enter the same validated commit protocol. No tool
   writes raw canvas rows outside that protocol.
3. Each accepted change transaction updates records and revision and appends its
   durable event/outbox entry. Deduplication uses stable operation IDs and input hashes.
4. Commit before acknowledging an edit as saved. Optimistic local rendering is fine;
   distinguish local pending state from server acknowledgement.
5. If commit fails, do not acknowledge or broadcast successful persistence. Reconcile
   optimistic state using the sync protocol; provide retry/disconnected feedback.
6. Crashing after commit but before broadcast loses no edit: replay by durable cursor.
   Events and canvas changes need explicit ordering/revision references.
7. Coordinator caches rebuild from Neon. Presence/cursors are ephemeral and recreated.
   Avoid writing pointer movements or heartbeat traffic into the durable document log.
8. Database revision checks and coordinator fencing protect against stale instances,
   overlapping deployments and delayed agent writes. Retry a stale operation only
   after re-reading context; never overwrite new human content blindly.
9. Delivery is at least once. Receivers deduplicate; history replay has a bounded
   highwater and retention/snapshot policy for clients that fall behind.
10. Idle coordinator behavior must support hibernation without data loss. External
    database latency and wake-up reconstruction are measured, not assumed negligible.

Do not assume a drop-in asynchronous PostgreSQL adapter for tldraw's synchronous
storage APIs. Inspect the installed version and prove the actual commit/broadcast
boundary. A periodic snapshot callback is insufficient. If the necessary extension
is too invasive, consider a dedicated Node sync host or another synchronization
implementation; never quietly weaken Neon authority or durability guarantees.

### Application data model

| Entity | Essential fields/constraints |
| --- | --- |
| User | Internal ID, external auth ID, display name; unique external identity |
| Workspace/Membership | Workspace ID, user ID, role; unique membership |
| Invitation | Workspace, intended recipient, role, hashed token, expiry and acceptance |
| Canvas | Workspace, name, schema version, revision, timestamps and deletion state |
| CanvasRecord | Canvas + record ID unique; validated record payload and record version |
| RoomEvent | Canvas + monotonic cursor unique; revision, type, payload, operation ID |
| Outbox | Event reference, target, attempt/next-attempt and delivered status |
| ThreadEntry | Stable ID, canvas, author/source, ordering, content, anchors and run reference |
| AgentRun | Canvas, initiating event, runtime session ID, status, context cursor, budget and cancellation |
| MutationReceipt | Canvas + operation ID unique; input hash, committed revision and outcome |
| Asset | Workspace/canvas ownership, object key, content type, size and lifecycle |
| MeetingSession (Part 2) | Host platform, meeting space, conference occurrence, canvas binding, lifecycle |
| TranscriptSegment (Part 2) | Session + source segment ID unique; speaker, text, time, finality/revision |

Part 1 defines normalized meeting-context types and a test adapter; production
meeting tables may land in Part 2. Do not add unused platform-specific schemas early.
Thread history is application data; eve workflow state is execution data. Persist
references/progress in Neon and provide a reconciliation path if runtime and database
status diverge. Do not rely on runtime-only memory for recoverable context.

### Agent behavior

The browser submits a command and observes the run; disconnecting a tab does not
cancel it. Context contains a bounded canvas summary, selected/anchored records,
recent thread and any accepted context segments. Tools retrieve further context.

Initial tools: readCanvas, readThread, readMeetingContext, add/update/remove nodes,
connect, arrange and group as supported by the unified schema. Camera focus is a
viewer-local UI effect, not a globally persisted document change.

Authenticate scope outside model arguments. Validate tool input/output, bounds,
permissions, asset ownership and graph integrity. Stamp server-owned provenance
with run/operation/evidence IDs. Preserve mutation idempotency across workflow retries.
Ordinary authorized canvas edits do not wait for human approval.

Retire peer offers, claims and readiness. Keep a server-owned queue per canvas,
explicit-request priority, cancellation and bounded execution. For future proactive
context, buffer finalized segments with a settle delay and maximum wait. Persist
pending/processed cursors; arrivals during a run schedule follow-up work. Human and
agent changes must not generate an infinite feedback loop.

Provide visible queued/running/complete/failed/cancelled states, useful tool activity,
pause controls and provenance. Recovery must avoid undoing newer human edits.
Select initial model, maximum steps/tokens, concurrency and spend ceilings during
the agent milestone, after realistic evaluation. Do not inherit old classifier settings.

### Access, assets and operations

Check membership and role for HTTP, socket establishment, replay, tools and uploads.
Use short-lived room-specific socket credentials, and reevaluate revoked membership
for active sessions. WorkOS callback handling and session validation run server-side.
Keep model/database/provider secrets server-only; use private metadata diagnostics.

Object storage contains asset bytes. Neon owns access and object references. Validate
file types/sizes, reconcile abandoned uploads and avoid permanent credential-bearing
URLs in canvas records. Recordings are not retained by default in Part 2.

Use separate development, preview/staging and production environments for Vercel,
Cloudflare, Neon and auth. Preview databases use seeded non-production data; room
namespaces must be isolated too. Place database and execution regions deliberately.
Use additive migrations, tested backups/restores, bounded logs, outbox retries and
alerts for delivery lag, database failures, runs stuck in progress and spend.

## Part 1 implementation milestones

### M0 — Feasibility and contracts

- Inspect tldraw's installed transaction/storage APIs and eve's runtime requirements.
- Build minimal two-browser sync against temporary PostgreSQL, then verify on a Neon
  test branch and Cloudflare test namespace when credentials/resources are available.
- Inject database failure, delayed commit and crashes before/after broadcast. Test
  overlapping coordinators, reconnect replay and an agent-originated mutation.
- Prove eve custom tools, server ingress, streamed observation, restart/resumption
  and cancellation without depending on ACP or an open browser.
- Verify Start/Nitro deployment shape, dependency versions and WorkOS integration.
- Record architecture decisions, measured latency/cost and exact limitations.

**Exit:** demonstrated Neon-before-ack semantics, two-client convergence and a
compatible eve runtime. If blocked, resolve architecture before broad extraction.

M0 implementation evidence and outstanding gates are tracked in
`spikes/m0/FINDINGS.md`, which is kept outside version control together with the
rest of the disposable `spikes/m0` sources. Hosted synthetic tests now demonstrate
Neon-before-ack, SQL failure rollback, fencing, crash reconstruction, surviving
hibernated sockets, two rendered Chromium clients and eve commit-step recovery.
The browser fixture uses a loopback proxy for credentials; it is not the finished
Start application. Basic WorkOS login/callback, session persistence across refresh
and sign-out passed in Arc on the protected stable preview alias (2026-10-12).
The integrated staging continuation now verifies real Gateway inference and a
Vercel Linux source/runtime build for the exercised tools. M0 remains open:
unexercised native-module/sandbox paths and
realistic-document/region/cost measurements remain incomplete. The user subsequently authorized M1–M3 staging implementation. The shared M0
test token is not production authorization.

The existing Kan Vercel project is the marketing site. All M0 deploys are protected
previews from isolated build-output staging; root site config and production aliases
are preserved. The user authorized synthetic schemas in the new kan-production
Neon resource for this run. Future previews must use disposable branches before
production data/traffic exists. The Cloudflare test namespace is separate; production
canvas state stays in Neon. The tested commit-service placement is Vercel iad1 versus
Neon lhr1 and adds substantial latency; compare a colocated service and bounded
record/diff commits before M1/M2 service placement is finalized.

### M1 — Web foundation, database and identity

- Add apps/web and a minimal apps/realtime Cloudflare worker, if M0 confirms it.
  Keep npm workspaces/Turbo and existing desktop commands functional.
- Add scoped scripts, CI and hook support for web/realtime workspaces.
- Set up migrations, data-access boundaries, environment validation and test fixtures.
- Implement sign-in/out, workspace creation, membership roles and invite acceptance.
- Implement authenticated canvas listing/create/rename/open and account states.
- Choose object storage and implement a minimal authenticated asset path.

**Exit:** isolated users/workspaces tested in real browsers; unauthorized read/write,
replay and uploads denied. Preview environment cannot touch production resources.

### M2 — Shared canvas and renderer extraction

- Extract shared schema, renderer and pure mutation planning without breaking desktop.
  Keep React/DOM out of pure server packages; standardize Zod compatibility.
- Port canvas UI, toolbar, panels and assets; cover the audited shape types.
- Implement Neon record commits, schema migrations, revision checks, snapshots,
  durable events/outbox, reconnection and disposable coordinator caches.
- Implement presence and cursor transport separately from durable changes.

**Exit:** two real browsers and refresh/reconnect show the same records; coordinator
restart loses no acknowledged edit; assets and rich nodes render correctly.

### M3 — Thread and centralized eve agent

- Port thread/composer, anchors, activity and streaming presentation.
- Implement durable messages, runs, observation/replay and canvas-scoped queueing.
- Connect eve to validated tools and Gateway; remove native/provider setup from web.
- Add cancellation, pause, retry/reconciliation, provenance and recoverable errors.
- Apply model budgets and workspace concurrency/spend policy.

**Exit:** a typed request produces real server-owned canvas changes for both browsers;
run continues with tabs closed; reopen restores history; duplicates and stale writes
are rejected or reconciled; failures are visible and private diagnostics remain bounded.

### M4 — Future context path and regression hardening

- Define normalized meeting host/capture interfaces and synthetic context ingestion.
- Exercise transcript display, evidence links, buffered automatic runs, pause/cancel,
  partial/final replacement, duplicate segments and context catch-up.
- Test simultaneous browser/agent changes, prolonged disconnects and permission
  revocation. Implement recovery/undo that preserves subsequent human edits.
- Validate narrow layouts, keyboard access, canvas sizing and panel state preservation.
- Load-test realistic room activity and record Cloudflare, Neon and model usage.

**Exit:** complete Part 1 product works without meeting integration. Synthetic tests
are explicitly labeled and do not count as live-transcription/provider coverage.

### M5 — Release and desktop retirement decision

- Validate staging deployment end to end with real WorkOS, Neon, Cloudflare and eve.
- Run restore, migration rollback/forward-fix and operational failure drills.
- Decide existing-data import with the user; if needed, build export/import that
  remaps identities/assets, validates schemas and preserves original desktop data.
- Document rollout, support and service costs. Move web to primary only after parity
  acceptance; remove obsolete ACP/Vonage/classifier code in a separate cleanup.
- Keep desktop available until any required import and cutover are complete.

**Exit:** usable deployed Part 1, documented limitations and an explicit cutover plan.
External deployment/paid calls occur during implementation with applicable authorization,
not as a side effect of writing this plan.

## Part 2 — Meeting integration

### M6 — Internal Google Meet capture spike

Compare reading native captions with capturing audio plus STT. Prefer native text if
reliable; do not assume a supported live transcript feed. Audio capture can use a
speech-to-text service before considering self-hosted inference. Recall is not the
default dependency. Measure total cost, including bot workers and maintenance.

Prove bot admission, several speakers/overlap, language behavior, attribution,
transcript revisions/latency, disconnect recovery and concurrency. Choose worker
hosting only after resource measurements. This workload is separate from room sync
and is not assumed to fit Vercel functions or Durable Objects.

### M7 — Launch and operate Kan inside Meet

- Developer-installed add-on: sign-in, meeting identity, canvas selection/creation,
  side-panel/main-stage UI. Test iframe session restrictions.
- Selecting a canvas automatically starts one capture for the current conference;
  opening the add-on alone does not capture before binding.
- Idempotent start/stop, admission/listening/failure states, conference-end cleanup
  and restart reconciliation. Multiple launchers join one existing session.
- Persist normalized transcript/context in Neon; invoke the M4 automatic path.
- Closing a panel does not terminate capture. Explicit stop/end releases workers.
- Enforce actual canvas permissions independently of meeting invitations.
- Resolve reused meeting codes and concurrent canvas selections explicitly.
- Define recording notice, languages, retention, deletion and budget policies before
  enabling real meeting capture; complete Marketplace review for public distribution.

**Exit:** actual meeting speech updates the shared canvas automatically; evidence and
history remain accessible afterward; restart/rejoin creates no duplicate bot or edit.

### M8 — Zoom and Teams

Implement host adapters for their in-meeting launch surfaces and capture adapters for
available native feeds or internal workers. Investigate each platform's permissions,
costs and distribution requirements independently; do not promise identical capabilities.
Reuse meeting binding, normalized segments, Neon persistence and eve scheduling.

## Verification and completion rules

Each milestone needs unit tests for pure invariants, real database/service integration
checks and browser end-to-end observation appropriate to its scope. Compiling alone
is insufficient. Read the repository e2e skill before feature verification; use native
coverage for shared desktop changes and a dedicated web browser harness for the new
product. Do not drive another developer's app or delete existing user fixtures.

Required failure cases: commit rejection; commit succeeds/broadcast fails; duplicate
operation; stale coordinator; stale agent edit; tab closes during run; reconnect during
replay; outbox backlog; membership revoked; asset missing; workflow retry; cancellation
races; continuous context arrivals; budget exhaustion; service restart/schema upgrade.

Report test counts and what was actually observed. Distinguish mocked transport,
synthetic transcripts, live model execution and live meeting capture. Preserve existing
backend/desktop checks when shared packages change.

## Open choices and when to resolve them

| Choice | Needed by |
| --- | --- |
| Confirm WorkOS and workspace/access defaults | M1 provisioning |
| tldraw persistence strategy and Cloudflare feasibility | M0 exit |
| Asset provider, ORM/driver, service placement and region | M1/M2 |
| Exact rich-node parity and shared schema migrations | M2 |
| Human-content edit policy, model, budgets and recovery UX | M3/M4 |
| Local canvas/history import requirement | M5 cutover |
| Capture method/worker host, languages, latency and retention | M6/M7 |

No new product decisions about meeting capture block Part 1. The first action after
this plan is accepted is **M0: prove tldraw sync with authoritative Neon commits**.

## Technical references

These are researched platform references, not evidence that Kan integrations work:

- [TanStack Start on Vercel](https://vercel.com/docs/frameworks/full-stack/tanstack-start)
- [eve framework](https://github.com/vercel/eve)
- [tldraw sync and storage](https://tldraw.dev/docs/sync)
- [tldraw transport interface](https://tldraw.dev/reference/sync-core/TLPersistentClientSocket)
- [Durable Object hibernation and billing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Neon Vercel preview integration](https://neon.com/blog/neon-vercel-native-integration)
- [WorkOS TanStack example](https://tanstack.com/start/latest/docs/framework/react/examples/start-workos)
- [Meet add-on SDK](https://developers.google.com/workspace/meet/add-ons/guides/overview)
- [Meet transcript lifecycle events](https://developers.google.com/workspace/events/guides/events-meet)
- [Meet Media API access status](https://developers.google.com/workspace/meet/media-api/guides/overview)

Auth continuation (2026-10-12): WorkOS preview/development secrets are provisioned.
The named Kan AuthKit application in the sandbox Staging environment has callback,
initiate-login and logout return URLs registered for the dedicated protected M0
alias. Real user login/callback, session persistence across deployment/refresh and
sign-out/refresh passed in Arc. Production WorkOS and site routing were preserved.
Expiry, rotation, revocation and workspace authorization remain unverified; see
FINDINGS.md for exact evidence and application-ID matching.

Integrated staging (2026-10-12): https://staging.getkan.dev runs Start and eve in
the dedicated `kan-staging` project, with a separate Neon Free database in London,
Neon Auth disabled, and the separate `kan-staging-realtime` Worker/DO. The user's
$10 Gateway authorization is guarded by a non-resetting $9 project budget and
session/request limits. Real chat/tool commits, visible canvas/toolbar, two Arc
clients, peer edits, refresh/history, sign-out and durable cancellation were observed.
Reported model-step usage was about $0.0015. The provided tldraw trial key enables
the hosted renderer. Marketing production is unchanged. That historical deployment was a rectangles-only,
single-account M0 surface; see the local-only `spikes/m0/staging/README.md` and
FINDINGS.md for evidence, the Hobby project/environment choice and limitations.
