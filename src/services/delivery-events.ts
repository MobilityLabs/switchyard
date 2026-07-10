// Structured delivery-status events (SYD-54): deliver.ts and the auto-dispatch
// worker already know the moments that matter for the stamp-to-merge loop —
// PR opened, delivered (merged + deployed), or delivery failed. Recording
// these as typed events (not just prose comments) lets the issue UI render a
// delivery strip by scanning the activity feed instead of parsing text.

import type { Db } from "../db/index.js";
import type { Actor } from "./actors.js";
import { getIssue } from "./issues.js";
import { recordEvent } from "./events.js";
import { SwitchyardError } from "./errors.js";

export type DeployResult = { ran: false } | { ran: true; ok: boolean; tail: string };

export type DeliveryEventInput =
  | { type: "pr_opened"; prNumber: number; url: string }
  | { type: "delivered"; prNumber: number; mergeSha: string; deploy: DeployResult }
  | { type: "delivery_failed"; message: string };

// `delivered`/`delivery_failed` are load-bearing (SYD-108): getOpenPr treats a
// `delivered` after `pr_opened` as the PR closing out (pr-status.ts), and
// getAttention treats an unresolved `delivery_failed` as a signal a human
// needs to act on. Without this guard, any dispatched agent holding a bearer
// token could forge a `delivered` event to clear the SYD-99 open-PR claim
// gate on its own issue, or forge/clear a `delivery_failed` to hide a real
// failure — same class of fix as SYD-107's human-only restriction on POST
// /api/github-events. `pr_opened` stays open to agent actors: it's posted by
// the auto-dispatch worker's own (agent-typed) identity right after it
// publishes a branch (scripts/agent-worker.ts), and merely recording one
// doesn't clear any gate — only a later `delivered` does.
const HUMAN_ONLY_TYPES = new Set<DeliveryEventInput["type"]>(["delivered", "delivery_failed"]);

export function recordDeliveryEvent(db: Db, actor: Actor, ref: string, input: DeliveryEventInput): void {
  if (actor.type === "agent" && HUMAN_ONLY_TYPES.has(input.type)) {
    throw new SwitchyardError(
      `Only a trusted human-authenticated delivery worker may post a "${input.type}" delivery event — agents cannot.`
    );
  }
  const issue = getIssue(db, ref);
  const { type, ...payload } = input;
  recordEvent(db, { issueId: issue.id, actorId: actor.id, type, payload });
}
