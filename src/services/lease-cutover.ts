import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { claimLeaseCutover, issues } from "../db/schema.js";
import { recordEvent } from "./events.js";

/**
 * One-time SYD-210 hard-cutover backfill: the enforcing deploy makes a valid
 * lease required on every claim-scoped mutation, but pre-existing in_progress
 * claims have no lease token any running session can present. An honest reset
 * releases every in-flight claim (status->todo, assignee->null,
 * claim_released{reason:"lease_cutover"}) so it can be cleanly re-claimed
 * through the new mint path. Guarded by the claim_lease_cutover marker so it is
 * once-only across restarts. Blast radius is low: the worker launchd services
 * are down at cutover, so the only live claim is the interactive session
 * running this work, which simply re-claims.
 */
export function ensureClaimLeaseCutover(db: Db): { released: number; alreadyDone: boolean } {
  return db.transaction((tx) => {
    const marker = tx.select().from(claimLeaseCutover).get();
    if (marker) return { released: 0, alreadyDone: true };
    const inProgress = tx.select().from(issues).where(eq(issues.status, "in_progress")).all();
    for (const issue of inProgress) {
      const actorId = issue.assigneeId ?? issue.creatorId;
      tx.update(issues)
        .set({ status: "todo", assigneeId: null, updatedAt: sql`(unixepoch())` })
        .where(eq(issues.id, issue.id))
        .run();
      recordEvent(tx, {
        issueId: issue.id,
        actorId,
        type: "claim_released",
        payload: { reason: "lease_cutover" },
      });
    }
    tx.insert(claimLeaseCutover).values({ id: 1 }).run();
    return { released: inProgress.length, alreadyDone: false };
  });
}
