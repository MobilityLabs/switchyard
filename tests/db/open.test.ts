import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { sql } from "drizzle-orm";

describe("openDb", () => {
  it("opens an in-memory db with all tables migrated", () => {
    const db = openDb(":memory:");
    const rows = db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    );
    const names = rows.map((r) => r.name);
    for (const t of ["actors", "projects", "issues", "dependencies", "events"]) {
      expect(names).toContain(t);
    }
  });
});
