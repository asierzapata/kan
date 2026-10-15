// Starts the official Dokploy MCP server (stdio) against our panel.
//
// MCP clients launch this with a bare environment, so the per-user API key is
// read from the root .env.local (DOKPLOY_API_KEY) rather than committed in any
// client config. See DEPLOY.md.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const envFile = join(root, ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);

if (!process.env.DOKPLOY_API_KEY) {
  console.error("dokploy-mcp: set DOKPLOY_API_KEY in .env.local (Dokploy → Settings → API Keys)");
  process.exit(1);
}

const env = {
  ...process.env,
  DOKPLOY_URL: process.env.DOKPLOY_URL ?? "https://dokploy.asierzapata.com",
  // The full API is 500+ tools; load only what deploying and debugging Kan needs.
  DOKPLOY_ENABLED_TAGS:
    process.env.DOKPLOY_ENABLED_TAGS ?? "project,environment,server,compose,domain,deployment,docker",
};

const child = spawn("npx", ["-y", "@dokploy/mcp@0.30.7"], { stdio: "inherit", env });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
