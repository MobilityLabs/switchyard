export type Actor = { id: number; name: string; type: "human" | "agent" };
export type Project = { id: number; key: string; name: string };
export const STATUSES = ["triage", "backlog", "todo", "in_progress", "in_review", "done", "canceled"] as const;
export type Status = (typeof STATUSES)[number];
export const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const SUMMARY_MAX_LENGTH = 280;
export type Issue = {
  id: number; ref: string; title: string; description: string; summary: string | null;
  status: Status; priority: Priority;
  assigneeId: number | null; creatorId: number; labels: string[];
  sourceType: "session" | "todo" | "ci" | "manual" | null;
  sourceDetail: string | null; sourceUrl: string | null;
  needsInput: boolean; snoozedUntil: number | null;
  createdAt: number; updatedAt: number;
  attention: { reason: "delivery_failed"; message: string } | null;
};
export type Activity = { type: string; actorName: string; payload: Record<string, unknown>; createdAt: number };
export type DeployResult = { ran: false } | { ran: true; ok: boolean; tail: string };
export type DependencyRef = { ref: string; title: string; status: Status };
export type Attachment = {
  id: number; filename: string; contentType: string; size: number; actorName: string; createdAt: number;
};
export type IssueDetail = Issue & {
  activity: Activity[];
  dependencies: { blockedBy: DependencyRef[]; blocks: DependencyRef[] };
  attachments: Attachment[];
};
