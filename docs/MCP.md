# Team access and MCP setup

MCP connections and credentials are personal. Cloning/pulling this repository
provides the wrapper and instructions, not access to someone else's accounts.
Local development needs none of the deployment permissions below.

## Request access

Ask the project owner for invitations to the resources you operate:

| Service | Access needed | Check after connecting |
| --- | --- | --- |
| GitHub | Repository membership/push rights and CI visibility | Fetch main and inspect a Repository checks run |
| Dokploy | `Kan` project access; deploy/environment/log permissions for operators | List projects, inspect `kan` compose and recent deployments |
| Neon | `kan-prod` project/organization access; read access for diagnosis, branch/admin rights only when needed | List project/branches and identify database before any query |
| Cloudflare | Correct account/zone with R2 and Tunnel permissions for your duties | Identify zone, tunnel and `kan-prod-assets` bucket |
| Vercel | Landing-site project/team membership | Identify the site's project and latest deployment |
| AI Gateway | A personal/team development credential with an agreed spend limit | A small local agent prompt completes successfully |

Use the provider's official MCP integration/plugin in your client and authenticate
with your own account. See [Neon MCP](https://neon.com/docs/ai/neon-mcp-server),
[Cloudflare MCP](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/)
and [Vercel MCP](https://vercel.com/docs/agent-resources/vercel-mcp). Their OAuth connection
must be established per teammate; repository files cannot grant access. Start
with resource listing and confirm the environment before running mutations.

The Dokploy panel is https://dokploy.asierzapata.com. VM LAN addresses in
[DEPLOY.md](../DEPLOY.md) need LAN or VPN access. Ask the owner for the approved
network route if unreachable; don't disable TLS checks or share a personal key.

## Dokploy wrapper

1. Log into Dokploy and create your own API key in **Settings → API Keys**.
2. Add `DOKPLOY_API_KEY=...` to root `.env.local`. Don't overwrite the file if it
   already contains development settings. Keep the key out of MCP config and chat.
3. Ensure Node 24/npm are available on your MCP client's PATH; GUI clients may
   need an absolute path to the Node executable.
4. Run from the repo root:

   ```sh
   npm run mcp:check -- --tools-only
   npm run mcp:check
   ```

The first command verifies process startup and tool discovery. The second makes
read-only panel API requests, locates `kan-se2scu`, and prints selected service
metadata and recent deployment statuses. It never deploys or prints raw
environment values. A timeout, missing project, or authentication error exits
nonzero. Don't report deployment access as working based on tool discovery alone.

The wrapper pins `@dokploy/mcp@0.30.7` and enables the project, environment,
server, compose, domain, deployment and docker tags. The package is downloaded by
npx on first use. Optional settings in `.env.local`:

- `DOKPLOY_URL`: override the panel origin.
- `DOKPLOY_ENABLED_TAGS`: adjust tool discovery (not an authorization boundary).
- `DOKPLOY_TIMEOUT`: upstream timeout in milliseconds, default 10000.
- `DOKPLOY_RETRY_ATTEMPTS`: default 1, so network problems fail promptly.
- `DOKPLOY_REDACT_ENV`: keep `true`; it redacts secret-bearing response fields.
- `KAN_DOKPLOY_APP_NAME`: optional target for the check command, default `kan-se2scu`.

MCP may still return private application logs. Inspect output before sharing it;
redaction does not guarantee arbitrary log text is secret-free. See the
[official Dokploy MCP reference](https://github.com/Dokploy/mcp).

## Register with your client

Run registration commands from the repo root. `"$PWD/..."` expands to your
laptop's absolute checkout path; it keeps working when the client starts in a
different directory. Re-register after moving the checkout. Use a client-unique
name if you already operate another Dokploy instance.

**Codex CLI** (also see [official OpenAI MCP documentation](https://developers.openai.com/codex/mcp)):

```sh
codex mcp add kan-dokploy -- node "$PWD/scripts/dokploy-mcp.mjs"
codex mcp list
```

For TOML-based configuration, put this in your personal config with your own
absolute paths, then restart/reconnect the client:

```toml
[mcp_servers.kan-dokploy]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/kan/scripts/dokploy-mcp.mjs"]
startup_timeout_sec = 60
tool_timeout_sec = 30
```

**Claude Code:**

```sh
claude mcp add kan-dokploy -- node "$PWD/scripts/dokploy-mcp.mjs"
```

**Cursor / other JSON MCP clients:** use your own absolute paths in the client's
MCP configuration. Don't commit machine-specific paths:

```json
{
  "mcpServers": {
    "kan-dokploy": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/kan/scripts/dokploy-mcp.mjs"]
    }
  }
}
```

**Devin:** `.devin/mcp_config.json` already launches the wrapper for a repo-root
session. For a client that launches elsewhere, configure the absolute path above.

## Verify and troubleshoot operations

After connecting, ask for read-only checks in this order:

1. List projects and find `Kan`; locate the compose service `kan` / `kan-se2scu`.
2. Inspect its Git branch, compose path, status and latest deployment. The intended
   branch is main; the last recorded panel source was single-server. Confirm the
   actual setting before deploying.
3. Inspect deployment/build logs and each container's health and recent logs.
4. Probe the public app `/healthz` and exercise a disposable browser canvas.

Use [DEPLOY.md](../DEPLOY.md) for deployments, rollback and recovery. An AI client
having mutation tools available is not evidence that a deployment succeeded.

| Failure | Next check |
| --- | --- |
| MCP won't initialize | Node/npm PATH, local key presence, npx registry access, first-start download time |
| Tools appear but project lookup times out | Panel DNS/TLS/network reachability, approved VPN/LAN route, panel availability |
| 401/403 | Personal key validity and project role; ask the owner to grant the needed access |
| Project/service missing | Correct account/panel and project invitation; confirm app name |
| Deploy succeeds but app fails | Runtime logs, `/healthz`, public origin, DB/R2 config, hosted tldraw license |
| Agent health passes but turns fail | AI Gateway credential/budget, matching service secrets and callback URL |

As of 17 October 2026, local tool discovery passed but requests to this panel
were timing out from the audit environment. This guide and check command make
that failure visible; they do not claim the external network/service is repaired.
