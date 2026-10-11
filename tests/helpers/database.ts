import { PGlite } from "@electric-sql/pglite";
import type { Database, Parameter } from "../../src/database/connection";
import { initializeDatabase } from "../../src/database/initialize";

/** Real embedded PostgreSQL, isolated in memory. Tests never read .env or Supabase. */
export async function emptyDatabase(): Promise<Database> {
  const pg = new PGlite();
  const wrap = (
    connection: Pick<PGlite, "query" | "exec">,
    inTransaction = false,
  ): Database => ({
    async query<T extends object>(
      sql: string,
      parameters: Parameter[] = [],
    ): Promise<T[]> {
      if (parameters.length === 0 && sql.includes(";")) {
        await connection.exec(sql);
        return [];
      }
      return (await connection.query<T>(sql, parameters)).rows;
    },
    async transaction<T>(operation: (tx: Database) => Promise<T>): Promise<T> {
      if (inTransaction) return operation(wrap(connection, true));
      return pg.transaction((tx) => operation(wrap(tx, true)));
    },
    async close() {
      await pg.close();
    },
  });
  return wrap(pg);
}

export async function testDatabase(): Promise<Database> {
  const db = await emptyDatabase();
  await initializeDatabase(
    db,
    `${import.meta.dir}/../../database/baseline.sql`,
    `${import.meta.dir}/../../migrations`,
  );
  return db;
}
