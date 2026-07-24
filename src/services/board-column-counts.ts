import { count, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { issues, projects, type Status } from "../db/schema.js";

export type BoardColumnCounts = Record<string, Partial<Record<Status, number>>>;

/** Current issue totals grouped by project and board column, in one query. */
export function boardColumnCounts(db: Db): BoardColumnCounts {
  const rows = db
    .select({ projectKey: projects.key, status: issues.status, count: count() })
    .from(issues)
    .innerJoin(projects, eq(issues.projectId, projects.id))
    .groupBy(projects.key, issues.status)
    .all();

  const result: BoardColumnCounts = {};
  for (const row of rows) {
    (result[row.projectKey] ??= {})[row.status] = row.count;
  }
  return result;
}
