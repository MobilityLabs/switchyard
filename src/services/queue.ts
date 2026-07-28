// The manual working order (SYD-294, parent SYD-293).
//
// Before this, the board's only ordering signals were `priority` — a
// four-value enum — and `createdAt`. So among unblocked issues of equal
// priority, nextTask handed out the OLDEST first, which favours whatever has
// been rotting longest over whatever unblocks the most work. A defensible
// order had to be written into a doc (docs/2026-07-28-board-working-order.md)
// because the product could not hold one, and an order living in a doc is an
// order nothing enforces.
//
// **Deliberately a short list, not a total order.** Only issues someone
// explicitly placed carry a `queue_rank`; everything else stays NULL and falls
// back to the previous ordering untouched. Maintaining a total order over 300+
// issues is work nobody would do, and the thing actually being modelled —
// "work these next" — is a handful.
//
// Ranks are sparse (100, 200, 300...) purely so a hand-read of the column is
// legible. They carry no meaning: setQueuePosition renumbers the whole ranked
// set on every move, which is one cheap UPDATE per ranked issue at this scale
// and sidesteps lexorank's midpoint-exhaustion and rebalancing entirely.
// Revisit only if the ranked set grows large enough for that to hurt.
//
// Ordering the board is NOT a human-only act. `priority` — the signal this
// refines — has never been human-gated (updateIssue records priority_changed
// for any actor), so gating rank would be inconsistent, and it would block an
// agent from recording the order a review just produced. The move is recorded
// as an event either way, so who reordered what is always answerable.

import { asc, eq, isNotNull, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../db/index.js";
import { issues } from "../db/schema.js";
import type { Actor } from "./actors.js";
import type { Attribution } from "./attribution.js";
import { SwitchyardError } from "./errors.js";
import { getIssue, toView, type IssueView } from "./issues.js";
import { recordEvent } from "./events.js";

/** Gap between adjacent ranks. Cosmetic — see the module comment. */
const RANK_STEP = 100;

/** The curated queue, front first. Ties on rank (which renumbering makes
 * impossible, but a hand-edited database could produce) break by id so the
 * order is always total and stable. */
export function listQueue(db: DbOrTx): IssueView[] {
  return db
    .select()
    .from(issues)
    .where(isNotNull(issues.queueRank))
    .orderBy(asc(issues.queueRank), asc(issues.id))
    .all()
    .map((row) => toView(db, row));
}

export type QueuePositionInput = {
  /** 1-based position in the queue. Beyond the end appends; `null` removes the
   * issue from the queue entirely (back to priority ordering). */
  position: number | null;
};

/**
 * Place an issue in the manual queue, move it, or remove it — returning the
 * queue as it stands afterwards.
 *
 * One primitive rather than separate add/move/remove calls: every drag in the
 * UI (SYD-295) is "this issue now sits at position N", and a removal is the
 * same statement with no position. Renumbering the whole set on each call
 * means the result never depends on what the ranks were before, so a client
 * that has a stale view cannot corrupt the order — it can only lose a race,
 * last-write-wins, which at one human plus one agent is the right trade.
 */
export function setQueuePosition(
  db: Db,
  actor: Actor,
  ref: string,
  input: QueuePositionInput,
  attr: Attribution = {},
): IssueView[] {
  const { position } = input;
  if (position !== null && (!Number.isInteger(position) || position < 1)) {
    throw new SwitchyardError(
      `"${position}" is not a queue position — use a whole number from 1, or null to remove the issue from the queue.`,
    );
  }
  return db.transaction((tx) => {
    const issue = getIssue(tx, ref);
    const from = issue.queueRank;

    // Rebuild the intended order, then write it. The issue is dropped first so
    // a move within the queue is the same code path as an insert into it.
    const ordered = listQueue(tx).filter((i) => i.id !== issue.id);
    if (position !== null) {
      ordered.splice(Math.min(position - 1, ordered.length), 0, issue);
    }

    tx.update(issues).set({ queueRank: null }).where(eq(issues.id, issue.id)).run();
    ordered.forEach((item, index) => {
      tx.update(issues)
        .set({ queueRank: (index + 1) * RANK_STEP })
        .where(eq(issues.id, item.id))
        .run();
    });

    const to = position === null ? null : ordered.findIndex((i) => i.id === issue.id) + 1;
    recordEvent(tx, {
      issueId: issue.id,
      actorId: actor.id,
      type: "queue_position_changed",
      // Positions, not raw ranks: the ranks are an implementation detail that
      // renumbering churns on every move, so they would make a useless audit.
      payload: { from: from === null ? null : from / RANK_STEP, to },
      viaAgentId: attr.viaAgentId,
      sessionId: attr.sessionId,
    });
    return listQueue(tx);
  });
}

/**
 * Sort key placing issues the caller's own classification prefers ahead of
 * unclaimed ones, and issues preferred by some OTHER worker last.
 *
 * Soft by design (SYD-201: worker_preference "never restricts — an idle worker
 * still falls back to it"), so this only ever reorders; the one hard rule
 * lives in nextTask, where a non-human is refused `interactive` issues
 * outright. Because ranks are a total order, this can only break ties among
 * UNRANKED issues — an explicit human ordering outranks affinity, which is the
 * point of having one.
 */
export function affinityRank(classification: string) {
  return sql`CASE
    WHEN ${issues.workerPreference} IS NULL THEN 1
    WHEN ${issues.workerPreference} = ${classification} THEN 0
    ELSE 2 END`;
}

/** NULL ranks sort last, spelled portably rather than relying on NULLS LAST. */
export const QUEUE_RANK_ORDER = sql`CASE WHEN ${issues.queueRank} IS NULL THEN 1 ELSE 0 END, ${issues.queueRank}`;
