export type Actor = { id: number; name: string; type: "human" | "agent" };
export type ActorWithStatus = Actor & { createdAt: number; hasToken: boolean };
export type Project = {
  id: number;
  key: string;
  name: string;
  nextIssueNumber: number;
  createdAt: number;
};
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
export const SUMMARY_MAX_LENGTH = 280;
/** Reserved workerPreference selecting a human-attended interactive session (never headless dispatch). */
export const INTERACTIVE_PREFERENCE = "interactive";
/** Options for the "preferred worker" dropdown: an engine name, or the interactive sentinel. */
export const WORKER_PREFERENCES = ["claude", "codex", "gemini", INTERACTIVE_PREFERENCE] as const;
/** Every reason `GET /api/issues?attention=` accepts — mirrors AttentionFlag["reason"] server-side. */
export const ATTENTION_REASONS = [
  "delivery_failed",
  "merged_pr_not_done",
  "open_pr_not_in_review",
  "stale_claim",
  "done_without_merged_pr",
  "done_pr_not_delivered",
] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

export type Issue = {
  id: number;
  /** Needed to scope a declared PR link to the repos bound to this issue's project. */
  projectId: number;
  ref: string;
  title: string;
  description: string;
  summary: string | null;
  status: Status;
  priority: Priority;
  assigneeId: number | null;
  creatorId: number;
  labels: string[];
  workerPreference: string | null;
  parentId: number | null;
  childCount?: number;
  sourceType: "session" | "todo" | "ci" | "manual" | null;
  sourceDetail: string | null;
  sourceUrl: string | null;
  needsInput: boolean;
  snoozedUntil: number | null;
  createdAt: number;
  updatedAt: number;
  attention: { reason: AttentionReason; message: string } | null;
  openPr: { prNumber: number; url: string; repo: string; headSha: string | null } | null;
};
export const PR_LINK_ROLES = ["delivers", "references"] as const;
export type PrLinkRole = (typeof PR_LINK_ROLES)[number];

/**
 * A declared issue↔PR link as the issue page shows it (SYD-280/SYD-290) — the
 * shape `listLiveLinkViews` returns, which is the DECLARATION (who said this PR
 * carries the work, and who vouched for it) joined to the OBSERVATION (what
 * GitHub was last seen doing to that PR).
 *
 * `observed: null` is not "not merged" — it means nothing has ever observed
 * this PR, which is the state every PR merged before SYD-287 is in. The panel
 * has to distinguish the two, because only the first is fixable by clicking.
 */
export type PrLinkView = {
  id: number;
  issueId: number;
  repo: string;
  prNumber: number;
  role: PrLinkRole;
  declaredBy: number;
  declaredByName: string;
  declaredAt: number;
  confirmedBy: number | null;
  confirmedByName: string | null;
  confirmedByHuman: boolean;
  confirmedAt: number | null;
  revokedAt: number | null;
  observed: {
    status: "open" | "merged" | "closed";
    url: string | null;
    ghUpdatedAt: number | null;
  } | null;
  /** Whether this link alone lets a reader conclude the work landed — the server's verdict, not the UI's. */
  provesLanded: boolean;
};

export type Activity = {
  type: string;
  actorName: string;
  /** Supervised-session provenance (SYD-240): the agent that made the edit on the actor's behalf, or null for plain events. */
  viaAgentName: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
};
export type DeployResult = { ran: false } | { ran: true; ok: boolean; tail: string };
export type DependencyRef = { ref: string; title: string; status: Status };
export type Attachment = {
  id: number;
  filename: string;
  contentType: string;
  size: number;
  actorName: string;
  createdAt: number;
};
export type IssueDetail = Issue & {
  activity: Activity[];
  dependencies: { blockedBy: DependencyRef[]; blocks: DependencyRef[] };
  attachments: Attachment[];
  /** Epic → stories: child issues nested under this one. */
  children: DependencyRef[];
  /** The parent issue's ref for display/edit, or null if top-level. */
  parentRef: string | null;
  deliveryPin: {
    repo: string;
    prNumber: number;
    headSha: string | null;
    status: "open" | "merged" | "closed";
  } | null;
  /** Live declared PR links — read these directly, never inferred from openPr/deliveryPin. */
  prLinks: PrLinkView[];
};
export type AgentSession = {
  id: number;
  ref: string;
  issueTitle: string;
  mode: "cli" | "container" | "sdk";
  pid: number | null;
  status: "running" | "exited";
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  lastNote: { note: string; createdAt: number } | null;
  actor: string;
};

// Supervised-session hard-gate queue (SYD phase 1 task 8): a gated action
// (currently only "done") parked for the session's accountable human to
// affirm. Mirrors the pending_actions row shape returned by GET
// /api/pending-actions (src/rest/pending-actions.ts).
export const PENDING_ACTION_STATUSES = ["pending", "affirmed", "expired"] as const;
export type PendingActionStatus = (typeof PENDING_ACTION_STATUSES)[number];
export type PendingAction = {
  id: number;
  sessionId: number;
  issueId: number;
  actionType: string;
  payload: Record<string, unknown>;
  status: PendingActionStatus;
  affirmedById: number | null;
  affirmedAt: number | null;
  createdAt: number;
  expiresAt: number;
  // Added by GET /api/pending-actions (SYD phase 1 task 8 / phase 2 task 8):
  // issueRef lets the panel skip the whole-issue-list poll it used to run
  // just to resolve issueId -> ref (SYD-244). canonical is the signed doc's
  // exact bytes (phase 2); viaAgentName names the agent that proposed the
  // action, for display only.
  issueRef: string | null;
  issueStatus: string | null;
  canonical: string | null;
  viaAgentName: string | null;
};

export type WebhookView = {
  id: number;
  url: string;
  projectId: number | null;
  active: boolean;
  createdAt: number;
  hasSecret: boolean;
};
export type GithubRepoView = {
  id: number;
  fullName: string;
  projectId: number | null;
  createdAt: number;
  hasSecret: boolean;
};

export type SettingView = {
  key: string;
  value: unknown;
  default: unknown;
  isDefault: boolean;
  description: string | null;
};
