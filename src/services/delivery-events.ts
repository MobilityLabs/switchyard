// Structured delivery-status events (SYD-54): deliver.ts and the auto-dispatch
// worker already know the moments that matter for the stamp-to-merge loop —
// PR opened, delivered (merged + deployed), or delivery failed. Recording
// these as typed events (not just prose comments) lets the issue UI render a
// delivery strip by scanning the activity feed instead of parsing text.

import type { Db } from "../db/index.js";
import type { Actor } from "./actors.js";
import { getIssue } from "./issues.js";
import { recordEvent } from "./events.js";

export type DeployResult = { ran: false } | { ran: true; ok: boolean; tail: string };

export type DeliveryEventInput =
  | { type: "pr_opened"; prNumber: number; url: string }
  | { type: "delivered"; prNumber: number; mergeSha: string; deploy: DeployResult }
  | { type: "delivery_failed"; message: string };

export function recordDeliveryEvent(
  db: Db,
  actor: Actor,
  ref: string,
  input: DeliveryEventInput,
): void {
  const issue = getIssue(db, ref);
  const { type, ...payload } = input;
  recordEvent(db, { issueId: issue.id, actorId: actor.id, type, payload });
}
