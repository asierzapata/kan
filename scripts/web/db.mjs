import pg from "pg";
import { Persistence } from "../../packages/web-core/src/persistence.mjs";

export async function connect() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is not set; refusing to run.");
    process.exit(2);
  }
  const schema = "kan_web_v1";
  const pool = new pg.Pool({ connectionString, max: 1 });
  const db = {
    async transaction(fn) {
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
    query(sql, args) {
      return this.transaction((tx) => tx.query(sql, args));
    },
    exec(sql) {
      return this.query(sql);
    },
  };
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await new Persistence(db).migrate();
  return { db, close: () => pool.end() };
}
