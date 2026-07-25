import type { Db } from "../db/index.js";
import type { Actor } from "./actors.js";
import type { Attribution } from "./attribution.js";
import { SwitchyardError } from "./errors.js";
import { getIssue, updateIssue } from "./issues.js";
import { listIssueEvents, recordEvent } from "./events.js";

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
      //
      // SYD-241: routed through updateIssue (instead of a raw tx.update)
      // so this status write passes through the same hard-gate divert as
      // every other status change — a supervised session answering its own
      // escalation can no longer reach a gated status unseen by the gate.
      // updateIssue's own needsInput-clearing and todo-release-clears-claim
      // logic (which also records claim_released + invalidates the lease)
      // subsumes what this branch used to do by hand.
      const release = issue.status === "in_progress";
      updateIssue(tx, actor, ref, { status: release ? "todo" : issue.status }, {}, attr);
    }
  });
}

export function getActivity(db: Db, ref: string) {
  const issue = getIssue(db, ref);
  return listIssueEvents(db, issue.id).map((e) => ({
    type: e.type,
    actorName: e.actorName,
    viaAgentName: e.viaAgentName,
    payload: e.payload,
    createdAt: e.createdAt,
  }));
}
