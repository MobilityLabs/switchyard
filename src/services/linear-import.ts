import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { actors, issues, projects, type Status, type Priority } from "../db/schema.js";
import { SwitchyardError } from "./errors.js";

// ---- Shapes handed over by the fetch layer (scripts/import-linear-lib.ts) ----

export type LinearTeam = { id: string; key: string; name: string };
export type LinearState = { id: string; name: string; type: string; teamKey: string };
export type LinearUser = {
  id: string;
  name: string;
  displayName: string;
  email: string;
  active: boolean;
};
export type LinearComment = {
  id: string;
  body: string;
  authorId: string | null;
  createdAt: string;
};
export type LinearRelation = { type: string; relatedIdentifier: string };
export type LinearAttachment = { id: string; title: string; url: string };
export type LinearIssue = {
  id: string;
  identifier: string;
  number: number;
  teamKey: string;
  title: string;
  description: string;
  priority: number;
  stateName: string;
  stateType: string;
  assigneeId: string | null;
  creatorId: string | null;
  labels: string[];
  parentIdentifier: string | null;
  createdAt: string;
  updatedAt: string;
  comments: LinearComment[];
  relations: LinearRelation[];
  attachments: LinearAttachment[];
};
export type LinearExport = {
  orgName: string;
  orgUrlKey: string;
  teams: LinearTeam[];
  states: LinearState[];
  users: LinearUser[];
  issues: LinearIssue[];
};

// ---- The plan: everything the import will do, computed up front ----

export type PlannedComment = {
  linearId: string;
  authorName: string;
  body: string;
  createdAt: number;
};
export type PlannedIssue = {
  linearId: string;
  ref: string;
  projectKey: string;
  number: number;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  labels: string[];
  parentRef: string | null;
  creatorName: string;
  assigneeName: string | null;
  createdAt: number;
  updatedAt: number;
  sourceUrl: string;
  comments: PlannedComment[];
  fileAttachments: { title: string; url: string }[];
  linkAttachments: { title: string; url: string }[];
};
export type ImportPlan = {
  orgName: string;
  projects: { key: string; name: string; exists: boolean }[];
  actors: { name: string; exists: boolean }[];
  issues: PlannedIssue[];
  dependencies: { blockerRef: string; blockedRef: string }[];
  skipped: { ref: string; reason: string }[];
  warnings: string[];
};

/** Attributed on imported records whose Linear author is unknown (system-created issues, bot comments). */
export const FALLBACK_ACTOR_NAME = "linear-import";

const UPLOADS_PREFIX = "https://uploads.linear.app/";
const PROJECT_KEY_RE = /^[A-Z]{2,10}$/;

function toUnix(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

export function buildImportPlan(db: Db, data: LinearExport): ImportPlan {
  for (const team of data.teams) {
    if (!PROJECT_KEY_RE.test(team.key)) {
      throw new SwitchyardError(
        `Linear team key "${team.key}" is not a valid Switchyard project key (2–10 uppercase letters) — rename the team in Linear or import it manually.`,
      );
    }
  }

  const plannedProjects = data.teams.map((team) => ({
    key: team.key,
    name: team.name,
    exists: !!db.select().from(projects).where(eq(projects.key, team.key)).get(),
  }));
  const projectRowByKey = new Map(
    data.teams
      .map((t) => [t.key, db.select().from(projects).where(eq(projects.key, t.key)).get()] as const)
      .filter(([, row]) => row !== undefined),
  );

  const usersById = new Map(data.users.map((u) => [u.id, u]));
  const actorName = (userId: string | null): string =>
    (userId ? usersById.get(userId)?.displayName : undefined) ?? FALLBACK_ACTOR_NAME;

  const actorNames = new Set<string>(data.users.map((u) => u.displayName));
  const teamOrder = new Map(data.teams.map((t, i) => [t.key, i]));
  const sortedIssues = [...data.issues].sort(
    (a, b) =>
      (teamOrder.get(a.teamKey) ?? 0) - (teamOrder.get(b.teamKey) ?? 0) || a.number - b.number,
  );

  const planned: PlannedIssue[] = [];
  const skipped: ImportPlan["skipped"] = [];
  const dependencies: ImportPlan["dependencies"] = [];
  const warnings: string[] = [];

  for (const issue of sortedIssues) {
    const sourceDetail = `linear:${issue.id}`;
    const alreadyImported = db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.sourceDetail, sourceDetail))
      .get();
    if (alreadyImported) {
      skipped.push({ ref: issue.identifier, reason: `already imported (${sourceDetail})` });
      continue;
    }
    const projectRow = projectRowByKey.get(issue.teamKey);
    if (projectRow) {
      const collision = db
        .select({ id: issues.id, sourceDetail: issues.sourceDetail })
        .from(issues)
        .where(and(eq(issues.projectId, projectRow.id), eq(issues.number, issue.number)))
        .get();
      if (collision) {
        throw new SwitchyardError(
          `Cannot import ${issue.identifier}: project ${issue.teamKey} already has issue number ${issue.number} (not from this Linear workspace) — refs cannot be preserved. Import into a fresh database or a different project key.`,
        );
      }
    }

    if (issue.creatorId === null || !usersById.has(issue.creatorId ?? "")) {
      actorNames.add(FALLBACK_ACTOR_NAME);
    }
    for (const c of issue.comments) {
      if (c.authorId === null || !usersById.has(c.authorId)) actorNames.add(FALLBACK_ACTOR_NAME);
    }

    for (const rel of issue.relations) {
      if (rel.type === "blocks") {
        dependencies.push({ blockerRef: issue.identifier, blockedRef: rel.relatedIdentifier });
      } else {
        warnings.push(
          `skipping "${rel.type}" relation ${issue.identifier} → ${rel.relatedIdentifier} (only "blocks" relations become dependencies)`,
        );
      }
    }

    planned.push({
      linearId: issue.id,
      ref: issue.identifier,
      projectKey: issue.teamKey,
      number: issue.number,
      title: issue.title,
      description: issue.description,
      status: mapStateToStatus({ name: issue.stateName, type: issue.stateType }),
      priority: mapPriority(issue.priority),
      labels: issue.labels,
      parentRef: issue.parentIdentifier,
      creatorName: actorName(issue.creatorId),
      assigneeName: issue.assigneeId ? actorName(issue.assigneeId) : null,
      createdAt: toUnix(issue.createdAt),
      updatedAt: toUnix(issue.updatedAt),
      sourceUrl: `https://linear.app/${data.orgUrlKey}/issue/${issue.identifier}`,
      comments: issue.comments.map((c) => ({
        linearId: c.id,
        authorName: actorName(c.authorId),
        body: c.body,
        createdAt: toUnix(c.createdAt),
      })),
      fileAttachments: issue.attachments
        .filter((a) => a.url.startsWith(UPLOADS_PREFIX))
        .map((a) => ({ title: a.title, url: a.url })),
      linkAttachments: issue.attachments
        .filter((a) => !a.url.startsWith(UPLOADS_PREFIX))
        .map((a) => ({ title: a.title, url: a.url })),
    });
  }

  const plannedActors = [...actorNames].sort().map((name) => ({
    name,
    exists: !!db.select().from(actors).where(eq(actors.name, name)).get(),
  }));

  return {
    orgName: data.orgName,
    projects: plannedProjects,
    actors: plannedActors,
    issues: planned,
    dependencies,
    skipped,
    warnings,
  };
}

/**
 * Linear workflow-state *types* map 1:1 onto Switchyard statuses, except:
 * Linear has no dedicated review type (review columns are `started` states
 * named "In Review" etc.), and `duplicate` has no Switchyard equivalent so it
 * lands in `canceled`.
 */
const STATE_TYPE_TO_STATUS: Record<string, Status> = {
  triage: "triage",
  backlog: "backlog",
  unstarted: "todo",
  started: "in_progress",
  completed: "done",
  canceled: "canceled",
  duplicate: "canceled",
};

export function mapStateToStatus(state: { name: string; type: string }): Status {
  const status = STATE_TYPE_TO_STATUS[state.type];
  if (!status) {
    throw new SwitchyardError(
      `Linear state "${state.name}" has unknown type "${state.type}" — the importer maps: ${Object.keys(STATE_TYPE_TO_STATUS).join(", ")}.`,
    );
  }
  if (state.type === "started" && /review/i.test(state.name)) return "in_review";
  return status;
}

/** Linear priorities are numbers: 0=none, 1=urgent, 2=high, 3=medium, 4=low. */
const PRIORITY_MAP: Record<number, Priority> = {
  0: "none",
  1: "urgent",
  2: "high",
  3: "medium",
  4: "low",
};

export function mapPriority(priority: number): Priority {
  return PRIORITY_MAP[priority] ?? "none";
}
