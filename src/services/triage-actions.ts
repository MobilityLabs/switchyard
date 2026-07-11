import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { issues } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { getIssue, toView, type IssueView } from "./issues.js";
import { recordEvent } from "./events.js";
import { getAttention } from "./attention.js";

function requireHuman(actor: Actor, action: string): void {
  if (actor.type !== "human") {
    throw new SwitchyardError(`Only humans can ${action} — agents should ask a human to do this.`);
  }
}

/**
 * Snoozes an issue until a future unix timestamp. Human-only.
 */
export function snoozeIssue(
  db: Db,
  actor: Actor,
  ref: string,
  untilUnixSeconds: number,
): IssueView {
  requireHuman(actor, "snooze an issue");
  const now = Math.floor(Date.now() / 1000);
  if (untilUnixSeconds <= now) {
    throw new SwitchyardError(
      `Snooze time must be in the future — got ${untilUnixSeconds}, now is ${now}.`,
    );
  }
  return db.transaction((tx) => {
    const current = getIssue(tx, ref);
    const row = tx
      .update(issues)
      .set({ snoozedUntil: untilUnixSeconds, updatedAt: sql`(unixepoch())` })
      .where(eq(issues.id, current.id))
      .returning()
      .get();
    recordEvent(tx, {
      issueId: current.id,
      actorId: actor.id,
      type: "snoozed",
      payload: { until: untilUnixSeconds },
    });
    return toView(tx, row);
  });
}

/**
 * Marks an issue as a duplicate of another and cancels it. Human-only.
 */
export function markDuplicate(db: Db, actor: Actor, ref: string, ofRef: string): IssueView {
  requireHuman(actor, "mark an issue as a duplicate");
  return db.transaction((tx) => {
    const current = getIssue(tx, ref);
    const of = getIssue(tx, ofRef);
    if (current.id === of.id) {
      throw new SwitchyardError(`An issue cannot be marked as a duplicate of itself (${ref}).`);
    }
    const row = tx
      .update(issues)
      .set({ status: "canceled", updatedAt: sql`(unixepoch())` })
      .where(eq(issues.id, current.id))
      .returning()
      .get();
    if (current.status !== "canceled") {
      recordEvent(tx, {
        issueId: current.id,
        actorId: actor.id,
        type: "status_changed",
        payload: { from: current.status, to: "canceled" },
      });
    }
    recordEvent(tx, {
      issueId: current.id,
      actorId: actor.id,
      type: "marked_duplicate",
      payload: { of: of.ref },
    });
    return toView(tx, row);
  });
}

/**
 * Requests a retry of a stalled delivery (SYD-102). Re-stamping an
 * already-done issue done is a silent no-op — status unchanged means no
 * status_changed event, so deliver.ts's done-stamp scan never sees it. This
 * gives retry a real trigger: a `redeliver_requested` event, fired only when
 * there's an unresolved delivery_failed attention flag to retry, that
 * deliver.ts subscribes to alongside its usual done-stamp scan. Human-only,
 * like the rest of this file — agents still can't drive the delivery gate.
 */
export function redeliverIssue(db: Db, actor: Actor, ref: string): IssueView {
  requireHuman(actor, "retry a delivery");
  const current = getIssue(db, ref);
  const attention = getAttention(db, current.id);
  if (attention?.reason !== "delivery_failed") {
    throw new SwitchyardError(`${ref} has no unresolved delivery failure to retry.`);
  }
  recordEvent(db, {
    issueId: current.id,
    actorId: actor.id,
    type: "redeliver_requested",
    payload: {},
  });
  return getIssue(db, ref);
}
