import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { issues } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { getIssue, toView, type IssueView } from "./issues.js";
import { recordEvent } from "./events.js";

/**
 * Flags an issue as needing human input: records the question as a comment,
 * sets needsInput, and records a needs_input_set event, all in one transaction.
 */
export function requestHumanInput(db: Db, actor: Actor, ref: string, question: string): IssueView {
  if (!question.trim()) {
    throw new SwitchyardError(
      "A question is required — say what you need a human to decide or clarify."
    );
  }
  return db.transaction((tx) => {
    const issue = getIssue(tx as Db, ref);
    const row = tx
      .update(issues)
      .set({ needsInput: true, updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(issues.id, issue.id))
      .returning()
      .get();
    recordEvent(tx as Db, { issueId: issue.id, actorId: actor.id, type: "comment", payload: { body: question } });
    recordEvent(tx as Db, { issueId: issue.id, actorId: actor.id, type: "needs_input_set" });
    return toView(tx as Db, row);
  });
}
