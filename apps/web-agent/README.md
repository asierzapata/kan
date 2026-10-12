# Kan web agent

Server-owned eve agent using AI Gateway (`openai/gpt-6-luna`). No native ACP,
provider subscription dialogs, terminal tools or default eve tools are exposed.
The staging source packager copies this authored agent beside the Start service.

Each tool authenticates server-to-server, and Start derives canvas/user/run scope
from the stored session association. Tools validate desktop contracts, require
current canvas revisions and use stable run/call operation IDs. Reads are bounded;
focus is a viewer-local intent. R2 image references cannot cross canvas ownership.

Mutation calls execute as durable workflow steps. Stable receipts recover a step
that committed but lost its result. The staging-only `arm-recovery` fixture can
terminate a tool step after commit; only QA-named canvases and active runs qualify.
This privileged fault hook is for synthetic acceptance and must be removed or
explicitly disabled before any production release.

`npm run typecheck -w @kan/web-agent` and `npm run build -w @kan/web-agent`
verify source. See the web README for queue/retry policy and WEB_MIGRATION.md for
observed live-provider coverage. Do not call the corrected calendar new-request
check a retry API test. Live tests spend credits and must stay within the user's
explicit budget. Report completed-step usage separately from billed infrastructure.
