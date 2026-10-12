import pg from "pg";
import { Persistence } from "@kan/web-core/persistence";
let ready: Promise<any> | undefined;
export function database(): Promise<any> {
  return (ready ??= (async () => {
    // Reuse staging credentials only. A new additive schema keeps M0 data intact.
    if (process.env.KAN_ENV !== "staging")
      throw new Error("Web environment must be explicitly staging");
    const schema = "kan_web_v1";
    const pool = new pg.Pool({
      connectionString:
        process.env.DATABASE_URL_UNPOOLED ||
        process.env.POSTGRES_URL_NON_POOLING,
      max: 3,
      connectionTimeoutMillis: 10000,
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    const db = {
      async transaction(fn: (tx: pg.PoolClient) => Promise<any>) {
        const tx = await pool.connect();
        try {
          await tx.query("BEGIN");
          await tx.query(`SET LOCAL search_path=${schema}`);
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
      query(sql: string, args?: unknown[]) {
        return this.transaction((tx) => tx.query(sql, args));
      },
      exec(sql: string) {
        return this.query(sql);
      },
    };
    const persistence = new Persistence(db);
    await persistence.migrate();
    return { db, persistence };
  })().catch((error) => {
    ready = undefined;
    throw error;
  }));
}
