import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "../../src/db/index.js";
import { sql } from "drizzle-orm";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

describe("openDb", () => {
  it("opens an in-memory db with all tables migrated", () => {
    const db = openDb(":memory:");
    const rows = db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
    );
    const names = rows.map((r) => r.name);
    for (const t of ["actors", "projects", "issues", "dependencies", "events"]) {
      expect(names).toContain(t);
    }
  });

  describe("file permissions (SYD-139)", () => {
    let dir: string;

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("tightens a freshly created db file to 0600, including WAL/SHM siblings", () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "syd-139-"));
      const dbPath = path.join(dir, "switchyard.db");
      openDb(dbPath);

      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
      for (const suffix of ["-wal", "-shm"]) {
        const p = dbPath + suffix;
        if (existsSync(p)) {
          expect(statSync(p).mode & 0o777).toBe(0o600);
        }
      }
    });

    it("tightens an existing, more permissive db file on reopen", () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "syd-139-"));
      const dbPath = path.join(dir, "switchyard.db");
      (openDb(dbPath) as unknown as { $client: { close(): void } }).$client.close();
      chmodSync(dbPath, 0o644);
      expect(statSync(dbPath).mode & 0o777).toBe(0o644);

      openDb(dbPath);

      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    });
  });
});
