// Structured delivery-status events (SYD-54): deliver.ts and the auto-dispatch
// worker already know the moments that matter for the stamp-to-merge loop —
// PR opened, delivered (merged + deployed), or delivery failed. Recording
// these as typed events (not just prose comments) lets the issue UI render a
// delivery strip by scanning the activity feed instead of parsing text.

import type { Db } from "../db/index.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
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
  // SYD-108: these events are load-bearing — getOpenPr treats `delivered`
  // after `pr_opened` as "PR closed out" (clearing the SYD-99 claim gate) and
  // getAttention treats it as clearing a delivery_failed. An agent that could
  // post them could unblock its own issue or hide a failed delivery. The
  // legit posters (deliver.ts, agent-worker.ts) authenticate with the
  // worker's human-typed infra token (same identity rule as /github-events,
  // SYD-107); dispatched agents' own tokens are refused here.
  if (actor.type === "agent") {
    throw new SwitchyardError(
      "Only the delivery infrastructure (a human-typed token) may record delivery events — agents cannot post delivery status.",
    );
  }
  const issue = getIssue(db, ref);
  const { type, ...payload } = input;
  recordEvent(db, { issueId: issue.id, actorId: actor.id, type, payload });
}
