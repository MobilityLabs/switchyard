import { sql, type SQLWrapper } from "drizzle-orm";

/** Bound as one JSON value so large legacy list calls cannot exceed SQLite's
 * parameter limit. Undefined means all issues; an empty selection means none. */
export function issueIdsCondition(column: SQLWrapper, ids?: readonly number[]) {
  if (ids === undefined) return sql`1`;
  return sql`${column} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;
}
