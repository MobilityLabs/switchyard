import { and, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { actors, issues, type Status } from "../db/schema.js";
import { toView, type IssueView } from "./issues.js";
import { getProjectByKey } from "./projects.js";
import { SwitchyardError } from "./errors.js";
import { listAttentionByIssueId, type AttentionFlag } from "./attention.js";

export type SearchFilters = {
  projectKey?: string;
  status?: Status;
  assigneeName?: string;
  label?: string;
  text?: string;
  needsInput?: boolean;
  excludeSnoozed?: boolean;
  /** Restrict to issues currently carrying this attention flag (SYD-94) —
   * lets callers like deliver.ts's reconciliation pass fetch just the
   * handful of flagged issues instead of paging through everything. */
  attention?: AttentionFlag["reason"];
};

export function searchIssues(db: Db, filters: SearchFilters): IssueView[] {
  const conditions: SQL[] = [];
  if (filters.projectKey) conditions.push(eq(issues.projectId, getProjectByKey(db, filters.projectKey).id));
  if (filters.status) conditions.push(eq(issues.status, filters.status));
  if (filters.assigneeName) {
    const a = db.select().from(actors).where(eq(actors.name, filters.assigneeName)).get();
    if (!a) throw new SwitchyardError(`There is no actor named "${filters.assigneeName}".`);
    conditions.push(eq(issues.assigneeId, a.id));
  }
  if (filters.label) {
    conditions.push(sql`EXISTS (SELECT 1 FROM json_each(${issues.labels}) WHERE json_each.value = ${filters.label})`);
  }
  if (filters.needsInput !== undefined) {
    conditions.push(eq(issues.needsInput, filters.needsInput));
  }
  if (filters.excludeSnoozed) {
    const now = Math.floor(Date.now() / 1000);
    conditions.push(or(isNull(issues.snoozedUntil), sql`${issues.snoozedUntil} <= ${now}`)!);
  }
  if (filters.attention) {
    const flagged = [...listAttentionByIssueId(db).entries()]
      .filter(([, flag]) => flag.reason === filters.attention)
      .map(([issueId]) => issueId);
    if (flagged.length === 0) return [];
    conditions.push(inArray(issues.id, flagged));
  }
  if (filters.text) {
    // Escape SQL wildcard characters (%, _, and ~) so they're treated as literals
    const escaped = filters.text.toLowerCase().replace(/[~%_]/g, "~$&");
    const pattern = `%${escaped}%`;
    conditions.push(
      or(
        sql`lower(${issues.title}) LIKE ${pattern} ESCAPE '~'`,
        sql`lower(${issues.description}) LIKE ${pattern} ESCAPE '~'`
      )!
    );
  }
  // Triage is worked oldest-first (SYD-159) — humans clear the inbox in
  // filing order rather than always seeing whatever landed most recently.
  // Every other view keeps the newest-first default.
  const rows = db
    .select()
    .from(issues)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(filters.status === "triage" ? issues.id : desc(issues.id))
    .all();
  return rows.map((r) => toView(db, r));
}
