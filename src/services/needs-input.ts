import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { issues } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { getIssue, toView, type IssueView } from "./issues.js";
import { recordEvent } from "./events.js";
import { validateLease } from "./leases.js";

/**
 * Flags an issue as needing human input: records the question as a comment,
 * sets needsInput, and records a needs_input_set event, all in one transaction.
 */
export function requestHumanInput(
  db: Db,
  actor: Actor,
  ref: string,
  question: string,
  leaseToken?: string,
): IssueView {
  if (!question.trim()) {
    throw new SwitchyardError(
      "A question is required — say what you need a human to decide or clarify.",
    );
  }
  return db.transaction((tx) => {
    const issue = getIssue(tx, ref);
    // SYD-213: a `service` token never mutates board state — needsInput is board
    // state, and the delivery worker escalates failures via delivery_failed
    // events, not needsInput. Fail-closed, matching createIssue/updateIssue.
    if (actor.type === "service") {
      throw new SwitchyardError(
        "Service actors post events, read, and comment — they cannot modify issues.",
      );
    }
    // SYD-210: escalating an issue you HOLD is a claim-scoped mutation — the
    // holder must present the lease minted at claim time (design §3: "an
    // already-claimed issue by its holder"). A non-holder agent escalating an
    // issue it hasn't claimed is a benign additive signal (like comment) and is
    // not lease-gated; humans are never lease-gated.
    if (actor.type === "agent" && issue.assigneeId === actor.id) {
      validateLease(tx, issue.id, actor.id, leaseToken);
    }
    const row = tx
      .update(issues)
      .set({ needsInput: true, updatedAt: sql`(unixepoch())` })
      .where(eq(issues.id, issue.id))
      .returning()
      .get();
    recordEvent(tx, {
      issueId: issue.id,
      actorId: actor.id,
      type: "comment",
      payload: { body: question },
    });
    recordEvent(tx, { issueId: issue.id, actorId: actor.id, type: "needs_input_set" });
    return toView(tx, row);
  });
}
