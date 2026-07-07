import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { issues, projects, actors as actorsTable, STATUSES, type Status, type Priority } from "../db/schema.js";
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

export type UpdateIssueInput = {
  status?: Status;
  priority?: Priority;
  title?: string;
  description?: string;
  assigneeName?: string | null;
  labels?: string[];
};

// Replaced by the real implementation in dependencies.ts in Task 6.
export let getOpenBlockers = (_db: Db, _issueId: number): IssueView[] => [];
export function _setGetOpenBlockers(fn: typeof getOpenBlockers) {
  getOpenBlockers = fn;
}

export function updateIssue(db: Db, actor: Actor, ref: string, patch: UpdateIssueInput): IssueView {
  return db.transaction((tx) => {
    const current = getIssue(tx as Db, ref);
    const changes: Partial<typeof issues.$inferInsert> = {};
    const toRecord: { type: string; payload: Record<string, unknown> }[] = [];

    if (patch.status !== undefined && patch.status !== current.status) {
      if (!STATUSES.includes(patch.status)) {
        throw new SwitchyardError(
          `"${patch.status}" is not a status — valid statuses are: ${STATUSES.join(", ")}.`
        );
      }
      changes.status = patch.status;
      toRecord.push({ type: "status_changed", payload: { from: current.status, to: patch.status } });
    }
    if (patch.priority !== undefined && patch.priority !== current.priority) {
      changes.priority = patch.priority;
      toRecord.push({ type: "priority_changed", payload: { from: current.priority, to: patch.priority } });
    }
    if (patch.title !== undefined && patch.title !== current.title) {
      changes.title = patch.title;
      toRecord.push({ type: "title_changed", payload: { from: current.title, to: patch.title } });
    }
    if (patch.description !== undefined && patch.description !== current.description) {
      changes.description = patch.description;
      toRecord.push({ type: "description_changed", payload: {} });
    }
    if (patch.labels !== undefined) {
      changes.labels = patch.labels;
      toRecord.push({ type: "labels_changed", payload: { to: patch.labels } });
    }
    if (patch.assigneeName !== undefined) {
      let assigneeId: number | null = null;
      if (patch.assigneeName !== null) {
        const a = tx.select().from(actorsTable).where(eq(actorsTable.name, patch.assigneeName)).get();
        if (!a) {
          throw new SwitchyardError(
            `There is no actor named "${patch.assigneeName}" — check the name and try again.`
          );
        }
        assigneeId = a.id;
      }
      if (assigneeId !== current.assigneeId) {
        changes.assigneeId = assigneeId;
        toRecord.push({ type: "assigned", payload: { to: patch.assigneeName } });
      }
    }

    if (Object.keys(changes).length === 0) return current;
    changes.updatedAt = Math.floor(Date.now() / 1000);
    const row = tx.update(issues).set(changes).where(eq(issues.id, current.id)).returning().get();
    for (const e of toRecord) {
      recordEvent(tx as Db, { issueId: current.id, actorId: actor.id, ...e });
    }
    return toView(tx as Db, row);
  });
}

export function claimIssue(db: Db, actor: Actor, ref: string): IssueView {
  const current = getIssue(db, ref);
  const blockers = getOpenBlockers(db, current.id);
  if (blockers.length > 0) {
    throw new SwitchyardError(
      `${ref} is blocked by ${blockers.map((b) => b.ref).join(", ")} — resolve the blocker first, or call next_task for another issue.`
    );
  }
  return updateIssue(db, actor, ref, { status: "in_progress", assigneeName: actor.name });
}
