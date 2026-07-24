import { and, eq, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../db/index.js";
import { pendingActions, sessions, type PendingActionStatus } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { issueRefById, updateIssue, type IssueView } from "./issues.js";
import { getSetting } from "./settings.js";

// Defined in settings.ts (next to the validator that enforces it) to keep this
// module's import edge one-way; re-exported here because hard-gate is where
// callers reason about the gate.
export { EXECUTABLE_GATE_ACTIONS } from "./settings.js";

export type PendingActionRow = typeof pendingActions.$inferSelect;

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Whether `actionType` needs a fresh human affirmation before it executes in a
 * supervised session. This is what claws back the human-gated guards that full
 * absorption would otherwise pass silently — most importantly the one that
 * stops agents stamping `done`. Configurable; empty = full absorption.
 */
export function isHardGated(db: DbOrTx, actionType: string): boolean {
  return getSetting(db, "supervised.hard_gate_actions").includes(actionType);
}

/**
 * Parks a gated action for the bound human to affirm, returning its id.
 *
 * Atomic upsert on the `pending_actions_active_uniq` partial index: a repeated
 * proposal for the same (session, issue, action) returns the existing row
 * rather than piling up duplicates, and REFRESHES its payload — so a proposal
 * whose execution failed on a stale SHA becomes affirmable again once the agent
 * re-proposes with the current one. `targetWhere` must match the index
 * predicate exactly, or SQLite won't resolve the conflict target.
 */
export function findOrCreatePendingAction(
  db: DbOrTx,
  sessionId: number,
  issueId: number,
  actionType: string,
  payload: Record<string, unknown>,
): number {
  const row = db
    .insert(pendingActions)
    .values({ sessionId, issueId, actionType, payload, status: "pending" })
    .onConflictDoUpdate({
      target: [pendingActions.sessionId, pendingActions.issueId, pendingActions.actionType],
      targetWhere: sql`status = 'pending'`,
      set: { payload },
    })
    .returning({ id: pendingActions.id })
    .get();
  return row.id;
}

export function getPendingAction(db: DbOrTx, id: number): PendingActionRow | null {
  return db.select().from(pendingActions).where(eq(pendingActions.id, id)).get() ?? null;
}

export function listPendingActions(
  db: DbOrTx,
  status: PendingActionStatus = "pending",
): PendingActionRow[] {
  return db.select().from(pendingActions).where(eq(pendingActions.status, status)).all();
}

/**
 * Executes a parked action on the bound human's fresh affirmation — the human
 * presence the gate exists to demand.
 *
 * Three things hold the guarantee together:
 * - Owner tie: only the session's accountable human can release it. Any other
 *   human affirming would launder the agent's proposal through a bystander.
 * - Claim-then-execute inside one transaction: the conditional UPDATE claims
 *   the row (0 rows changed => someone else already did, throw), and an
 *   execution failure rolls the claim back so the row stays pending and
 *   re-affirmable instead of being consumed by a failed attempt.
 * - Executor guard: an action with no executor throws rather than marking
 *   itself affirmed while doing nothing.
 */
export function affirmPendingAction(db: Db, human: Actor, id: number): IssueView {
  if (human.type !== "human") {
    throw new SwitchyardError(
      "Only a human can affirm a gated action — that affirmation is the whole point of the gate.",
    );
  }
  return db.transaction((tx) => {
    // Read inside the transaction so the payload we execute is the one the
    // claim below locks — a concurrent re-proposal refreshing it can't slip
    // between the two.
    const row = getPendingAction(tx, id);
    if (!row) {
      throw new SwitchyardError(`There is no pending action ${id}.`);
    }
    const session = tx.select().from(sessions).where(eq(sessions.id, row.sessionId)).get();
    if (!session || session.actorId !== human.id) {
      throw new SwitchyardError(
        `Pending action ${id} belongs to another supervised session — only the accountable human of that session can affirm it.`,
      );
    }
    if (session.closedAt !== null || session.expiresAt < nowSec()) {
      throw new SwitchyardError(
        `Pending action ${id}'s session has been closed or expired — its proposals are revoked. Re-propose from a live session to affirm.`,
      );
    }
    if (row.actionType !== "done") {
      throw new SwitchyardError(
        `Pending action ${id} is "${row.actionType}", which has no executor — only "done" can be affirmed.`,
      );
    }
    const claimed = tx
      .update(pendingActions)
      .set({ status: "affirmed", affirmedById: human.id, affirmedAt: nowSec() })
      .where(and(eq(pendingActions.id, id), eq(pendingActions.status, "pending")))
      .run();
    if (claimed.changes === 0) {
      throw new SwitchyardError(`Pending action ${id} is no longer pending.`);
    }
    const ref = issueRefById(tx, row.issueId);
    if (!ref) {
      throw new SwitchyardError(`Pending action ${id} points at an issue that no longer exists.`);
    }
    const expectedHeadSha = row.payload.expectedHeadSha;
    // Executed as the human with NO attribution: an empty `attr` leaves
    // sessionId undefined, which both keeps supervised provenance off an event
    // the human authored directly and stops the divert re-gating this update.
    return updateIssue(
      tx,
      human,
      ref,
      {
        status: "done",
        ...(typeof expectedHeadSha === "string" ? { expectedHeadSha } : {}),
      },
      {},
      {},
    );
  });
}

/**
 * Sweep: for every pending action whose status is 'pending', expires it if its
 * own TTL has elapsed (independent per-action expiry), OR if its associated
 * supervised session has been closed or expired.
 * Returns the number of pending actions expired.
 */
export function expirePendingActions(db: Db, now: number = nowSec()): number {
  const ttl = getSetting(db, "supervised.pending_action_ttl_seconds");
  const cutoff = now - ttl;

  // Select all pending actions that are currently "pending"
  const pendingList = db
    .select({
      id: pendingActions.id,
      createdAt: pendingActions.createdAt,
      sessionId: pendingActions.sessionId,
    })
    .from(pendingActions)
    .where(eq(pendingActions.status, "pending"))
    .all();

  let expiredCount = 0;
  for (const pa of pendingList) {
    let shouldExpire = pa.createdAt <= cutoff;

    if (!shouldExpire) {
      const session = db
        .select({ closedAt: sessions.closedAt, expiresAt: sessions.expiresAt })
        .from(sessions)
        .where(eq(sessions.id, pa.sessionId))
        .get();
      if (session) {
        if (session.closedAt !== null || session.expiresAt < now) {
          shouldExpire = true;
        }
      } else {
        shouldExpire = true;
      }
    }

    if (shouldExpire) {
      const result = db
        .update(pendingActions)
        .set({ status: "expired" })
        .where(and(eq(pendingActions.id, pa.id), eq(pendingActions.status, "pending")))
        .run();
      if (result.changes > 0) {
        expiredCount++;
      }
    }
  }

  return expiredCount;
}
