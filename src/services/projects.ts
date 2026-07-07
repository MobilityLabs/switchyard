import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { projects } from "../db/schema.js";
import { SwitchyardError } from "./errors.js";

export type Project = typeof projects.$inferSelect;

export function createProject(db: Db, input: { key: string; name: string }): Project {
  if (!/^[A-Z]{2,10}$/.test(input.key)) {
    throw new SwitchyardError(
      `Project key "${input.key}" is invalid — use 2–10 uppercase letters, e.g. "AIPI".`
    );
  }
  return db.insert(projects).values(input).returning().get();
}

export function listProjects(db: Db): Project[] {
  return db.select().from(projects).all();
}

export function getProjectByKey(db: Db, key: string): Project {
  const p = db.select().from(projects).where(eq(projects.key, key)).get();
  if (!p) {
    throw new SwitchyardError(
      `There is no project with key "${key}" — call list_projects to see valid keys.`
    );
  }
  return p;
}

export function reserveIssueNumber(db: Db, projectId: number): number {
  const row = db
    .update(projects)
    .set({ nextIssueNumber: sql`${projects.nextIssueNumber} + 1` })
    .where(eq(projects.id, projectId))
    .returning({ next: projects.nextIssueNumber })
    .get();
  if (!row) throw new SwitchyardError(`Project ${projectId} not found.`);
  return row.next - 1;
}
