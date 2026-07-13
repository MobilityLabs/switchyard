import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const STATUSES = [
  "triage",
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
] as const;
export type Status = (typeof STATUSES)[number];

export const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

const now = () => sql`(unixepoch())`;

export const actors = sqliteTable("actors", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  type: text("type", { enum: ["human", "agent"] }).notNull(),
  tokenHash: text("token_hash"),
  createdAt: integer("created_at").notNull().default(now()),
});

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  nextIssueNumber: integer("next_issue_number").notNull().default(1),
  createdAt: integer("created_at").notNull().default(now()),
});

export const issues = sqliteTable(
  "issues",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    summary: text("summary"),
    status: text("status", { enum: STATUSES }).notNull(),
    priority: text("priority", { enum: PRIORITIES }).notNull().default("none"),
    assigneeId: integer("assignee_id").references(() => actors.id),
    creatorId: integer("creator_id")
      .notNull()
      .references(() => actors.id),
    parentId: integer("parent_id").references((): AnySQLiteColumn => issues.id),
    labels: text("labels", { mode: "json" }).$type<string[]>().notNull().default([]),
    sourceType: text("source_type", { enum: ["session", "todo", "ci", "manual"] }),
    sourceDetail: text("source_detail"),
    sourceUrl: text("source_url"),
    needsInput: integer("needs_input", { mode: "boolean" }).notNull().default(false),
    snoozedUntil: integer("snoozed_until"),
    // Soft dispatch routing (SYD-201): a hint naming the preferred worker
    // classification (its engine, e.g. "codex"). selectDispatchable sorts
    // matching issues ahead of neutral ones for that worker; null = no
    // preference. Never restricts — an idle worker still falls back to it.
    workerPreference: text("worker_preference"),
    createdAt: integer("created_at").notNull().default(now()),
    updatedAt: integer("updated_at").notNull().default(now()),
  },
  (t) => [
    index("issues_project_id_idx").on(t.projectId),
    index("issues_status_idx").on(t.status),
    index("issues_assignee_id_idx").on(t.assigneeId),
  ],
);

export const dependencies = sqliteTable(
  "dependencies",
  {
    blockerId: integer("blocker_id")
      .notNull()
      .references(() => issues.id),
    blockedId: integer("blocked_id")
      .notNull()
      .references(() => issues.id),
  },
  (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] })],
);

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    issueId: integer("issue_id")
      .notNull()
      .references(() => issues.id),
    actorId: integer("actor_id")
      .notNull()
      .references(() => actors.id),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: integer("created_at").notNull().default(now()),
  },
  (t) => [index("events_issue_id_idx").on(t.issueId)],
);

export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tokenHash: text("token_hash").notNull().unique(),
  actorId: integer("actor_id")
    .notNull()
    .references(() => actors.id),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull().default(now()),
});

export const loginLinks = sqliteTable("login_links", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tokenHash: text("token_hash").notNull().unique(),
  actorId: integer("actor_id")
    .notNull()
    .references(() => actors.id),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
  createdAt: integer("created_at").notNull().default(now()),
});

export const attachments = sqliteTable("attachments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  issueId: integer("issue_id")
    .notNull()
    .references(() => issues.id),
  actorId: integer("actor_id")
    .notNull()
    .references(() => actors.id),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  createdAt: integer("created_at").notNull().default(now()),
});

export const webhooks = sqliteTable("webhooks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  url: text("url").notNull(),
  projectId: integer("project_id").references(() => projects.id),
  secret: text("secret"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull().default(now()),
});

export const webhookCursor = sqliteTable("webhook_cursor", {
  id: integer("id").primaryKey(),
  lastEventId: integer("last_event_id").notNull().default(0),
});

export const githubRepos = sqliteTable("github_repos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fullName: text("full_name").notNull().unique(),
  projectId: integer("project_id").references(() => projects.id),
  secret: text("secret"),
  createdAt: integer("created_at").notNull().default(now()),
});

// Mutable PR state, one row per (repo, prNumber) — the single source of truth
// the sync overhaul (SYD-206, spec: docs/2026-07-12-sync-simplification-
// assessment.md) migrates PR readers onto. Written ONLY via upsertPrState
// (src/services/pr-state.ts), which enforces the ordering discipline (terminal
// states never regress, monotonic ghUpdatedAt, recency-checked reopened) and
// co-writes the canonical transition event. ghUpdatedAt is GitHub's own
// updated_at as epoch seconds — never a local clock, so host skew can't
// out-rank later genuine updates.
export const prState = sqliteTable(
  "pr_state",
  {
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    branch: text("branch"),
    // Set only from the strict agent/<ref> branch match AND when this repo is
    // bound to that ref's project — display-only PRs keep it null.
    issueRef: text("issue_ref"),
    status: text("status", { enum: ["open", "merged", "closed"] }).notNull(),
    headSha: text("head_sha"),
    ghUpdatedAt: integer("gh_updated_at"),
    url: text("url"),
    lastTransitionEventId: integer("last_transition_event_id"),
    updatedAt: integer("updated_at").notNull().default(now()),
  },
  (t) => [primaryKey({ columns: [t.repo, t.prNumber] }), index("pr_state_issue_ref_idx").on(t.issueRef)],
);

// The delivery-side twin of pr_state (SYD-208, spec: docs/2026-07-12-sync-
// simplification-assessment.md Step 2): one row per delivery attempt, keyed by
// the human authorization event (a done-stamp or redeliver_requested) that
// authorized it. The trigger query — done issues with an authorization that
// has no attempt row — replaces the deliver-cursor, so "once per human
// trigger" is a table constraint, not a cursor invariant. headSha is the
// authorized head (S0); derivedHeadSha is the post-rebase head (S1) the
// SYD-209 orchestrator persists for crash re-anchoring. outcome is null while
// an attempt is running; a start row with no finish is crash evidence, resumed
// against live GitHub (never pr_state).
export const DELIVERY_OUTCOMES = [
  "merged_deployed",
  "merged_deploy_failed",
  "verify_failed",
  "conflict_bounced",
  "merge_failed",
  "checks_timeout",
  "sha_chain_disarmed",
  "skipped_rollout",
] as const;
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];

export const deliveryAttempts = sqliteTable(
  "delivery_attempts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    issueRef: text("issue_ref").notNull(),
    prNumber: integer("pr_number"),
    headSha: text("head_sha"),
    derivedHeadSha: text("derived_head_sha"),
    authorizationId: integer("authorization_id")
      .notNull()
      .references(() => events.id),
    startedAt: integer("started_at").notNull().default(now()),
    finishedAt: integer("finished_at"),
    outcome: text("outcome", { enum: DELIVERY_OUTCOMES }),
  },
  (t) => [
    index("delivery_attempts_authorization_id_idx").on(t.authorizationId),
    index("delivery_attempts_issue_ref_idx").on(t.issueRef),
  ],
);

// One-row marker: the SYD-208 rollout backfill (skipped_rollout rows for every
// pre-existing authorization) ran. A marker, not an empty-table check — on a
// fresh install the table stays empty until the first real stamp, and that
// stamp must not be swallowed by a restart.
export const deliveryRollout = sqliteTable("delivery_rollout", {
  id: integer("id").primaryKey(),
  completedAt: integer("completed_at").notNull().default(now()),
});

// Config knobs (SYD-154): rows exist only for values overriding the
// compile-time registry default in src/services/settings.ts — "reset to
// default" deletes the row. Not an events-table concern (same reasoning as
// agent_sessions): settings are not issue history.
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: integer("updated_at").notNull().default(now()),
  updatedByActorId: integer("updated_by_actor_id").references(() => actors.id),
});

// Live agent-session lifecycle (SYD-43): worker-process state (pid, exit
// code), not issue history — hence a table, unlike progress notes which ride
// the events table.
export const agentSessions = sqliteTable(
  "agent_sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    issueId: integer("issue_id")
      .notNull()
      .references(() => issues.id),
    actorId: integer("actor_id")
      .notNull()
      .references(() => actors.id),
    mode: text("mode", { enum: ["cli", "container", "sdk"] }).notNull(),
    pid: integer("pid"),
    status: text("status", { enum: ["running", "exited"] })
      .notNull()
      .default("running"),
    exitCode: integer("exit_code"),
    startedAt: integer("started_at").notNull().default(now()),
    endedAt: integer("ended_at"),
  },
  (t) => [index("agent_sessions_issue_id_idx").on(t.issueId)],
);
