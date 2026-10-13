import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { Persistence } from "@kan/web-core/persistence";
import type { Config } from "./config.ts";

export interface Tx {
  query(sql: string, args?: unknown[]): Promise<{ rows: any[] }>;
}
export interface Database {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  query(sql: string, args?: unknown[]): Promise<{ rows: any[] }>;
  exec(sql: string): Promise<unknown>;
}

const SCHEMA = "kan_web_v1";

function pgliteDatabase(pglite: PGlite): Database {
  const db: Database = {
    transaction: (fn) =>
      pglite.transaction(async (tx) => {
        await tx.query(`SET LOCAL search_path=${SCHEMA}`);
        return fn(tx as unknown as Tx);
      }),
    query: (sql, args) => db.transaction((tx) => tx.query(sql, args)),
    exec: (sql) =>
      pglite.transaction(async (tx) => {
        await tx.exec(`SET LOCAL search_path=${SCHEMA}; ${sql}`);
      }),
  };
  return db;
}

async function prepared(db: Database, create: () => Promise<unknown>, close: () => Promise<void>) {
  await create();
  const persistence = new Persistence(db);
  await persistence.migrate();
  return { db, persistence, close };
}

export async function memoryDatabase() {
  const pglite = new PGlite();
  return prepared(
    pgliteDatabase(pglite),
    () => pglite.exec(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`),
    () => pglite.close(),
  );
}

export async function openDatabase(config: Pick<Config, "DATABASE_URL" | "KAN_DATA_DIR">) {
  if (!config.DATABASE_URL) {
    const dir = join(config.KAN_DATA_DIR, "pglite");
    mkdirSync(config.KAN_DATA_DIR, { recursive: true });
    const pglite = new PGlite(dir);
    return prepared(
      pgliteDatabase(pglite),
      () => pglite.exec(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`),
      () => pglite.close(),
    );
  }
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 10000,
  });
  const db: Database = {
    async transaction(fn) {
      const tx = await pool.connect();
      try {
        await tx.query("BEGIN");
        await tx.query(`SET LOCAL search_path=${SCHEMA}`);
        const result = await fn(tx);
        await tx.query("COMMIT");
        return result;
      } catch (error) {
        await tx.query("ROLLBACK");
        throw error;
      } finally {
        tx.release();
      }
    },
    query: (sql, args) => db.transaction((tx) => tx.query(sql, args)),
    exec: (sql) => db.query(sql),
  };
  return prepared(
    db,
    () => pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`),
    () => pool.end(),
  );
}
