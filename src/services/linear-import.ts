import { and, eq, lt } from "drizzle-orm";
import type { Db } from "../db/index.js";
import {
  actors,
  dependencies,
  events,
  issues,
  projects,
  type Status,
  type Priority,
} from "../db/schema.js";
import { getOrCreateActor, type Actor } from "./actors.js";
import { saveAttachment } from "./attachments.js";
import { createProject } from "./projects.js";
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
  stateMappings: { teamKey: string; name: string; type: string; status: Status }[];
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
    stateMappings: data.states.map((s) => ({
      teamKey: s.teamKey,
      name: s.name,
      type: s.type,
      status: mapStateToStatus(s),
    })),
    actors: plannedActors,
    issues: planned,
    dependencies,
    skipped,
    warnings,
  };
}

/** The dry-run output: the full mapping, human-readable. */
export function renderPlan(plan: ImportPlan): string {
  const lines: string[] = [`Import plan for ${plan.orgName}`, "", "Projects:"];
  for (const p of plan.projects) {
    lines.push(`  ${p.key}: ${p.name} ${p.exists ? "(exists)" : "(new)"}`);
  }
  lines.push("", "Workflow states:");
  for (const s of plan.stateMappings) {
    lines.push(`  [${s.teamKey}] ${s.name} (${s.type}) → ${s.status}`);
  }
  lines.push("", "Actors (tokenless humans until minted):");
  for (const a of plan.actors) {
    lines.push(`  ${a.name} ${a.exists ? "(exists)" : "(new)"}`);
  }
  lines.push("", `Issues to import: ${plan.issues.length}`);
  for (const i of plan.issues) {
    const extras = [
      i.comments.length && `${i.comments.length} comments`,
      i.fileAttachments.length && `${i.fileAttachments.length} files`,
      i.linkAttachments.length && `${i.linkAttachments.length} links`,
      i.parentRef && `child of ${i.parentRef}`,
    ].filter(Boolean);
    lines.push(
      `  ${i.ref} [${i.status}/${i.priority}] ${i.title}${extras.length ? ` (${extras.join(", ")})` : ""}`,
    );
  }
  if (plan.dependencies.length) {
    lines.push("", "Dependencies:");
    for (const d of plan.dependencies) lines.push(`  ${d.blockerRef} blocks ${d.blockedRef}`);
  }
  if (plan.skipped.length) {
    lines.push("", `Skipped: ${plan.skipped.length}`);
    for (const s of plan.skipped) lines.push(`  ${s.ref}: ${s.reason}`);
  }
  if (plan.warnings.length) {
    lines.push("", "Warnings:");
    for (const w of plan.warnings) lines.push(`  ${w}`);
  }
  return lines.join("\n");
}

// ---- Execution ----

export type ExecuteDeps = {
  /** Authenticated download of an uploads.linear.app file; null = fetch failed. */
  download: (url: string) => Promise<{ data: Buffer } | null>;
  attachmentsDir: string;
};

export type ImportReport = {
  projectsCreated: number;
  actorsCreated: number;
  issuesCreated: number;
  commentsCreated: number;
  dependenciesCreated: number;
  attachmentsCreated: number;
  skipped: number;
  warnings: string[];
};

/** Markdown image/link embeds pointing at Linear's (auth-gated) upload host —
 * these break for anyone without a Linear API key, so the importer re-hosts
 * them. Linear wraps some URLs in angle brackets. */
const UPLOAD_EMBED_RE = /!?\[([^\]]*)\]\(<?(https:\/\/uploads\.linear\.app\/[^)\s>]+)>?\)/g;

export function extractUploadEmbeds(markdown: string): { filename: string; url: string }[] {
  const out: { filename: string; url: string }[] = [];
  for (const m of markdown.matchAll(UPLOAD_EMBED_RE)) {
    out.push({ filename: m[1], url: m[2] });
  }
  return out;
}

function rewriteUrls(text: string, urlMap: Map<string, string>): string {
  let result = text;
  for (const [from, to] of urlMap) result = result.replaceAll(from, to);
  return result;
}

/**
 * Applies an ImportPlan. Deliberately writes `issues` and `events` rows
 * directly instead of going through createIssue/addComment: imported records
 * must carry their original numbers, statuses, authors, and timestamps, which
 * the services (correctly) refuse to accept from clients. Every issue write
 * still co-writes its audit events, preserving the services' invariant.
 *
 * Not one big transaction — saveAttachment opens its own — so a failed run is
 * recovered by re-running: buildImportPlan skips whatever already landed.
 */
export async function executeImportPlan(
  db: Db,
  plan: ImportPlan,
  deps: ExecuteDeps,
): Promise<ImportReport> {
  const report: ImportReport = {
    projectsCreated: 0,
    actorsCreated: 0,
    issuesCreated: 0,
    commentsCreated: 0,
    dependenciesCreated: 0,
    attachmentsCreated: 0,
    skipped: plan.skipped.length,
    warnings: [...plan.warnings],
  };

  // The importer is a host-CLI, human-operated tool — same standing as
  // src/cli.ts's cliActor for human-only service calls (SYD-157 guard).
  const importOperator: Actor = { id: 0, name: "cli", type: "human" };
  for (const p of plan.projects) {
    if (!p.exists) {
      createProject(db, importOperator, { key: p.key, name: p.name });
      report.projectsCreated++;
    }
  }
  const projectByKey = new Map(
    plan.projects.map((p) => [
      p.key,
      db.select().from(projects).where(eq(projects.key, p.key)).get()!,
    ]),
  );

  const actorByName = new Map<string, Actor>();
  for (const a of plan.actors) {
    actorByName.set(a.name, getOrCreateActor(db, a.name, "human"));
    if (!a.exists) report.actorsCreated++;
  }
  const actorFor = (name: string): Actor => {
    let actor = actorByName.get(name);
    if (!actor) {
      actor = getOrCreateActor(db, name, "human");
      actorByName.set(name, actor);
    }
    return actor;
  };

  for (const pi of plan.issues) {
    const project = projectByKey.get(pi.projectKey);
    if (!project) {
      report.warnings.push(`skipping ${pi.ref}: no project for team ${pi.projectKey}`);
      continue;
    }
    const creator = actorFor(pi.creatorName);
    const assignee = pi.assigneeName ? actorFor(pi.assigneeName) : null;

    const row = db
      .insert(issues)
      .values({
        projectId: project.id,
        number: pi.number,
        title: pi.title,
        description: pi.description,
        status: pi.status,
        priority: pi.priority,
        labels: pi.labels,
        assigneeId: assignee?.id ?? null,
        creatorId: creator.id,
        sourceType: "manual",
        sourceDetail: `linear:${pi.linearId}`,
        sourceUrl: pi.sourceUrl,
        createdAt: pi.createdAt,
        updatedAt: pi.updatedAt,
      })
      .returning()
      .get();
    report.issuesCreated++;
    db.insert(events)
      .values({
        issueId: row.id,
        actorId: creator.id,
        type: "created",
        payload: {},
        createdAt: pi.createdAt,
      })
      .run();

    // Re-host uploads.linear.app files (markdown embeds + file attachment
    // entities), building an old-URL → local-URL map for rewriting.
    const urlMap = new Map<string, string>();
    const wanted = new Map<string, string>(); // url → filename
    for (const embed of extractUploadEmbeds(
      [pi.description, ...pi.comments.map((c) => c.body)].join("\n"),
    )) {
      if (!wanted.has(embed.url)) wanted.set(embed.url, embed.filename);
    }
    for (const fa of pi.fileAttachments) {
      if (!wanted.has(fa.url)) wanted.set(fa.url, fa.title);
    }
    for (const [url, filename] of wanted) {
      const file = await deps.download(url);
      if (!file) {
        report.warnings.push(
          `${pi.ref}: could not download ${filename} (${url}) — keeping the original URL`,
        );
        continue;
      }
      try {
        const { attachment } = await saveAttachment(
          db,
          creator,
          pi.ref,
          filename,
          file.data,
          deps.attachmentsDir,
        );
        urlMap.set(url, `/api/attachments/${attachment.id}/${attachment.filename}`);
        report.attachmentsCreated++;
      } catch (err) {
        if (err instanceof SwitchyardError) {
          report.warnings.push(
            `${pi.ref}: could not re-upload ${filename} — ${err.message} Keeping the original URL.`,
          );
        } else {
          throw err;
        }
      }
    }

    let description = rewriteUrls(pi.description, urlMap);
    if (pi.linkAttachments.length > 0) {
      description +=
        "\n\n### Imported links\n\n" +
        pi.linkAttachments.map((a) => `- [${a.title}](${a.url})`).join("\n");
    }
    if (description !== pi.description) {
      // Import bookkeeping, not a user edit — no description_changed event.
      db.update(issues).set({ description }).where(eq(issues.id, row.id)).run();
    }

    for (const c of pi.comments) {
      db.insert(events)
        .values({
          issueId: row.id,
          actorId: actorFor(c.authorName).id,
          type: "comment",
          payload: { body: rewriteUrls(c.body, urlMap), linearId: c.linearId },
          createdAt: c.createdAt,
        })
        .run();
      report.commentsCreated++;
    }
  }

  // Second pass, once every issue exists: parents and dependencies (either
  // side may live in another team's project or in a previous import run).
  const findByRef = (ref: string): { id: number } | undefined => {
    const m = /^([A-Z]{2,10})-(\d+)$/.exec(ref);
    if (!m) return undefined;
    const project = db.select().from(projects).where(eq(projects.key, m[1])).get();
    if (!project) return undefined;
    return db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.projectId, project.id), eq(issues.number, Number(m[2]))))
      .get();
  };

  for (const pi of plan.issues) {
    if (!pi.parentRef) continue;
    const child = findByRef(pi.ref);
    const parent = findByRef(pi.parentRef);
    if (!child || !parent) {
      report.warnings.push(`${pi.ref}: parent ${pi.parentRef} not found — leaving unparented`);
      continue;
    }
    db.update(issues).set({ parentId: parent.id }).where(eq(issues.id, child.id)).run();
  }

  for (const dep of plan.dependencies) {
    const blocker = findByRef(dep.blockerRef);
    const blocked = findByRef(dep.blockedRef);
    if (!blocker || !blocked) {
      report.warnings.push(
        `dependency ${dep.blockerRef} → ${dep.blockedRef}: issue not found — skipping`,
      );
      continue;
    }
    const inserted = db
      .insert(dependencies)
      .values({ blockerId: blocker.id, blockedId: blocked.id })
      .onConflictDoNothing()
      .returning()
      .get();
    if (inserted) {
      db.insert(events)
        .values({
          issueId: blocked.id,
          actorId: actorFor(FALLBACK_ACTOR_NAME).id,
          type: "blocked_by_added",
          payload: { blocker: dep.blockerRef },
        })
        .run();
      report.dependenciesCreated++;
    }
  }

  // Bump each project's counter past the highest imported number (never down).
  for (const pi of plan.issues) {
    const project = projectByKey.get(pi.projectKey);
    if (!project) continue;
    db.update(projects)
      .set({ nextIssueNumber: pi.number + 1 })
      .where(and(eq(projects.id, project.id), lt(projects.nextIssueNumber, pi.number + 1)))
      .run();
  }

  return report;
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
