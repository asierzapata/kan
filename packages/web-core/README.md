# Kan web core

Shared persistence, operation hashes, migrations and canvas backup/import helpers
for the web product. Data lives in the additive `kan_web_v1` schema, on embedded
PGlite in development and Postgres in hosted deployments.

`apps/server` owns room synchronization. It acknowledges edits through local
SQLite before debounced write-behind to Postgres; `Persistence` is not the
realtime acknowledgment boundary. Agent writes use the room queue and durable
receipts. See [the architecture](../../ARCHITECTURE.md) for the full flow.

Append migrations in `migrations/` and update `src/migration.mjs` to match. Never
edit applied migrations or delete data to resolve a migration error. The migration
test checks the concatenated source against the SQL files.

`npm run test:web` runs the migration, meeting/context and run-policy checks with
isolated PGlite fixtures. Server integration suites (`npm run test:backend`) cover
HTTP/auth, WebSocket synchronization, room persistence, tools, assets, backup and
retry/undo behavior. Run `npm run test:smoke` for the real browser/server flow;
these checks do not establish paid-provider or native Tauri coverage.

[Backup and recovery](../../DEPLOY.md#backup-and-recovery) includes commands and
asset-byte/volume requirements.
