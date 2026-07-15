import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { issues } from "../db/schema.js";
import type { Actor } from "./actors.js";
import type { Attribution } from "./attribution.js";
import { SwitchyardError } from "./errors.js";
import { getIssue } from "./issues.js";
import { listIssueEvents, recordEvent } from "./events.js";
import { invalidateLease } from "./leases.js";

/** Convention (SYD-56): a human comment addressed to agents leads with `@agent`. */
const AGENT_QUESTION_RE = /^@agent\b/i;

export function addComment(
  db: Db,
  actor: Actor,
  ref: string,
  body: string,
  attr: Attribution = {},
): void {
  if (!body.trim()) {
    throw new SwitchyardError("Comment body is empty — write what you did or what you need.");
  }
  db.transaction((tx) => {
    const issue = getIssue(tx, ref);
    recordEvent(tx, {
      issueId: issue.id,
      actorId: actor.id,
      type: "comment",
      payload: { body },
      viaAgentId: attr.viaAgentId,
      sessionId: attr.sessionId,
    });
    if (actor.type === "human" && AGENT_QUESTION_RE.test(body.trim())) {
      // Read-only signal for the worker's answerer mode: no issue-state change,
      // just a marker event the event poll can watch for (same shape as
      // needs_input_cleared below) — works on any status, including triage.
      recordEvent(tx, {
        issueId: issue.id,
        actorId: actor.id,
        type: "agent_question",
        payload: { body },
        viaAgentId: attr.viaAgentId,
        sessionId: attr.sessionId,
      });
    }
    if (actor.type === "human" && issue.needsInput) {
      // The agent that escalated stopped its session, so an in_progress claim is
      // dead weight — release it with the answer so the worker can re-dispatch
      // immediately instead of waiting out the stale-claim sweep.
      const release = issue.status === "in_progress";
      tx.update(issues)
        .set({
          needsInput: false,
          updatedAt: sql`(unixepoch())`,
          ...(release ? { status: "todo" as const, assigneeId: null } : {}),
        })
        .where(eq(issues.id, issue.id))
        .run();
      recordEvent(tx, {
        issueId: issue.id,
        actorId: actor.id,
        type: "needs_input_cleared",
        viaAgentId: attr.viaAgentId,
        sessionId: attr.sessionId,
      });
      if (release) {
        recordEvent(tx, {
          issueId: issue.id,
          actorId: actor.id,
          type: "claim_released",
          payload: { reason: "needs_input_cleared" },
          viaAgentId: attr.viaAgentId,
          sessionId: attr.sessionId,
        });
        // SYD-210: the answering human never held the session's lease (this
        // path is lease-exempt), but releasing the claim ends it — invalidate
        // the active lease. Only on the in_progress release, preserving today's
        // status condition (a non-in_progress answer just clears the flag).
        invalidateLease(tx, issue.id);
      }
    }
  });
}

export function getActivity(db: Db, ref: string) {
  const issue = getIssue(db, ref);
  return listIssueEvents(db, issue.id).map((e) => ({
    type: e.type,
    actorName: e.actorName,
    payload: e.payload,
    createdAt: e.createdAt,
  }));
}
