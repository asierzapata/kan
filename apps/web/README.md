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

See [WEB_MIGRATION.md](../../WEB_MIGRATION.md) for actual acceptance evidence and
remaining gates. Browser tests do not establish Tauri/native coverage. Live
meetings, video and transcription belong to phase 2.
