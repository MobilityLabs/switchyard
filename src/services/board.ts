import { and, count, desc, eq, lt } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { issues, type Status } from "../db/schema.js";
import { listAttentionByIssueId } from "./attention.js";
import { SwitchyardError } from "./errors.js";
import { childCountsByParent } from "./issues.js";
import { issueIdsCondition } from "./issue-scope.js";
import { listOpenPrByIssueId } from "./pr-status.js";
import { getProjectByKey } from "./projects.js";

export const BOARD_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done"] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];
export const DONE_FILTERS = ["errors", "not_merged", "unlinked"] as const;
export type DoneFilter = (typeof DONE_FILTERS)[number];
export const BOARD_PAGE_SIZE = 50;

/** Counts never need full issue bodies or derived attention/PR data. */
export function issueCounts(db: Db, projectKey?: string): Partial<Record<Status, number>> {
  const projectId = projectKey ? getProjectByKey(db, projectKey).id : undefined;
  return Object.fromEntries(
    db
      .select({ status: issues.status, count: count() })
      .from(issues)
      .where(projectId === undefined ? undefined : eq(issues.projectId, projectId))
      .groupBy(issues.status)
      .all()
      .map((r) => [r.status, r.count]),
  );
}

const cardColumns = {
  id: issues.id,
  number: issues.number,
  title: issues.title,
  status: issues.status,
  priority: issues.priority,
  labels: issues.labels,
  needsInput: issues.needsInput,
  workerPreference: issues.workerPreference,
};

/** Separate, bounded read model for board cards. Legacy /issues and MCP search
 * retain their full issue shape and ordering. Cursors are per column, newest
 * first, and filter membership is computed before applying the page limit. */
export function getBoard(
  db: Db,
  input: {
    projectKey: string;
    doneFilters?: readonly DoneFilter[];
    before?: Partial<Record<BoardStatus, number>>;
    limit?: number;
  },
) {
  const project = getProjectByKey(db, input.projectKey);
  const filters = input.doneFilters ?? ["errors", "not_merged"];
  if (filters.some((filter) => !DONE_FILTERS.includes(filter))) {
    throw new SwitchyardError("Unknown done filter — use errors, not_merged, unlinked, or all.");
  }
  const limit = input.limit ?? BOARD_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new SwitchyardError("Board page size must be a whole number from 1 to 100.");
  }
  for (const cursor of Object.values(input.before ?? {})) {
    if (!Number.isSafeInteger(cursor) || cursor <= 0) {
      throw new SwitchyardError("Board cursors must be positive whole issue IDs.");
    }
  }
  const totals = issueCounts(db, project.key);
  let doneIds: number[] | undefined;
  if (filters.length > 0 && totals.done) {
    const ids = db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.projectId, project.id), eq(issues.status, "done")))
      .all()
      .map((r) => r.id);
    const openPrs = listOpenPrByIssueId(db, ids);
    const attention = filters.some((f) => f !== "not_merged")
      ? listAttentionByIssueId(db, ids, openPrs)
      : new Map();
    doneIds = ids.filter(
      (id) =>
        (filters.includes("errors") && attention.get(id)?.reason === "delivery_failed") ||
        (filters.includes("not_merged") && openPrs.has(id)) ||
        (filters.includes("unlinked") && attention.get(id)?.reason === "done_without_merged_pr"),
    );
  }
  const pages = BOARD_STATUSES.map((status) => {
    const conditions = [eq(issues.projectId, project.id), eq(issues.status, status)];
    const before = input.before?.[status];
    if (before !== undefined) conditions.push(lt(issues.id, before));
    if (status === "done" && doneIds !== undefined)
      conditions.push(issueIdsCondition(issues.id, doneIds));
    const rows = db
      .select(cardColumns)
      .from(issues)
      .where(and(...conditions))
      .orderBy(desc(issues.id))
      .limit(limit + 1)
      .all();
    const items = rows.slice(0, limit);
    return {
      status,
      items,
      total: totals[status] ?? 0,
      matching: status === "done" && doneIds !== undefined ? doneIds.length : (totals[status] ?? 0),
      nextBeforeId: rows.length > limit ? items[items.length - 1].id : null,
    };
  });
  const ids = pages.flatMap((page) => page.items.map((issue) => issue.id));
  const openPrs = listOpenPrByIssueId(db, ids);
  const attention = listAttentionByIssueId(db, ids, openPrs);
  const children = childCountsByParent(db, ids);
  return {
    columns: Object.fromEntries(
      pages.map(({ status, items, ...page }) => [
        status,
        {
          ...page,
          items: items.map(({ number, ...issue }) => ({
            ...issue,
            ref: `${project.key}-${number}`,
            attention: attention.get(issue.id) ?? null,
            openPr: openPrs.get(issue.id) ?? null,
            childCount: children.get(issue.id) ?? 0,
          })),
        },
      ]),
    ),
  };
}
