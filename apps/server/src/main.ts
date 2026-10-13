import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./database.ts";
import { createServer } from "./server.ts";

const config = loadConfig();
const { db, persistence, close: closeDatabase } = await openDatabase(config);
mkdirSync(config.KAN_DATA_DIR, { recursive: true });
const sqlite = new DatabaseSync(join(config.KAN_DATA_DIR, "rooms.sqlite"));
sqlite.exec("PRAGMA journal_mode=WAL");

const app = createServer({
  config,
  db,
  persistence,
  sqlite,
});
const port = await app.listen(config.PORT);
console.log("server.listening", { port });

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    try {
      await app.close();
      sqlite.close();
      await closeDatabase();
    } finally {
      process.exit(0);
    }
  });
