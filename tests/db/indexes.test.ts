import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { sql } from "drizzle-orm";

describe("hot column indexes (SYD-142)", () => {
  it("creates indexes on events.issueId, issues filter columns, and agentSessions.issueId", () => {
    const db = openDb(":memory:");
    const names = db
      .all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type='index'`)
      .map((r) => r.name);

    expect(names).toContain("events_issue_id_idx");
    expect(names).toContain("issues_project_id_idx");
    expect(names).toContain("issues_status_idx");
    expect(names).toContain("issues_assignee_id_idx");
    expect(names).toContain("agent_sessions_issue_id_idx");
  });
});
