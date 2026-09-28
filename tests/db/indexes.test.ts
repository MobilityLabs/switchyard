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

  it("uses indexed reverse lookups inside task-selection subqueries", () => {
    const db = openDb(":memory:");
    const plan = db
      .all<{ detail: string }>(
        sql`EXPLAIN QUERY PLAN
      SELECT i.id FROM issues i WHERE i.status = 'todo'
      AND NOT EXISTS (SELECT 1 FROM issues c WHERE c.parent_id = i.id AND c.status NOT IN ('done', 'canceled'))
      AND NOT EXISTS (SELECT 1 FROM dependencies d JOIN issues b ON b.id = d.blocker_id
        WHERE d.blocked_id = i.id AND b.status NOT IN ('done', 'canceled'))`,
      )
      .map((row) => row.detail);
    expect(
      plan.some((detail) => detail.includes("SEARCH c USING INDEX issues_parent_id_idx")),
    ).toBe(true);
    expect(
      plan.some((detail) => detail.includes("SEARCH d USING INDEX dependencies_blocked_id_idx")),
    ).toBe(true);
    expect(plan.some((detail) => /^SCAN [cd]$/.test(detail))).toBe(false);
  });

  it("seeks event types and project/status board pages without scanning history", () => {
    const db = openDb(":memory:");
    const eventsPlan = db.all<{ detail: string }>(sql`EXPLAIN QUERY PLAN
      SELECT issue_id, MAX(id) FROM events WHERE type = 'delivery_failed' GROUP BY issue_id`);
    expect(
      eventsPlan.some(({ detail }) =>
        detail.includes("SEARCH events USING COVERING INDEX events_type_issue_id_idx"),
      ),
    ).toBe(true);
    const boardPlan = db.all<{ detail: string }>(sql`EXPLAIN QUERY PLAN
      SELECT id, title FROM issues WHERE project_id = 1 AND status = 'done' AND id < 100 ORDER BY id DESC LIMIT 51`);
    expect(boardPlan.some(({ detail }) => detail.includes("issues_project_status_idx"))).toBe(true);
    expect(boardPlan.some(({ detail }) => detail.includes("TEMP B-TREE"))).toBe(false);
  });
});
