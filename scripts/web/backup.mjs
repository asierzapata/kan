import { writeFile, chmod } from "node:fs/promises";
import { exportCanvas } from "../../packages/web-core/src/backup.mjs";
import { connect } from "./db.mjs";

const [canvas, out] = process.argv.slice(2);
if (!canvas || !out) {
  console.error("Usage: node --import tsx scripts/web/backup.mjs <canvasId> <out.json>");
  process.exit(2);
}
const { db, close } = await connect();
try {
  const snapshot = await exportCanvas(db, canvas);
  await writeFile(out, JSON.stringify(snapshot), { mode: 0o600 });
  await chmod(out, 0o600);
  const counts = Object.fromEntries(
    Object.entries(snapshot)
      .filter(([, value]) => Array.isArray(value))
      .map(([key, value]) => [key, value.length]),
  );
  console.log(`Exported canvas to ${out}`, counts);
} finally {
  await close();
}
