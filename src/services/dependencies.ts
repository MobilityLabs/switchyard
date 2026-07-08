import { and, eq, isNull, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { dependencies, issues } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { getIssue, toView, type IssueView } from "./issues.js";
import { getProjectByKey } from "./projects.js";
import { recordEvent } from "./events.js";

const CLOSED = ["done", "canceled"] as const;
const PRIORITY_RANK = sql`CASE ${issues.priority}
  WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;

export function addDependency(db: Db, actor: Actor, blockerRef: string, blockedRef: string): void {
  db.transaction((tx) => {
    const blocker = getIssue(tx as Db, blockerRef);
    const blocked = getIssue(tx as Db, blockedRef);
    if (blocker.id === blocked.id) {
      throw new SwitchyardError(`An issue cannot block itself (${blockerRef}).`);
    }
    if (isReachable(tx as Db, blocked.id, blocker.id)) {
      throw new SwitchyardError(
        `Adding this dependency would create a cycle — ${blockedRef} already blocks ${blockerRef} (directly or transitively).`
      );
    }
    const inserted = tx
      .insert(dependencies)
      .values({ blockerId: blocker.id, blockedId: blocked.id })
      .onConflictDoNothing()
      .returning()
      .get();
    if (inserted) {
      recordEvent(tx as Db, {
        issueId: blocked.id, actorId: actor.id,
        type: "blocked_by_added", payload: { blocker: blocker.ref },
      });
    }
  });
}

function isReachable(db: Db, fromId: number, toId: number): boolean {
  const visited = new Set<number>([fromId]);
  const queue = [fromId];
  while (queue.length > 0) {
    const x = queue.shift()!;
    const successors = db
      .select({ blockedId: dependencies.blockedId })
      .from(dependencies)
      .where(eq(dependencies.blockerId, x))
      .all();
    for (const { blockedId } of successors) {
      if (blockedId === toId) return true;
      if (!visited.has(blockedId)) {
        visited.add(blockedId);
        queue.push(blockedId);
      }
    }
  }
  return false;
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

export function nextTask(db: Db, actor: Actor, projectKey?: string): IssueView | null {
  const project = projectKey !== undefined ? getProjectByKey(db, projectKey) : undefined;
  const conditions = [
    eq(issues.status, "todo"),
    or(isNull(issues.assigneeId), eq(issues.assigneeId, actor.id)),
  ];
  if (project) conditions.push(eq(issues.projectId, project.id));
  const candidates = db
    .select()
    .from(issues)
    .where(and(...conditions))
    .orderBy(PRIORITY_RANK, issues.createdAt)
    .all();
  for (const row of candidates) {
    if (getOpenBlockers(db, row.id).length === 0) return toView(db, row);
  }
  return null;
}
