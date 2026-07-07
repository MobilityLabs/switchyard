import { and, eq, isNull, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { dependencies, issues } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { getIssue, toView, type IssueView, _setGetOpenBlockers } from "./issues.js";
import { recordEvent } from "./events.js";

const CLOSED = ["done", "canceled"] as const;
const PRIORITY_RANK = sql`CASE ${issues.priority}
  WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;

export function addDependency(db: Db, actor: Actor, blockerRef: string, blockedRef: string): void {
  const blocker = getIssue(db, blockerRef);
  const blocked = getIssue(db, blockedRef);
  if (blocker.id === blocked.id) {
    throw new SwitchyardError(`An issue cannot block itself (${blockerRef}).`);
  }
  db.insert(dependencies)
    .values({ blockerId: blocker.id, blockedId: blocked.id })
    .onConflictDoNothing()
    .run();
  recordEvent(db, {
    issueId: blocked.id, actorId: actor.id,
    type: "blocked_by_added", payload: { blocker: blocker.ref },
  });
}

export function getOpenBlockers(db: Db, issueId: number): IssueView[] {
  const rows = db
    .select({ issue: issues })
    .from(dependencies)
    .innerJoin(issues, eq(dependencies.blockerId, issues.id))
    .where(and(eq(dependencies.blockedId, issueId), notInArray(issues.status, [...CLOSED])))
    .all();
  return rows.map((r) => toView(db, r.issue));
}

// Wire the real blocker check into claimIssue (replaces Task 5's placeholder).
_setGetOpenBlockers(getOpenBlockers);

export function nextTask(db: Db, actor: Actor, projectKey?: string): IssueView | null {
  const candidates = db
    .select()
    .from(issues)
    .where(and(
      eq(issues.status, "todo"),
      or(isNull(issues.assigneeId), eq(issues.assigneeId, actor.id)),
    ))
    .orderBy(PRIORITY_RANK, issues.createdAt)
    .all();
  for (const row of candidates) {
    const view = toView(db, row);
    if (projectKey !== undefined && !view.ref.startsWith(projectKey + "-")) continue;
    if (getOpenBlockers(db, row.id).length === 0) return view;
  }
  return null;
}
