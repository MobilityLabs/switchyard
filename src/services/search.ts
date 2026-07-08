import { and, desc, eq, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { actors, issues, type Status } from "../db/schema.js";
import { toView, type IssueView } from "./issues.js";
import { getProjectByKey } from "./projects.js";
import { SwitchyardError } from "./errors.js";

export type SearchFilters = {
  projectKey?: string;
  status?: Status;
  assigneeName?: string;
  label?: string;
  text?: string;
  needsInput?: boolean;
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
  const rows = db
    .select()
    .from(issues)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(issues.id))
    .all();
  return rows.map((r) => toView(db, r));
}
