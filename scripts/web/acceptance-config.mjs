import { readFile, stat } from "node:fs/promises";

export const production = Boolean(process.env.KAN_ACCEPTANCE_CONFIG);
const configPath = process.env.KAN_ACCEPTANCE_CONFIG || "/tmp/kan-staging-private.json";
if (production && ((await stat(configPath)).mode & 0o077))
  throw Error("Production acceptance config must have mode 0600");
export const config = JSON.parse(await readFile(configPath, "utf8"));
export const origin = production ? config.origin : "https://staging.getkan.dev";
export const workerUrl = production ? config.workerUrl : "https://kan-staging-realtime.clipdoc.workers.dev";
if (production && (origin !== "https://app.getkan.dev" || workerUrl !== "https://realtime.getkan.dev"))
  throw Error("Unexpected production acceptance target");
export const artifact = (name) => `/tmp/${production ? "kan-prod" : "kan-web"}-${name}.json`;

export function authEnvironment() {
  if (production) {
    if (!config.WORKOS_API_KEY || !config.WORKOS_CLIENT_ID)
      throw Error("Production WorkOS credentials are required");
    process.env.WORKOS_API_KEY = config.WORKOS_API_KEY;
    process.env.WORKOS_CLIENT_ID = config.WORKOS_CLIENT_ID;
  } else {
    process.loadEnvFile("/tmp/kan-m0-development-private.env");
    if (process.env.WORKOS_CLIENT_ID !== "client_01M4R7WXNY5K5GQBN0GYE64G7F")
      throw Error("Wrong staging WorkOS application");
  }
}
