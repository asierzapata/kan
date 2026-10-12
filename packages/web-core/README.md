# Kan web core

Pure persistence/hash contracts for the maintained web product. `kan_web_v1` is an
additive schema isolated from M0 and desktop data. `Persistence` owns transactional
records, revisions, operation hashes and events; a single commit writes the record
delta and durable receipt before realtime acknowledgement.

Migrations are additive/idempotent. Do not delete data to resolve a migration.
Commits are bounded to 500 changed records and 2 MiB serialized changes. Duplicate
operation/input hashes return the durable receipt; conflicting inputs are rejected.
Epoch and revision checks fence stale coordinators. Actor-scoped commits lock
membership, canvas and active run state against revocation/cancellation races.

`npm run test:web` uses private PGlite fixtures, real tldraw schemas/sync storage,
pure desktop mapping and a controlled eve client. It covers roles/isolation,
revocation-at-commit, fencing/rollback, crash-after-commit recovery, graph tools,
rich interactive state, fractional indices, Mermaid native graphs, durable queue
reconciliation, safe retry ordering and ambiguous dispatch. These tests do not
establish hosted browser UI, provider inference or realistic load coverage.
