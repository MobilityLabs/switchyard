import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { sql } from "drizzle-orm";

describe("plan 2 schema", () => {
  it("migrates the new tables", () => {
    const db = openDb(":memory:");
    const names = db
      .all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type='table'`)
      .map((r) => r.name);
    for (const t of ["sessions", "login_links", "webhooks", "webhook_cursor"]) {
      expect(names).toContain(t);
    }
  });
});
