# Kan web

Maintained TanStack Start browser application. It coexists with the Tauri desktop
workspace and imports the desktop theme, panel/chat primitives, rich renderers,
node contracts and editor tools without modifying desktop source.

Use Node 24 and the repository's npm workspaces:

- `npm run dev:web` (port 1430, strict port)
- `npm run typecheck:web`
- `npm run build:web`
- `npm run test:web` (web-core integration regressions)
- `npm run check:web-bundle` (after `build:web`; imports the built Mermaid
  parsing chunk the way the Vercel function does)

`jsdom` is pinned to 26.1.0 and kept external to the Nitro server bundle with
`traceDeps`, together with `dompurify` and `mermaid`. Inlining jsdom breaks on
`__dirname`; jsdom 29 requires an ESM-only dependency that the Vercel Node
runtime refuses to `require()`. Both failures only appear in the built bundle,
which is what the bundle check exists for.

## Staging deployment

`node scripts/web/stage.mjs` packages Start and the root eve agent into
`/tmp/kan-web-staging-source`. Verify its `.vercel/project.json` names project
`prj_0Lyk84unyBsbBIdBoc9f26MZ2FyM`, team
`team_akRYoQmwKh1BfjdZhygO8zbp` before deploying. This project alone owns
https://staging.getkan.dev. Its primary target is called production by Vercel,
but it is the isolated staging project. Never deploy this app from the repository
root or alter the marketing project.

Server configuration: `KAN_ENV=staging`, the named WorkOS sandbox application's
`WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, AuthKit cookie configuration, an unpooled
staging Neon URL, `STAGING_SECRET`, `STAGING_WORKER_URL`, `WEB_API_URL` and eve's
private service binding `EVE_INTERNAL_URL`. Never expose these to client bundles.
The tldraw license is a publishable `VITE_TLDRAW_LICENSE_KEY`.

## Access and assets

WorkOS authenticates users; Neon memberships authorize workspace/canvas access.
Owner manages invitations and members; editor writes; viewer reads. Invitations
are recipient-bound links (no email delivery), with hashed tokens and seven-day
expiry. Canvas deletion is a soft delete. HTTP handlers enforce origin on writes.

WorkOS remote session status is checked server-side, with a bounded 30-second
active-session cache. Room tickets last one minute; sockets reevaluate role and
session on traffic and alarms. Role changes close old sockets before reconnect.
Database commits lock membership/canvas and active run rows to fence revoked
writers and cancelled/replaced runs at the durable mutation boundary.

PNG/JPEG/WebP/GIF uploads proxy through the authenticated function to private R2.
Client and server limit raw files to **4 MiB**, below Vercel's 4.5 MB function
payload ceiling. Signatures are checked. Asset URLs are authenticated application
URLs, scoped by canvas ownership; bytes have private/no-store caching. This is
not a signed direct-upload implementation. Failed metadata insertion can leave an
unreferenced R2 object; lifecycle reconciliation remains a release-hardening gap.

## Canvas and agent

The browser uses tldraw sync, native shape utils and all eight desktop rich-node
renderers. Local camera/selection/draft state remains viewer-local. Shape changes
use the authoritative bounded record commit protocol in `@kan/web-core`.

Neon owns threads, messages, run state and queueing; eve owns execution sessions.
Runs serialize per canvas. HTTP observation streams scoped eve events and polls
Neon history. A disconnect does not cancel execution. The DO alarm and minute
cron reconcile queues independently of browser polling.

Explicit retry is author-only, editor-only and limited to twice. Saved mutation
receipts and retry limits are checked before resetting the old eve session. A
run that saved changes cannot be blindly replayed; inspect the canvas and submit
a contextual request. Ambiguous dispatch is never automatically resent. If a
parked dispatch has no started turn after five minutes, it becomes a visible
failure eligible for explicit reconciliation/retry. Cancellation preserves edits
already committed. Staging has a 20-run evaluation ceiling, including fixtures,
and bounded eve session/token/cost limits; these are not production billing policy.

Undo reverts a finished turn (complete, failed or cancelled) once, editor-only.
It removes only records the turn created whose live document still matches what
the turn committed, plus the bindings and children that depend on them. Created
records a person changed afterwards, records the turn merely updated (such as
human-authored nodes), and agent records that human-created records depend on are
left alone and reported. The turn's saved receipts stay in place, so a reverted
turn still cannot be blindly retried.

## Environment

Names only; values live in the deployment's secret store.

| Variable | Purpose |
| --- | --- |
| `KAN_ENV` | `staging` or `production`; fixture hooks (`arm-recovery`) work only in `staging`. |
| `KAN_RUN_CEILING` | Maximum runs stored per database; `0` means unlimited. Defaults to `20` when unset in staging. Required when `KAN_ENV=production`; the first run attempt fails loudly without it. |
| `KAN_CONTEXT_RUN_CAP` | Automatic meeting-context runs per meeting before it pauses (`0` means unlimited, default `20`). |
| `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD`, `WORKOS_REDIRECT_URI` | WorkOS AuthKit sign-in. |
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | PostgreSQL. The app uses the unpooled URL when present; backup and restore scripts read `DATABASE_URL`. |
| `STAGING_SECRET` | Shared bearer secret between the web app, the worker and the agent. |
| `STAGING_WORKER_URL` | Realtime worker base URL. |
| `WEB_API_URL` | Public `/api/web` base URL used by the agent and the worker. |
| `EVE_INTERNAL_URL` | Agent runtime base URL (bound by the deployment). |
| `VITE_TLDRAW_LICENSE_KEY` | tldraw license for the canvas bundle. |

## Backup and restore

`node scripts/web/backup.mjs <canvasId> <out.json>` writes one canvas (records,
events, threads, runs, messages, assets and meeting data) with mode 0600.
`node scripts/web/restore.mjs <in.json> <workspaceId>` imports it into a database
where that canvas does not exist yet. Both need `DATABASE_URL`, print row counts
only, and are operator tools.

See [WEB_MIGRATION.md](../../WEB_MIGRATION.md) for actual acceptance evidence and
remaining gates. Browser tests do not establish Tauri/native coverage. Live
meetings, video and transcription belong to phase 2.
