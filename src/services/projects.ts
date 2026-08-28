import { eq, sql } from "drizzle-orm";
import type { HumanActor } from "./principal.js";
import type { Db, DbOrTx } from "../db/index.js";
import { projects } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";

export type Project = typeof projects.$inferSelect;

// Project mutations are board governance (SYD-157): server-enforced
// human-only, like triage transitions and dependency removal.

export function createProject(
  db: Db,
  actor: HumanActor,
  input: { key: string; name: string },
): Project {
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

/** Rename a project. The key (issue refs embed it) and counter are immutable. Human-only. */
export function updateProject(
  db: Db,
  actor: HumanActor,
  key: string,
  input: { name: string },
): Project {
  const project = getProjectByKey(db, key);
  return db
    .update(projects)
    .set({ name: input.name })
    .where(eq(projects.id, project.id))
    .returning()
    .get();
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
