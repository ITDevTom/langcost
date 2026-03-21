import { createDb, type Db, getSqliteClient, migrate } from "@langcost/db";

export async function withDb<T>(
  dbPath: string | undefined,
  run: (db: Db) => Promise<T> | T,
): Promise<T> {
  const db = createDb(dbPath);

  try {
    migrate(db);
    return await run(db);
  } finally {
    getSqliteClient(db).close(false);
  }
}
