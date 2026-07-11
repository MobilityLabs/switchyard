import { eq, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../db/index.js";
import { projects } from "../db/schema.js";
import { SwitchyardError } from "./errors.js";

export type Project = typeof projects.$inferSelect;

export function createProject(db: Db, input: { key: string; name: string }): Project {
  if (!/^[A-Z]{2,10}$/.test(input.key)) {
    throw new SwitchyardError(
      `Project key "${input.key}" is invalid — use 2–10 uppercase letters, e.g. "AIPI".`,
    );
  }
  const existing = db.select().from(projects).where(eq(projects.key, input.key)).get();
  if (existing) {
    throw new SwitchyardError(
      `A project with key "${input.key}" already exists — call list_projects to see it.`,
    );
  }
  return db.insert(projects).values(input).returning().get();
}

export function listProjects(db: Db): Project[] {
  return db.select().from(projects).all();
}

export function getProjectByKey(db: DbOrTx, key: string): Project {
  const p = db.select().from(projects).where(eq(projects.key, key)).get();
  if (!p) {
    throw new SwitchyardError(
      `There is no project with key "${key}" — call list_projects to see valid keys.`,
    );
  }
  return p;
}

export function reserveIssueNumber(db: DbOrTx, projectId: number): number {
  const row = db
    .update(projects)
    .set({ nextIssueNumber: sql`${projects.nextIssueNumber} + 1` })
    .where(eq(projects.id, projectId))
    .returning({ next: projects.nextIssueNumber })
    .get();
  if (!row) throw new SwitchyardError(`Project ${projectId} not found.`);
  return row.next - 1;
}
