import type { Db } from "../db/index.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { getIssue } from "./issues.js";
import { listIssueEvents, recordEvent } from "./events.js";

export function addComment(db: Db, actor: Actor, ref: string, body: string): void {
  if (!body.trim()) {
    throw new SwitchyardError("Comment body is empty — write what you did or what you need.");
  }
  const issue = getIssue(db, ref);
  recordEvent(db, { issueId: issue.id, actorId: actor.id, type: "comment", payload: { body } });
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
