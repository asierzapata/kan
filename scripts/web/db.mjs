import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "../../apps/server/src/config.ts";
import { openDatabase } from "../../apps/server/src/database.ts";

// Run with `node --import tsx`. Uses DATABASE_URL, or the local PGlite directory
// under KAN_DATA_DIR (default data/server); stop the server first in that case.
export async function connect() {
  loadEnvFile();
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const { db, close } = await openDatabase({
    DATABASE_URL: process.env.DATABASE_URL,
    KAN_DATA_DIR: process.env.KAN_DATA_DIR ?? join(root, "data", "server"),
  });
  return { db, close };
}
