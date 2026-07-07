import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { issues, projects, type Priority } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { getProjectByKey, reserveIssueNumber } from "./projects.js";
import { recordEvent } from "./events.js";

export type Provenance = {
  sourceType: "session" | "todo" | "ci" | "manual";
  detail?: string;
  url?: string;
};

export type CreateIssueInput = {
  projectKey: string;
  title: string;
  description?: string;
  priority?: Priority;
  labels?: string[];
  parentRef?: string;
  provenance?: Provenance;
};

export type IssueView = typeof issues.$inferSelect & { ref: string };

export function parseRef(ref: string): { key: string; number: number } {
  const m = /^([A-Z]{2,10})-(\d+)$/.exec(ref);
  if (!m) {
    throw new SwitchyardError(
      `"${ref}" is not an issue ref — use the form <PROJECT_KEY>-<number>, like "AIPI-42".`
    );
  }
  return { key: m[1], number: Number(m[2]) };
}

export function toView(db: Db, row: typeof issues.$inferSelect): IssueView {
  const project = db.select().from(projects).where(eq(projects.id, row.projectId)).get()!;
  return { ...row, ref: `${project.key}-${row.number}` };
}

export function getIssue(db: Db, ref: string): IssueView {
  const { key, number } = parseRef(ref);
  const project = getProjectByKey(db, key);
  const row = db
    .select()
    .from(issues)
    .where(and(eq(issues.projectId, project.id), eq(issues.number, number)))
    .get();
  if (!row) {
    throw new SwitchyardError(
      `Issue ${ref} does not exist — call search_issues to find valid issues.`
    );
  }
  return toView(db, row);
}

export function createIssue(db: Db, actor: Actor, input: CreateIssueInput): IssueView {
  if (actor.type === "agent" && !input.provenance) {
    throw new SwitchyardError(
      "Agent-created issues require provenance — pass sourceType " +
        '("session" | "todo" | "ci" | "manual") plus a detail (e.g. "src/api.ts:88" or a session id) or url.'
    );
  }
  return db.transaction((tx) => {
    const project = getProjectByKey(tx as Db, input.projectKey);
    const number = reserveIssueNumber(tx as Db, project.id);
    const parentId = input.parentRef ? getIssue(tx as Db, input.parentRef).id : null;
    const row = tx
      .insert(issues)
      .values({
        projectId: project.id,
        number,
        title: input.title,
        description: input.description ?? "",
        status: actor.type === "agent" ? "triage" : "backlog",
        priority: input.priority ?? "none",
        labels: input.labels ?? [],
        creatorId: actor.id,
        parentId,
        sourceType: input.provenance?.sourceType ?? null,
        sourceDetail: input.provenance?.detail ?? null,
        sourceUrl: input.provenance?.url ?? null,
      })
      .returning()
      .get();
    recordEvent(tx as Db, { issueId: row.id, actorId: actor.id, type: "created" });
    return toView(tx as Db, row);
  });
}
