# Kan realtime

Staging Cloudflare Worker and hibernating `WebRoom` Durable Object. Neon remains
authoritative; the coordinator's cache and presence are disposable.

`wrangler.jsonc` fixes the staging account, Worker, private R2 bucket, namespace,
minute queue cron and `WEB_API_URL`. The only shared credential is a Worker secret,
`STAGING_SECRET`; never place it in configuration or frontend code. Keep
`WEB_API_URL` in maintained config: a deployment without it removes an ad-hoc
runtime variable and breaks socket authorization.

Deploy only with this config, from the repository root:

```
WRANGLER_LOG_PATH=/tmp/kan-web-wrangler.log node node_modules/wrangler/bin/wrangler.js deploy --config apps/realtime/wrangler.jsonc
```

Every browser socket presents a signed room-specific expiring ticket. Membership,
role and WorkOS status are reevaluated. Browser and agent writes share bounded
record deltas, Neon-before-ack, database fencing and transactional operation
receipts. A failed persistence barrier discards the cache. Recovery reconstructs
records and clocks from Neon; document events are distinct from ephemeral presence.

The pure planner validates the desktop tool schemas and emits native/rich records.
Mermaid is parsed/sanitized in the Start server, then committed as one validated
native geo/arrow/binding graph. Unsupported syntax fails without partial records.
Supported families: flowchart, state, sequence and mindmap. This is simplified
native layout, not pixel parity with Mermaid's SVG renderer.

`npm run test:web` tests persistence and planner invariants. Hosted synthetic
transport checks: `node --import tsx scripts/web/realtime-acceptance.mjs`; security
checks: `node scripts/web/security-acceptance.mjs`. They require private authorized
fixture files under `/tmp` and staging network access. Never print tickets or
credentials, and never use user or M0 data as disposable fixtures.
