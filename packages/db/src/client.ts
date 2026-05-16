import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "./schema";

export type Db = BunSQLiteDatabase<typeof schema>;

export const DEFAULT_DB_DIRECTORY = join(process.env.HOME ?? ".", ".langcost");
export const DEFAULT_DB_PATH = join(DEFAULT_DB_DIRECTORY, "langcost.db");

export function resolveDbPath(path?: string): string {
  return path ?? DEFAULT_DB_PATH;
}

export function ensureDbDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

export function createDb(path?: string): Db {
  const dbPath = resolveDbPath(path);
  ensureDbDirectory(dbPath);

  const sqlite = new Database(dbPath, { create: true });
  sqlite.run("PRAGMA journal_mode = WAL;");
  // Wait up to 5s for the writer lock instead of failing instantly with SQLITE_BUSY.
  // Lets concurrent `langcost scan` invocations serialize cleanly.
  sqlite.run("PRAGMA busy_timeout = 5000;");
  sqlite.run("PRAGMA foreign_keys = ON;");
  return drizzle({ client: sqlite, schema });
}

export function getSqliteClient(db: Db): Database {
  return (db as unknown as { $client: Database }).$client;
}
