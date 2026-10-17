import type { PGlite } from "@electric-sql/pglite";
import {
  CompiledQuery,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
} from "kysely";

class PGliteConnection implements DatabaseConnection {
  constructor(private client: PGlite) {}
  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    const result = await this.client.query<R>(query.sql, [...query.parameters]);
    return { rows: result.rows, numAffectedRows: result.affectedRows === undefined ? undefined : BigInt(result.affectedRows) };
  }
  // eslint-disable-next-line require-yield
  async *streamQuery(): AsyncIterableIterator<never> {
    throw new Error("PGlite does not support streaming");
  }
}

class PGliteDriver implements Driver {
  constructor(private client: PGlite) {}
  async init() {}
  async acquireConnection() {
    return new PGliteConnection(this.client);
  }
  async beginTransaction(connection: DatabaseConnection) {
    await connection.executeQuery(CompiledQuery.raw("BEGIN"));
  }
  async commitTransaction(connection: DatabaseConnection) {
    await connection.executeQuery(CompiledQuery.raw("COMMIT"));
  }
  async rollbackTransaction(connection: DatabaseConnection) {
    await connection.executeQuery(CompiledQuery.raw("ROLLBACK"));
  }
  async releaseConnection() {}
  // The PGlite instance is owned by database.ts and closed there.
  async destroy() {}
}

export function pgliteDialect(client: PGlite): Dialect {
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new PGliteDriver(client),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
}
