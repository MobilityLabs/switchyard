import { eq, max } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { issues, events } from "../db/schema.js";
import { recordEvent } from "./events.js";

/**
 * Releases `in_progress` issues whose newest event is older than `maxIdleSeconds`.
 * For each: status -> todo, assignee cleared, and a `claim_released` event is
 * recorded (attributed to the assignee if set, else the creator).
 * Returns the number of issues released.
 */
export function releaseStaleClaims(db: Db, maxIdleSeconds = 4 * 3600): number {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - maxIdleSeconds;

  const inProgress = db
    .select()
    .from(issues)
    .where(eq(issues.status, "in_progress"))
    .all();

  let released = 0;
  for (const issue of inProgress) {
    const newest = db
      .select({ createdAt: max(events.createdAt) })
      .from(events)
      .where(eq(events.issueId, issue.id))
      .get();
    const newestCreatedAt = newest?.createdAt ?? issue.createdAt;
    if (newestCreatedAt > cutoff) continue;

    const idleSeconds = now - newestCreatedAt;
    const actorId = issue.assigneeId ?? issue.creatorId;
    db.transaction((tx) => {
      tx.update(issues)
        .set({ status: "todo", assigneeId: null, updatedAt: now })
        .where(eq(issues.id, issue.id))
        .run();
      recordEvent(tx as Db, {
        issueId: issue.id,
        actorId,
        type: "claim_released",
        payload: { idleSeconds },
      });
    });
    released++;
  }
  return released;
}
