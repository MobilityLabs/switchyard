import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { events, actors } from "../db/schema.js";

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
