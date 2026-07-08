import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { issues } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { getIssue, toView, type IssueView } from "./issues.js";
import { recordEvent } from "./events.js";

function requireHuman(actor: Actor, action: string): void {
  if (actor.type !== "human") {
    throw new SwitchyardError(`Only humans can ${action} — agents should ask a human to do this.`);
  }
}

/**
 * Snoozes an issue until a future unix timestamp. Human-only.
 */
export function snoozeIssue(db: Db, actor: Actor, ref: string, untilUnixSeconds: number): IssueView {
  requireHuman(actor, "snooze an issue");
  const now = Math.floor(Date.now() / 1000);
  if (untilUnixSeconds <= now) {
    throw new SwitchyardError(
      `Snooze time must be in the future — got ${untilUnixSeconds}, now is ${now}.`
    );
  }
  return db.transaction((tx) => {
    const current = getIssue(tx as Db, ref);
    const row = tx
      .update(issues)
      .set({ snoozedUntil: untilUnixSeconds, updatedAt: now })
      .where(eq(issues.id, current.id))
      .returning()
      .get();
    recordEvent(tx as Db, {
      issueId: current.id, actorId: actor.id,
      type: "snoozed", payload: { until: untilUnixSeconds },
    });
    return toView(tx as Db, row);
  });
}

/**
 * Marks an issue as a duplicate of another and cancels it. Human-only.
 */
export function markDuplicate(db: Db, actor: Actor, ref: string, ofRef: string): IssueView {
  requireHuman(actor, "mark an issue as a duplicate");
  return db.transaction((tx) => {
    const current = getIssue(tx as Db, ref);
    const of = getIssue(tx as Db, ofRef);
    if (current.id === of.id) {
      throw new SwitchyardError(`An issue cannot be marked as a duplicate of itself (${ref}).`);
    }
    const now = Math.floor(Date.now() / 1000);
    const row = tx
      .update(issues)
      .set({ status: "canceled", updatedAt: now })
      .where(eq(issues.id, current.id))
      .returning()
      .get();
    if (current.status !== "canceled") {
      recordEvent(tx as Db, {
        issueId: current.id, actorId: actor.id,
        type: "status_changed", payload: { from: current.status, to: "canceled" },
      });
    }
    recordEvent(tx as Db, {
      issueId: current.id, actorId: actor.id,
      type: "marked_duplicate", payload: { of: of.ref },
    });
    return toView(tx as Db, row);
  });
}
