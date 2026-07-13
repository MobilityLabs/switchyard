import { and, eq, max, ne, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { issues, events } from "../db/schema.js";
import { recordEvent } from "./events.js";
import { getSetting } from "./settings.js";
import { getActiveLease } from "./leases.js";

/**
 * Releases `in_progress` issues whose newest event is older than `maxIdleSeconds`.
 * Issues with `needsInput` set are skipped — an agent that escalated correctly
 * (via request_human_input) is waiting on a human, not idling, and must not be
 * cycled back to `todo` and re-dispatched.
 * For each released issue: status -> todo, assignee cleared, and a
 * `claim_released` event is recorded (attributed to the assignee if set, else
 * the creator). Returns the number of issues released.
 *
 * `process_deviation` events are excluded from the idle computation (SYD-188):
 * that signal is itself derived from this same idle clock, so recording one at
 * ~now must not reset the clock and delay auto-release.
 */
export function releaseStaleClaims(
  db: Db,
  maxIdleSeconds: number = getSetting(db, "claims.stale_seconds"),
  serverStartedAt?: number,
): number {
  const now = Math.floor(Date.now() / 1000);
  // SYD-210 review: share the lease sweep's server-uptime grace (leases.ts
  // expireLeases). A tracker redeploy is a correlated outage — right after
  // restart, don't let the legacy idle sweep release either, or a lease whose
  // liveness lapsed during the outage (invisible to the leased-skip below) could
  // be released the instant the server comes back, before its container
  // re-heartbeats. Skip the whole sweep for one heartbeat window after start.
  if (
    serverStartedAt !== undefined &&
    now - serverStartedAt < getSetting(db, "claims.heartbeat_window_seconds")
  ) {
    return 0;
  }
  const cutoff = now - maxIdleSeconds;

  const inProgress = db.select().from(issues).where(eq(issues.status, "in_progress")).all();

  let released = 0;
  for (const issue of inProgress) {
    if (issue.needsInput) continue; // an agent that escalated correctly must not be punished
    // SYD-210: a leased claim is governed by lease expiry (8h TTL), not the 4h
    // idle guess — a healthy quiet container keeps its lease. Only lease-less
    // claims (none after the hard cutover) still fall to this idle sweep.
    if (getActiveLease(db, issue.id)) continue;
    const newest = db
      .select({ createdAt: max(events.createdAt) })
      .from(events)
      .where(and(eq(events.issueId, issue.id), ne(events.type, "process_deviation")))
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
        .set({ status: "todo", assigneeId: null, updatedAt: sql`(unixepoch())` })
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
