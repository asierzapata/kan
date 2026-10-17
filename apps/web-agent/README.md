# Kan web agent

Self-hosted eve agent using AI Gateway (`openai/gpt-6-luna`). No native ACP,
provider subscription dialogs, terminal tools or default eve tools are exposed.

Each tool calls `apps/server` at `${WEB_API_URL}/internal` with
`Authorization: Bearer ${KAN_SERVICE_SECRET}`. The server derives canvas, user and
run scope from the stored eve session id, validates the desktop node contracts,
requires the revision returned by `getCanvas` for mutations, and uses stable
`<run>:<callId>` operation ids. Reads are bounded; focus is a viewer-local intent.
Image references cannot cross canvas ownership.

Mutation calls execute as durable workflow steps. Stable receipts recover a step
that committed but lost its result. The staging-only `arm-recovery` fixture can
terminate a tool step after commit (the server only honours it when
`KAN_ENV=staging`, for QA-named canvases and active runs). Keep it disabled in
production.

## Run

- `npm run dev:stack` runs the server, web app and this agent together.
- `npm run dev:agent` (`eve dev --port 3100 --no-ui`) or `npm run start:agent`
  (`eve build`, then `eve start --port 3100`). The port is explicit because the
  server reads `PORT` from the same root `.env.local`.
- `npm run stack:up` builds `apps/web-agent/Dockerfile` (context: repo root) and
  runs it with the server; the agent listens on 3000 inside the compose network
  and publishes no port. `WORKFLOW_POSTGRES_URL` is read by `eve build` (it selects
  the workflow world), so pass it as a build arg as well as at runtime.
- `npm run typecheck -w @kan/web-agent`

## Configuration

From the repository root, `npm run dev:agent` and `npm run start:agent` (build, then
start) run eve from this directory with the root `.env.local` preloaded
(`node --env-file-if-exists`). `eve dev` alone only reads env files in this
directory and `eve start` reads none, so use the root scripts or export the
variables yourself.

| Variable | Purpose |
| --- | --- |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway credential for the model. |
| `KAN_SERVICE_SECRET` | Shared bearer secret. Must equal the server's value; it authenticates the server's calls to the agent channel and the agent's calls back. |
| `WEB_API_URL` | `apps/server` API base, e.g. `http://localhost:8787/api/web`. |
| `PORT` | Fallback listen port when no `--port` flag is given (the root scripts pass `--port 3100`, so a shared `PORT` does not matter). |
| `WORKFLOW_POSTGRES_URL` | Optional. When set at build/start, durable workflow state uses `@workflow/world-postgres` instead of the local world (it also reads `DATABASE_URL`, `WORKFLOW_POSTGRES_JOB_PREFIX`, `WORKFLOW_POSTGRES_WORKER_CONCURRENCY`). Run the package's `bootstrap` once to create its tables. |

Point the server's `EVE_URL` at this agent (for example `http://localhost:3000`).
The server calls the agent under `/eve/`, and the workflow runtime needs
`/.well-known/workflow/` reachable by the agent's own worker. With the Postgres
world those routes carry no authentication: keep `/.well-known/workflow/v1/flow`
unreachable from outside (loopback delivery does not need the ingress) and read
the package README's security section before exposing the agent.

See the web README for queue and retry policy and WEB_MIGRATION.md for observed
live-provider coverage. Live tests spend credits and must stay within the
explicit budget. Report completed-step usage separately from billed
infrastructure.
