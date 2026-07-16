import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  uniqueIndex,
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
  type: text("type", { enum: ["human", "agent", "service"] }).notNull(),
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

/**
 * Every event `type` the append-only audit log records (SYD-211). A closed const
 * union so producers and consumers can't drift on free-text strings — the log is
 * a co-written audit trail (see src/services/issues.ts), and integrity there is
 * the whole point. `recordEvent` (src/services/events.ts) is the single write
 * path and types its `type` param to `EventKind`, so a new kind must be added
 * here first. No orchestration control flow branches on this — the derived
 * signals (attention/open-PR/unanswered-questions) query specific types, they
 * don't switch over the whole set.
 */
export const EVENT_KINDS = [
  // Issue lifecycle
  "created",
  "status_changed",
  "assigned",
  "priority_changed",
  "title_changed",
  "description_changed",
  "summary_changed",
  "labels_changed",
  "worker_preference_changed",
  "parent_changed",
  "snoozed",
  "marked_duplicate",
  "redeliver_requested",
  // Comments, human input, agent notes
  "comment",
  "needs_input_set",
  "needs_input_cleared",
  "agent_question",
  "progress_note",
  "process_deviation",
  // Dependencies
  "blocked_by_added",
  "blocked_by_removed",
  // Attachments
  "attachment_added",
  // Claims and session leases
  "claim_released",
  "lease_taken_over",
  // Delivery (deliver.ts / agent-worker.ts via recordDeliveryEvent)
  "pr_opened",
  "delivered",
  "delivery_failed",
  "delivery_resolved",
  // GitHub ingestion (webhook + poller)
  "gh_pr_opened",
  "gh_pr_reopened",
  "gh_pr_merged",
  "gh_pr_closed",
  "gh_pushed",
  "gh_checks_passed",
  "gh_checks_failed",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

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
    type: text("type").$type<EventKind>().notNull(),
    payload: text("payload", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    // Supervised-session provenance (dual attribution): viaAgentId names the
    // agent acting on the human actor's behalf; sessionId ties the event back
    // to the supervised session it was written under. Both null for ordinary
    // (non-supervised) writes.
    viaAgentId: integer("via_agent_id").references(() => actors.id),
    sessionId: integer("session_id").references(() => sessions.id),
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
  // Supervised interactive sessions (dual attribution): kind="supervised"
  // binds the human actorId above to the acting agent in viaAgentId. Plain
  // sessions leave viaAgentId null. closedAt marks when a supervised session
  // ended (distinct from expiresAt, which is the credential's own TTL).
  kind: text("kind", { enum: ["plain", "supervised"] })
    .notNull()
    .default("plain"),
  viaAgentId: integer("via_agent_id").references(() => actors.id),
  closedAt: integer("closed_at"),
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
  (t) => [
    primaryKey({ columns: [t.repo, t.prNumber] }),
    index("pr_state_issue_ref_idx").on(t.issueRef),
  ],
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

// Session-scoped claim leases (SYD-210): a claim's credential layer on top of
// issues.assigneeId/status. At most one ACTIVE lease per issue —
// invalidated_at IS NULL AND expires_at > now — enforced by construction (a
// claim is 1:1 with an issue); invalidated/expired rows are retained for
// audit. Clones the sessions/loginLinks precedent (hashed token + actorId +
// expiresAt). token_hash is sha256 hex; the plaintext is returned once at
// claim time and never stored.
export const claimLeases = sqliteTable(
  "claim_leases",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    issueId: integer("issue_id")
      .notNull()
      .references(() => issues.id),
    actorId: integer("actor_id")
      .notNull()
      .references(() => actors.id),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: integer("expires_at").notNull(),
    // Heartbeat renewal (Layer B); = created_at at mint.
    lastBeatAt: integer("last_beat_at").notNull(),
    // Set by takeover / self-release / human-answer release / expiry sweep.
    invalidatedAt: integer("invalidated_at"),
    createdAt: integer("created_at").notNull().default(now()),
  },
  (t) => [index("claim_leases_issue_id_idx").on(t.issueId)],
);

// One-row marker: the SYD-210 hard-cutover backfill (release every pre-existing
// lease-less in_progress claim) ran. A marker, not an empty-table check, so it
// is once-only across restarts.
export const claimLeaseCutover = sqliteTable("claim_lease_cutover", {
  id: integer("id").primaryKey(),
  completedAt: integer("completed_at").notNull().default(now()),
});

export const PENDING_ACTION_STATUSES = ["pending", "affirmed", "expired"] as const;
export type PendingActionStatus = (typeof PENDING_ACTION_STATUSES)[number];

// Supervised interactive sessions (phase 1 design, docs/superpowers/): a
// hard-gated action (e.g. moving an issue to done) proposed by the agent side
// of a supervised session, awaiting the bound human's affirmation before it
// executes. The partial unique index pending_actions_active_uniq allows only
// one *pending* row per (session, issue, actionType) tuple at a time — once a
// row is affirmed or expired it stops blocking a fresh pending proposal for
// the same tuple, which is what onConflictDoUpdate dedup targets.
export const pendingActions = sqliteTable(
  "pending_actions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.id),
    issueId: integer("issue_id")
      .notNull()
      .references(() => issues.id),
    actionType: text("action_type").notNull(),
    payload: text("payload", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: text("status", { enum: PENDING_ACTION_STATUSES }).notNull().default("pending"),
    affirmedById: integer("affirmed_by_id").references(() => actors.id),
    affirmedAt: integer("affirmed_at"),
    createdAt: integer("created_at").notNull().default(now()),
    // Phase 2: signed into the canonical action doc, so it cannot be extended
    // after the fact. Not nullable — an unbounded affirmation is a bearer token
    // with extra steps. Enforced in affirmPendingAction (inside its transaction,
    // so BOTH the cookie and signed paths are covered by one check).
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [
    uniqueIndex("pending_actions_active_uniq")
      .on(t.sessionId, t.issueId, t.actionType)
      .where(sql`status = 'pending'`),
  ],
);

// Phase 2 (affirmation relay): the SSH public keys allowed to sign a human's
// affirmations. A table, not a column, because the design has NO break-glass —
// recovery is key redundancy (enroll two: one on the keyring, one in a drawer).
// `publicKey` stores a full authorized-keys-style line ("ssh-ed25519-sk AAAA...
// comment") exactly as ssh-keygen emits it; buildAllowedSigners wraps it with
// the principal, namespace, and verify-required.
export const affirmationKeys = sqliteTable(
  "affirmation_keys",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    actorId: integer("actor_id")
      .notNull()
      .references(() => actors.id),
    publicKey: text("public_key").notNull(),
    comment: text("comment"),
    createdAt: integer("created_at").notNull().default(now()),
    revokedAt: integer("revoked_at"),
  },
  (t) => [
    // Partial: a revoked key may be re-enrolled, but the same key can't be live
    // twice for one actor. Mirrors pending_actions_active_uniq's shape.
    uniqueIndex("affirmation_keys_active_uniq")
      .on(t.actorId, t.publicKey)
      .where(sql`revoked_at is null`),
  ],
);
