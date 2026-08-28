import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { events, issues, sessions, supervisedClaimCutover } from "../db/schema.js";
import { recordEvent } from "./events.js";
import { invalidateLease } from "./leases.js";

/**
 * One-time SYD-281 cutover. The identity rule makes the acting AGENT the holder
 * of a supervised claim — assignee and lease. Claims made before this deploy
 * hold the accountable HUMAN in both places, which the new predicates cannot
 * recognise:
 *
 *   - `isHolderMutation` compares the assignee against the acting agent, so a
 *     human-assigned row is never a holder mutation and `validateLease` is
 *     SKIPPED entirely — SYD-210's shared-token hole, silently reopened.
 *   - `assertClaimable` then refuses the agent with "already claimed by <human>"
 *     forever, and clearing an assignee is human-only. The issue is stuck.
 *
 * So the lease cannot merely be expired: expiry leaves `assigneeId` set, which
 * is the half that does the damage. Release the ASSIGNMENT, following
 * `ensureClaimLeaseCutover` (lease-cutover.ts) — status→todo, assigneeId→null,
 * a `claim_released` event — and invalidate the lease in the SAME transaction,
 * which that precedent does NOT do. Skip it and the stale human-keyed row stays
 * active: the agent's re-claim mints a second one, `getActiveLease` (no ORDER BY)
 * returns whichever SQLite yields first, and the agent holds a token it can
 * never use.
 *
 * ## Selection
 *
 * `claim_leases` has no session column and an `issues.assigneeId` pointing at a
 * human is byte-identical whether the claim came from a supervised session or
 * from a person claiming at their desk. The ONLY link is `events.sessionId`
 * (written by recordEvent), so this walks the `assigned` events rather than the
 * issues table. That is event archaeology, and it is the price of not releasing
 * claims people made in person.
 *
 * ## Also: open sessions
 *
 * `sessions.viaAgentId` is fixed at mint and the TTL is 12h, so a session opened
 * against a bare `claude/dev` before this deploy keeps that binding — which is
 * exactly the `assertClaimable` collapse the namespacing exists to prevent, live
 * for the rest of its TTL. Soft-close them all so they re-mint under the new
 * naming. Never DELETE: `sessions.id` is an FK target for `events.sessionId`.
 *
 * ## Operator note
 *
 * `ensureClaimLeaseCutover` rests its low-blast-radius argument on the worker
 * LaunchAgents being DOWN at cutover. A routine `npm run deploy` restarts only
 * the NAS tracker while the workers keep polling, and a released issue lands at
 * `todo`/unassigned — exactly what `selectDispatchable` wants. Stop the workers
 * for this deploy, or run it through the SYD-291 operator path.
 */
export function ensureSupervisedClaimCutover(db: Db): {
  released: number;
  sessionsClosed: number;
  alreadyDone: boolean;
} {
  return db.transaction((tx) => {
    const marker = tx.select().from(supervisedClaimCutover).get();
    if (marker) return { released: 0, sessionsClosed: 0, alreadyDone: true };

    // Issues still in_progress whose CURRENT assignment was made inside a
    // supervised session. `ORDER BY id DESC LIMIT 1` per issue: an issue
    // reassigned in person after a supervised claim is not ours to touch.
    const rows = tx.all<{ issue_id: number; actor_id: number }>(sql`
      SELECT i.id AS issue_id, e.actor_id AS actor_id
      FROM issues i
      JOIN events e ON e.id = (
        SELECT id FROM events
        WHERE issue_id = i.id AND type = 'assigned'
        ORDER BY id DESC LIMIT 1
      )
      WHERE i.status = 'in_progress'
        AND i.assignee_id IS NOT NULL
        AND e.session_id IS NOT NULL
    `);

    for (const row of rows) {
      // Order matters only for legibility; both are in this transaction.
      invalidateLease(tx, row.issue_id);
      tx.update(issues)
        .set({ status: "todo", assigneeId: null, updatedAt: sql`(unixepoch())` })
        .where(eq(issues.id, row.issue_id))
        .run();
      recordEvent(tx, {
        issueId: row.issue_id,
        actorId: row.actor_id,
        type: "claim_released",
        payload: { reason: "supervised_claim_cutover" },
      });
    }

    const open = tx
      .select()
      .from(sessions)
      .where(and(eq(sessions.kind, "supervised"), isNull(sessions.closedAt)))
      .all();
    if (open.length > 0) {
      tx.update(sessions)
        .set({ closedAt: sql`(unixepoch())` })
        .where(and(eq(sessions.kind, "supervised"), isNull(sessions.closedAt)))
        .run();
    }

    tx.insert(supervisedClaimCutover).values({ id: 1 }).run();
    return { released: rows.length, sessionsClosed: open.length, alreadyDone: false };
  });
}
