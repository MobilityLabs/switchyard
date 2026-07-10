import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { issues, projects, actors as actorsTable, STATUSES, PRIORITIES, type Status, type Priority } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { getProjectByKey, reserveIssueNumber } from "./projects.js";
import { recordEvent } from "./events.js";
import { getOpenBlockers } from "./dependencies.js";
import { getOpenPr } from "./pr-status.js";

export type Provenance = {
  sourceType: "session" | "todo" | "ci" | "manual";
  detail?: string;
  url?: string;
};

export const SUMMARY_MAX_LENGTH = 280;

function checkSummaryLength(summary: string | null | undefined): void {
  if (summary != null && summary.length > SUMMARY_MAX_LENGTH) {
    throw new SwitchyardError(
      `Summary is ${summary.length} characters — summaries must be ${SUMMARY_MAX_LENGTH} or fewer. Keep it to one or two sentences; put the rest in the description.`
    );
  }
}

export type CreateIssueInput = {
  projectKey: string;
  title: string;
  description?: string;
  summary?: string;
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
  if (actor.type === "agent" && !input.description?.trim()) {
    throw new SwitchyardError(
      "Agent-filed issues need a description a human can triage from — say what's wrong, why it matters, and what you suggest doing."
    );
  }
  if (input.provenance?.url && !/^https?:\/\//.test(input.provenance.url)) {
    throw new SwitchyardError(
      `Provenance url must be http(s) — got "${input.provenance.url}".`
    );
  }
  checkSummaryLength(input.summary);
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
        summary: input.summary ?? null,
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
  summary?: string | null;
  assigneeName?: string | null;
  labels?: string[];
};

/**
 * Refuses to let `actor` claim an issue already spoken for (SYD-99): claimed
 * by a different actor, or sitting behind an open agent PR from a prior claim
 * (see getOpenPr — this also catches a stale claim that got released while
 * its PR is still unmerged). Reclaiming your own issue is always fine. This
 * is the gap that let SYD-93 get fixed twice in parallel (worker PR #41 vs a
 * coordinating session's PR #42, opened without ever calling claim_issue).
 */
function assertClaimable(db: Db, actor: Actor, current: IssueView): void {
  if (current.assigneeId === actor.id) return;
  if (current.assigneeId !== null) {
    const assignee = db.select().from(actorsTable).where(eq(actorsTable.id, current.assigneeId)).get();
    throw new SwitchyardError(
      `${current.ref} is already claimed by ${assignee?.name ?? "another actor"} — check with them before starting duplicate work, or call next_task for another issue.`
    );
  }
  const openPr = getOpenPr(db, current.id);
  if (openPr) {
    throw new SwitchyardError(
      `${current.ref} already has an open PR (#${openPr.prNumber}: ${openPr.url}) from a prior claim — check it before starting duplicate work, or call next_task for another issue.`
    );
  }
}

export function updateIssue(db: Db, actor: Actor, ref: string, patch: UpdateIssueInput): IssueView {
  checkSummaryLength(patch.summary);
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
      if (current.status === "triage" && actor.type === "agent") {
        throw new SwitchyardError(
          `${ref} is in triage — only humans move issues out of triage. Use triage_queue to help a human review it.`
        );
      }
      if (patch.status === "done" && actor.type === "agent") {
        throw new SwitchyardError(
          "Only humans move issues to done — comment your verification evidence and move it to in_review instead."
        );
      }
      if (patch.status === "in_progress" && actor.type === "agent") {
        // Same gates claimIssue enforces — without this, a PATCH straight to
        // in_progress would let an agent start work a human deliberately
        // blocked behind another issue, or duplicate a claim/PR already in
        // flight (SYD-99).
        const blockers = getOpenBlockers(tx as Db, current.id);
        if (blockers.length > 0) {
          throw new SwitchyardError(
            `${ref} is blocked by ${blockers.map((b) => b.ref).join(", ")} — resolve the blocker first, or call next_task for another issue.`
          );
        }
        assertClaimable(tx as Db, actor, current);
      }
      changes.status = patch.status;
      toRecord.push({ type: "status_changed", payload: { from: current.status, to: patch.status } });
    }
    if (patch.priority !== undefined && patch.priority !== current.priority) {
      if (!PRIORITIES.includes(patch.priority)) {
        throw new SwitchyardError(
          `"${patch.priority}" is not a priority — valid priorities are: ${PRIORITIES.join(", ")}.`
        );
      }
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
    if (patch.summary !== undefined && patch.summary !== current.summary) {
      changes.summary = patch.summary;
      toRecord.push({ type: "summary_changed", payload: {} });
    }
    if (
      patch.labels !== undefined &&
      JSON.stringify([...patch.labels].sort()) !== JSON.stringify([...current.labels].sort())
    ) {
      if (actor.type === "agent" && patch.labels.includes("auto") && !current.labels.includes("auto")) {
        throw new SwitchyardError(
          `Only humans apply the "auto" label — it opts an issue into unattended dispatch.`
        );
      }
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

    if (patch.status !== undefined && actor.type === "human" && current.needsInput) {
      changes.needsInput = false;
      toRecord.push({ type: "needs_input_cleared", payload: {} });
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
  assertClaimable(db, actor, current);
  return updateIssue(db, actor, ref, { status: "in_progress", assigneeName: actor.name });
}
