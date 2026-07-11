import { describe, it, expect } from "vitest";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openDb } from "../../src/db/index.js";

// SYD-148's 0009 migration rebuilds `issues` (create __new_issues → DROP
// TABLE issues → rename). Its leading `PRAGMA foreign_keys=OFF` is a no-op
// inside the migration transaction, so with enforcement already ON the DROP
// fails the moment other tables hold rows referencing issues. Every test DB
// is freshly migrated (no referencing rows), which is why this crashed only
// on the production NAS (SYD-172). openDb must therefore migrate BEFORE
// turning foreign_keys on.
describe("openDb migrations on a database with live referencing rows", () => {
  /** A DB migrated to 0008 (pre-SYD-148) holding an issue plus an event row
   * that references it — the minimal shape of the production data that made
   * the 0009 table rebuild blow up. */
  function makePreRebuildDbWithData(): string {
    const work = mkdtempSync(path.join(tmpdir(), "migration-fk-rebuild-"));
    const truncated = path.join(work, "drizzle-0008");
    cpSync(path.resolve("drizzle"), truncated, { recursive: true });
    const journalPath = path.join(truncated, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
    // Cut at 0009 AND everything after: drizzle applies pending migrations by
    // timestamp order, so leaving a later migration (0010+) in the fixture
    // would mark 0009 as already-covered and it would never run in openDb.
    journal.entries = journal.entries.filter((e) => Number(e.tag.slice(0, 4)) < 9);
    writeFileSync(journalPath, JSON.stringify(journal));
    for (const f of readdirSync(truncated)) {
      if (/^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) >= 9) rmSync(path.join(truncated, f));
    }

    const dbPath = path.join(work, "prod-like.db");
    const sqlite = new Database(dbPath);
    sqlite.pragma("foreign_keys = ON");
    migrate(drizzle(sqlite), { migrationsFolder: truncated });
    sqlite.prepare("INSERT INTO projects (key, name) VALUES ('SYD','switchyard')").run();
    sqlite.prepare("INSERT INTO actors (name, type) VALUES ('sean','human')").run();
    sqlite
      .prepare(
        "INSERT INTO issues (project_id, number, title, status, creator_id) VALUES (1, 1, 'x', 'todo', 1)",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO events (issue_id, actor_id, type, payload) VALUES (1, 1, 'created', '{}')",
      )
      .run();
    sqlite.close();
    return dbPath;
  }

  it("applies the 0009 issues-table rebuild instead of crashing (SYD-172)", () => {
    const dbPath = makePreRebuildDbWithData();

    const db = openDb(dbPath);

    // Enforcement is back on for the app connection: a dangling reference is
    // rejected on the very handle openDb returned (drizzle wraps the SQLite
    // error, so the FK detail lives on `cause`).
    let refused: unknown;
    try {
      db.run(
        sql`INSERT INTO events (issue_id, actor_id, type, payload) VALUES (999, 1, 'x', '{}')`,
      );
    } catch (e) {
      refused = e;
    }
    expect(String((refused as { cause?: unknown })?.cause ?? refused)).toMatch(/FOREIGN KEY/i);

    // Structure and data checks on a second raw connection: the rebuild
    // landed (parent_id now carries SYD-148's FK), the rows survived the
    // copy, and nothing was left violated.
    const raw = new Database(dbPath, { readonly: true });
    const fks = raw.pragma("foreign_key_list(issues)") as { from: string; table: string }[];
    expect(fks.some((fk) => fk.from === "parent_id" && fk.table === "issues")).toBe(true);
    expect(raw.prepare("SELECT count(*) AS n FROM issues").get()).toEqual({ n: 1 });
    expect(raw.prepare("SELECT count(*) AS n FROM events").get()).toEqual({ n: 1 });
    expect(raw.pragma("foreign_key_check")).toEqual([]);
    raw.close();
  });
});
