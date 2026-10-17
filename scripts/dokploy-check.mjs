// Read-only check. Print only selected infrastructure metadata, never raw results.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const envFile = fileURLToPath(new URL("../.env.local", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const client = new Client({ name: "kan-deployment-check", version: "1.0.0" });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL("./dokploy-mcp.mjs", import.meta.url))], stderr: "pipe" });
transport.stderr?.resume();
const timer = setTimeout(() => { console.error("MCP check timed out. Check panel network access and Node/npm PATH."); process.exit(1); }, 60000);
function failure(result) {
  const text = JSON.stringify(result).toLowerCase();
  if (/\b(?:401|403)\b|unauthorized|forbidden/.test(text)) return "authorization failed; check your personal panel key and project access";
  if (/timeout|timed out|etimedout/.test(text)) return "panel request timed out; check DNS, VPN and panel reachability";
  if (/enotfound|econnrefused|fetch failed/.test(text)) return "panel network request failed; check DNS, VPN and DOKPLOY_URL";
  return "panel returned an error; inspect it in the panel without sharing secrets";
}
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 20000 });
  const block = result.content?.find((item) => item.type === "text");
  let data;
  try { data = JSON.parse(block?.text ?? "null"); } catch { throw Error(`${name}: unexpected response format`); }
  if (result.isError || data?.success === false) throw Error(`${name}: ${failure(data)}`);
  return data?.data ?? data;
}
function objects(value) {
  if (!value || typeof value !== "object") return [];
  return [value, ...Object.values(value).flatMap(objects)];
}
function pick(value, fields) {
  return Object.fromEntries(fields.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}
try {
  if (!process.env.DOKPLOY_API_KEY) throw Error("Set DOKPLOY_API_KEY in root .env.local before checking the panel.");
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(`MCP initialized: ${tools.length} tools (this alone does not verify panel access).`);
  if (!process.argv.includes("--tools-only")) {
    const projects = await call("project-all");
    console.log("Panel API reachable; authorized project inventory retrieved.");
    const entries = objects(projects);
    const candidates = entries.filter((item) => item.composeId && item.appName);
    const expected = process.env.KAN_DOKPLOY_APP_NAME || "kan-se2scu";
    const compose = candidates.find((item) => item.appName === expected);
    if (!compose) throw Error(`Expected compose service not found (${expected}); ask the project owner to check membership and service name.`);
    const response = await call("compose-one", { composeId: compose.composeId });
    const details = objects(response).find((item) => item.composeId === compose.composeId);
    if (!details) throw Error("compose-one: unexpected service response; inspect the panel directly");
    console.log(JSON.stringify(pick(details, ["name", "appName", "composeId", "sourceType", "branch", "customGitBranch", "composePath", "composeStatus"]), null, 2));
    const deployments = await call("deployment-allByCompose", { composeId: compose.composeId });
    console.log("Recent deployments:", JSON.stringify(objects(deployments).filter((item) => item.deploymentId)
      .slice(0, 5).map((item) => pick(item, ["deploymentId", "status", "createdAt"]))));
  }
} catch (error) {
  // SDK/network messages may include URLs or raw server output; never echo them.
  const message = String(error.message);
  console.error(/^(project-all|compose-one|deployment-allByCompose):|^Expected compose|^Set DOKPLOY_API_KEY/.test(message)
    ? message : `MCP check failed: ${failure({ error: message })}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await client.close();
}
