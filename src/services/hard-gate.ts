import { and, eq, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../db/index.js";
import { pendingActions, sessions, type PendingActionStatus } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { removeDependency } from "./dependencies.js";
import { SwitchyardError } from "./errors.js";
import { getIssue, issueRefById, updateIssue, type IssueView } from "./issues.js";
import { EXECUTABLE_GATE_ACTIONS, getSetting } from "./settings.js";

// Defined in settings.ts (next to the validator that enforces it) to keep this
// module's import edge one-way; re-exported here because hard-gate is where
// callers reason about the gate.
export { EXECUTABLE_GATE_ACTIONS };

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
    // "dependency.remove" rows carry a ":<blockerRef>" suffix (see the divert
    // in removeDependency) to dedup per-blocker instead of per-issue — split
    // it back off to route on the base kind.
    const actionKind = row.actionType.split(":")[0];
    if (!EXECUTABLE_GATE_ACTIONS.includes(actionKind)) {
      throw new SwitchyardError(
        `Pending action ${id} is "${row.actionType}", which has no executor — only ${EXECUTABLE_GATE_ACTIONS.join(", ")} can be affirmed.`,
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
    if (actionKind === "dependency.remove") {
      const blockerRef = row.payload.blockerRef;
      const blockedRef = row.payload.blockedRef;
      if (typeof blockerRef !== "string" || typeof blockedRef !== "string") {
        throw new SwitchyardError(
          `Pending action ${id}'s payload is missing blocker/blocked refs — cannot execute.`,
        );
      }
      // Executed as the human with NO attribution, same reasoning as the done
      // path below: an empty attr keeps supervised provenance off an event the
      // human authored directly and stops the divert re-gating this removal.
      removeDependency(tx, human, blockerRef, blockedRef, {});
      return getIssue(tx, ref);
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
