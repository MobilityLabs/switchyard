import { asc, desc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { events, actors, issues, projects } from "../db/schema.js";

export function recordEvent(
  db: Db,
  e: { issueId: number; actorId: number; type: string; payload?: Record<string, unknown> }
): void {
  db.insert(events)
    .values({ issueId: e.issueId, actorId: e.actorId, type: e.type, payload: e.payload ?? {} })
    .run();
}

export function listIssueEvents(db: Db, issueId: number) {
  return db
    .select({
      id: events.id,
      type: events.type,
      payload: events.payload,
      createdAt: events.createdAt,
      actorName: actors.name,
    })
    .from(events)
    .innerJoin(actors, eq(events.actorId, actors.id))
    .where(eq(events.issueId, issueId))
    .orderBy(asc(events.id))
    .all();
}

export const DEFAULT_RECENT_EVENTS_LIMIT = 200;
export const MAX_RECENT_EVENTS_LIMIT = 500;

export type RecentEventsFilters = {
  since?: number;
  limit?: number;
};

/**
 * Global, newest-first event feed for reflection/analysis tooling (e.g. the
 * nightly dreamer job) — joined with issue ref, issue title, project key, and
 * actor name, using the same join shape as the webhook dispatcher.
 */
export function listRecentEvents(db: Db, filters: RecentEventsFilters = {}) {
  const limit = Math.min(Math.max(1, filters.limit ?? DEFAULT_RECENT_EVENTS_LIMIT), MAX_RECENT_EVENTS_LIMIT);
  const rows = db
    .select({ e: events, i: issues, p: projects, a: actors })
    .from(events)
    .innerJoin(issues, eq(events.issueId, issues.id))
    .innerJoin(projects, eq(issues.projectId, projects.id))
    .innerJoin(actors, eq(events.actorId, actors.id))
    .where(filters.since !== undefined ? gt(events.createdAt, filters.since) : undefined)
    .orderBy(desc(events.id))
    .limit(limit)
    .all();
  return rows.map((r) => ({
    id: r.e.id,
    type: r.e.type,
    payload: r.e.payload,
    createdAt: r.e.createdAt,
    issue: `${r.p.key}-${r.i.number}`,
    issueTitle: r.i.title,
    projectKey: r.p.key,
    actorName: r.a.name,
  }));
}

export type UnansweredQuestion = {
  ref: string;
  questionEventId: number;
};

/**
 * Issues whose latest `agent_question` event (SYD-56) has no later
 * agent-actor `comment` event on the same issue — derived from the event log
 * (not the worker's in-memory state) so it survives worker restarts and
 * naturally coalesces repeated questions on one issue into a single result
 * (SYD-60). Ordered oldest-question-first.
 */
export function listUnansweredQuestions(db: Db): UnansweredQuestion[] {
  return db.all<UnansweredQuestion>(sql`
    SELECT p.key || '-' || i.number AS ref, q.questionEventId AS questionEventId
    FROM (
      SELECT issue_id, MAX(id) AS questionEventId
      FROM events
      WHERE type = 'agent_question'
      GROUP BY issue_id
    ) q
    JOIN issues i ON i.id = q.issue_id
    JOIN projects p ON p.id = i.project_id
    WHERE NOT EXISTS (
      SELECT 1 FROM events e2
      JOIN actors a ON a.id = e2.actor_id
      WHERE e2.issue_id = q.issue_id
        AND e2.type = 'comment'
        AND a.type = 'agent'
        AND e2.id > q.questionEventId
    )
    ORDER BY q.questionEventId ASC
  `);
}
