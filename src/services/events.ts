import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../db/index.js";
import { events, actors, issues, projects, type EventKind } from "../db/schema.js";

export function recordEvent(
  db: DbOrTx,
  e: { issueId: number; actorId: number; type: EventKind; payload?: Record<string, unknown> },
): number {
  return db
    .insert(events)
    .values({ issueId: e.issueId, actorId: e.actorId, type: e.type, payload: e.payload ?? {} })
    .returning({ id: events.id })
    .get().id;
}

/**
 * The id of an existing event of `type` on this issue whose payload already
 * carries `value` at `jsonPath`, or null. GitHub redelivers at-least-once and
 * the poller re-observes on every tick, so writers that must record a
 * transition exactly once (github-webhook's isDuplicate, upsertPrState's
 * canonical co-write) key off this.
 */
export function findEventIdByPayload(
  db: DbOrTx,
  issueId: number,
  type: EventKind,
  jsonPath: string,
  value: string | number | null,
): number | null {
  if (value === null) return null;
  const [row] = db.all<{ id: number }>(sql`
    SELECT id FROM events
    WHERE issue_id = ${issueId} AND type = ${type} AND json_extract(payload, ${jsonPath}) = ${value}
    LIMIT 1
  `);
  return row?.id ?? null;
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
  /** Cursor for paging further back: only events with id strictly less than this. */
  beforeId?: number;
};

function resolveRecentEventsLimit(limit?: number): number {
  return Math.min(Math.max(1, limit ?? DEFAULT_RECENT_EVENTS_LIMIT), MAX_RECENT_EVENTS_LIMIT);
}

function queryRecentEvents(db: Db, filters: RecentEventsFilters, fetchLimit: number) {
  const conditions = [];
  if (filters.since !== undefined) conditions.push(gt(events.createdAt, filters.since));
  if (filters.beforeId !== undefined) conditions.push(lt(events.id, filters.beforeId));
  const rows = db
    .select({ e: events, i: issues, p: projects, a: actors })
    .from(events)
    .innerJoin(issues, eq(events.issueId, issues.id))
    .innerJoin(projects, eq(issues.projectId, projects.id))
    .innerJoin(actors, eq(events.actorId, actors.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(events.id))
    .limit(fetchLimit)
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

/**
 * Global, newest-first event feed for reflection/analysis tooling (e.g. the
 * nightly dreamer job) — joined with issue ref, issue title, project key, and
 * actor name, using the same join shape as the webhook dispatcher.
 */
export function listRecentEvents(db: Db, filters: RecentEventsFilters = {}) {
  return queryRecentEvents(db, filters, resolveRecentEventsLimit(filters.limit));
}

export type RecentEventsPage = {
  events: ReturnType<typeof queryRecentEvents>;
  /** Pass as `beforeId` on the next call to fetch the next-older page; null once nothing older remains. */
  nextCursor: number | null;
  /** True when this page hit the limit cap — there may be older events still within `since` that weren't returned. */
  truncated: boolean;
};

/**
 * Cursor-paginated variant of listRecentEvents (SYD-89): busy days can
 * produce more events than MAX_RECENT_EVENTS_LIMIT within a `since` window,
 * so a single call can silently truncate the *oldest* part of that window.
 * Callers that need the full window should loop, passing `nextCursor` back
 * in as `beforeId`, until `truncated` is false.
 */
export function listRecentEventsPage(db: Db, filters: RecentEventsFilters = {}): RecentEventsPage {
  const limit = resolveRecentEventsLimit(filters.limit);
  const rows = queryRecentEvents(db, filters, limit + 1);
  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;
  return { events: page, nextCursor: truncated ? page[page.length - 1].id : null, truncated };
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
