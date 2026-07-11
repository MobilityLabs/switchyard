import { and, eq, isNull, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { dependencies, issues } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { getIssue, toView, type IssueView } from "./issues.js";
import { getProjectByKey } from "./projects.js";
import { recordEvent } from "./events.js";
import { listOpenPrByIssueId } from "./pr-status.js";

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
        `Adding this dependency would create a cycle — ${blockedRef} already blocks ${blockerRef} (directly or transitively).`,
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
        issueId: blocked.id,
        actorId: actor.id,
        type: "blocked_by_added",
        payload: { blocker: blocker.ref },
      });
    }
  });
}

/** Remove a dependency edge. A no-op (no event) if the edge doesn't exist —
 * removal is mistake correction, so idempotency beats erroring. Human-only:
 * removing a blocker makes gated work claimable, so an agent allowed to
 * remove edges could unblock itself and take work a human deliberately held. */
export function removeDependency(
  db: Db,
  actor: Actor,
  blockerRef: string,
  blockedRef: string,
): void {
  if (actor.type === "agent") {
    throw new SwitchyardError(
      "Only humans remove dependencies — if you believe a blocker is wrong, say so in a comment.",
    );
  }
  db.transaction((tx) => {
    const blocker = getIssue(tx as Db, blockerRef);
    const blocked = getIssue(tx as Db, blockedRef);
    const deleted = tx
      .delete(dependencies)
      .where(and(eq(dependencies.blockerId, blocker.id), eq(dependencies.blockedId, blocked.id)))
      .returning()
      .get();
    if (deleted) {
      recordEvent(tx as Db, {
        issueId: blocked.id,
        actorId: actor.id,
        type: "blocked_by_removed",
        payload: { blocker: blocker.ref },
      });
    }
  });
}

export type DependencyView = { ref: string; title: string; status: string };

/** Both directions of an issue's dependency edges, for display. Unlike
 * getOpenBlockers this includes closed issues — the UI shows (and lets you
 * unlink) resolved blockers too. */
export function listDependencies(
  db: Db,
  ref: string,
): { blockedBy: DependencyView[]; blocks: DependencyView[] } {
  const issue = getIssue(db, ref);
  const pick = (rows: { i: typeof issues.$inferSelect }[]): DependencyView[] =>
    rows.map(({ i }) => {
      const v = toView(db, i);
      return { ref: v.ref, title: v.title, status: v.status };
    });
  const blockedBy = db
    .select({ i: issues })
    .from(dependencies)
    .innerJoin(issues, eq(dependencies.blockerId, issues.id))
    .where(eq(dependencies.blockedId, issue.id))
    .all();
  const blocks = db
    .select({ i: issues })
    .from(dependencies)
    .innerJoin(issues, eq(dependencies.blockedId, issues.id))
    .where(eq(dependencies.blockerId, issue.id))
    .all();
  return { blockedBy: pick(blockedBy), blocks: pick(blocks) };
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

/**
 * The set of issue ids that currently have at least one open (not done/canceled)
 * blocker — the batched form of getOpenBlockers, so the `todo` feed the dispatch
 * worker reads can flag blocked issues in one query instead of N (SYD-160). The
 * Set collapses issues with several open blockers to a single id.
 */
export function listBlockedIssueIds(db: Db): Set<number> {
  const rows = db
    .select({ blockedId: dependencies.blockedId })
    .from(dependencies)
    .innerJoin(issues, eq(dependencies.blockerId, issues.id))
    .where(notInArray(issues.status, [...CLOSED]))
    .all();
  return new Set(rows.map((r) => r.blockedId));
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
    sql`NOT EXISTS (
      SELECT 1 FROM dependencies d
      JOIN issues b ON b.id = d.blocker_id
      WHERE d.blocked_id = ${issues.id} AND b.status NOT IN ('done', 'canceled')
    )`,
  ];
  // SYD-99: don't recommend an issue whose prior claim already has an open
  // PR in flight (e.g. released back to todo by a stale-claim sweep while
  // its PR is still unmerged) — claimIssue would refuse it anyway. Reuses
  // getOpenPr's PR-number-matched close logic (SYD-125) instead of
  // duplicating it here.
  const openPrIssueIds = [...listOpenPrByIssueId(db).keys()];
  if (openPrIssueIds.length > 0) conditions.push(notInArray(issues.id, openPrIssueIds));
  if (project) conditions.push(eq(issues.projectId, project.id));
  const candidates = db
    .select()
    .from(issues)
    .where(and(...conditions))
    .orderBy(PRIORITY_RANK, issues.createdAt)
    .limit(1)
    .all();
  return candidates[0] ? toView(db, candidates[0]) : null;
}
