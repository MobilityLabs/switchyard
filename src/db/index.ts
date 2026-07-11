import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

/** The transaction handle Drizzle passes into `db.transaction((tx) => ...)` —
 * derived from `Db["transaction"]` itself so it always matches whatever
 * driver/schema `Db` is defined with, instead of duplicating drizzle's
 * internal transaction class generics. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** What shared service helpers should accept: they're called both with the
 * top-level `Db` and with the `tx` handle inside `db.transaction(...)`. */
export type DbOrTx = Db | Tx;

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "../../drizzle"
);

export function openDb(dbPath: string): Db {
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return db;
}
