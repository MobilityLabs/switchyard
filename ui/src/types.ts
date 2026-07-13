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
export type Issue = {
  id: number;
  ref: string;
  title: string;
  description: string;
  summary: string | null;
  status: Status;
  priority: Priority;
  assigneeId: number | null;
  creatorId: number;
  labels: string[];
  sourceType: "session" | "todo" | "ci" | "manual" | null;
  sourceDetail: string | null;
  sourceUrl: string | null;
  needsInput: boolean;
  snoozedUntil: number | null;
  createdAt: number;
  updatedAt: number;
  attention:
    | { reason: "delivery_failed"; message: string }
    | { reason: "merged_pr_not_done"; message: string }
    | { reason: "open_pr_not_in_review"; message: string }
    | { reason: "stale_claim"; message: string }
    | null;
  openPr: { prNumber: number; url: string; repo: string; headSha: string | null } | null;
};
export type Activity = {
  type: string;
  actorName: string;
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
  deliveryPin: { repo: string; prNumber: number; headSha: string | null; status: "open" | "merged" | "closed" } | null;
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
