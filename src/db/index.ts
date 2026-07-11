import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "../../drizzle"
);

export function openDb(dbPath: string): Db {
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  const db = drizzle(sqlite, { schema });
  // Foreign keys must be OFF around migrate (better-sqlite3 turns them on at
  // open): drizzle's table-rebuild migrations (e.g. 0009) emit their own
  // `PRAGMA foreign_keys=OFF`, but pragmas are no-ops inside the migration
  // transaction — with enforcement on, the rebuild's `DROP TABLE` fails on
  // any database whose other tables hold rows referencing the rebuilt one
  // (fine on fresh test DBs, fatal on the production NAS — SYD-172). Only a
  // pragma issued OUTSIDE the transaction, like these, actually applies.
  sqlite.pragma("foreign_keys = OFF");
  migrate(db, { migrationsFolder });
  sqlite.pragma("foreign_keys = ON");
  return db;
}
