import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { issues } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { getIssue } from "./issues.js";
import { listIssueEvents, recordEvent } from "./events.js";

export function addComment(db: Db, actor: Actor, ref: string, body: string): void {
  if (!body.trim()) {
    throw new SwitchyardError("Comment body is empty — write what you did or what you need.");
  }
  db.transaction((tx) => {
    const issue = getIssue(tx as Db, ref);
    recordEvent(tx as Db, { issueId: issue.id, actorId: actor.id, type: "comment", payload: { body } });
    if (actor.type === "human" && issue.needsInput) {
      tx.update(issues)
        .set({ needsInput: false, updatedAt: Math.floor(Date.now() / 1000) })
        .where(eq(issues.id, issue.id))
        .run();
      recordEvent(tx as Db, { issueId: issue.id, actorId: actor.id, type: "needs_input_cleared" });
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
