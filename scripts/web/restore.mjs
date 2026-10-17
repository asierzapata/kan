import { readFile } from "node:fs/promises";
import { importCanvas } from "../../packages/web-core/src/backup.mjs";
import { connect } from "./db.mjs";

const [input, workspace] = process.argv.slice(2);
if (!input || !workspace) {
  console.error("Usage: node --import tsx scripts/web/restore.mjs <in.json> <workspaceId>");
  process.exit(2);
}
const snapshot = JSON.parse(await readFile(input, "utf8"));
const { db, close } = await connect();
try {
  console.log("Restored canvas", await importCanvas(db, snapshot, { workspace }));
} finally {
  await close();
}
