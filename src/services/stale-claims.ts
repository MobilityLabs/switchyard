import { and, eq, max } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { issues, events } from "../db/schema.js";
import { recordEvent } from "./events.js";

/**
 * Releases `in_progress` issues whose newest event is older than `maxIdleSeconds`.
 * Issues with `needsInput` set are skipped — an agent that escalated correctly
 * (via request_human_input) is waiting on a human, not idling, and must not be
 * cycled back to `todo` and re-dispatched.
 * For each released issue: status -> todo, assignee cleared, and a
 * `claim_released` event is recorded (attributed to the assignee if set, else
 * the creator). Returns the number of issues released.
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
    if (issue.needsInput) continue; // an agent that escalated correctly must not be punished
    const newest = db
      .select({ createdAt: max(events.createdAt) })
      .from(events)
      .where(eq(events.issueId, issue.id))
      .get();
    const newestCreatedAt = newest?.createdAt ?? issue.createdAt;
    if (newestCreatedAt > cutoff) continue;

    const idleSeconds = now - newestCreatedAt;
    const actorId = issue.assigneeId ?? issue.creatorId;
    const wasReleased = db.transaction((tx) => {
      // Re-assert status/needsInput inside the UPDATE's WHERE so a second writer
      // (e.g. src/cli.ts's own connection) that claimed or escalated this issue
      // between the read above and this transaction wins the race atomically —
      // .changes === 0 means someone else touched it first, so we skip the event.
      const result = tx
        .update(issues)
        .set({ status: "todo", assigneeId: null, updatedAt: now })
        .where(
          and(
            eq(issues.id, issue.id),
            eq(issues.status, "in_progress"),
            eq(issues.needsInput, false),
          ),
        )
        .run();
      if (result.changes === 0) return false;
      recordEvent(tx, {
        issueId: issue.id,
        actorId,
        type: "claim_released",
        payload: { idleSeconds },
      });
      return true;
    });
    if (wasReleased) released++;
  }
  return released;
}
