import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { issues } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { getIssue, toView, type IssueView } from "./issues.js";
import { recordEvent } from "./events.js";
import { getAttention } from "./attention.js";
import { deliveryPinFor } from "./pr-status.js";

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
 * gives retry a real trigger: a `redeliver_requested` event that deliver.ts
 * subscribes to alongside its usual done-stamp scan. Fired for an unresolved
 * delivery_failed attention flag, or (SYD-230) to re-stamp an already-done
 * issue whose open agent PR never delivered. Human-only, like the rest of this
 * file — agents still can't drive the delivery gate.
 *
 * SYD-208: retrying re-authorizes delivery of whatever PR pr_state currently
 * attributes to this issue, so it is the same compare-and-set as the
 * done-stamp pin — expectedHeadSha must match deliveryPinFor's current head.
 * This is the post-disarm old->new delta surface: a reflexive Retry click
 * after a sha_chain_disarmed can't silently re-pin the refused push, because
 * the client's displayed SHA no longer matches.
 */
export function redeliverIssue(
  db: Db,
  actor: Actor,
  ref: string,
  expectedHeadSha?: string,
): IssueView {
  requireHuman(actor, "retry a delivery");
  const current = getIssue(db, ref);
  const attention = getAttention(db, current.id);
  const pin = deliveryPinFor(db, current.id);
  // SYD-230: two doors in, both re-authorizing the SAME pin under the SAME
  // head-SHA compare-and-set below. (1) An unresolved delivery_failed to
  // retry. (2) Re-stamp: an already-done issue whose open agent PR never got
  // delivered — the pin-less-done case (pr_state was blind to the PR at
  // stamp-time, so the done-stamp carried no pin), recoverable without the
  // done→in_review→done round-trip. Agents are still refused by requireHuman.
  const failed = attention?.reason === "delivery_failed";
  const restampable = current.status === "done" && pin?.status === "open";
  if (!failed && !restampable) {
    throw new SwitchyardError(
      `${ref} has no unresolved delivery failure to retry, and no open agent PR on a done issue to re-stamp.`,
    );
  }
  if (!pin) {
    throw new SwitchyardError(`${ref} has no agent PR on record — nothing to redeliver.`);
  }
  if (pin.headSha === null) {
    throw new SwitchyardError(
      `${ref}'s PR #${pin.prNumber} has no recorded head SHA yet — wait for the poller/webhook to record one, then retry.`,
    );
  }
  if (expectedHeadSha === undefined) {
    throw new SwitchyardError(
      `Retrying ${ref} re-authorizes delivery of PR #${pin.prNumber} — pass expectedHeadSha (the head SHA you reviewed) to confirm. Current head: ${pin.headSha}.`,
    );
  }
  if (expectedHeadSha !== pin.headSha) {
    throw new SwitchyardError(
      `${ref}'s PR #${pin.prNumber} head moved since you looked: you saw ${expectedHeadSha}, but the head is now ${pin.headSha} — review the new commits before re-authorizing.`,
    );
  }
  recordEvent(db, {
    issueId: current.id,
    actorId: actor.id,
    type: "redeliver_requested",
    payload: { pin: { repo: pin.repo, prNumber: pin.prNumber, headSha: pin.headSha } },
  });
  return getIssue(db, ref);
}

/**
 * Explicitly clears a stuck delivery_failed flag (SYD-178). Retry only helps
 * when pr_state has an attributed PR to re-authorize (a strict agent/<ref>
 * branch, SYD-206) — a fix that lands through any other path (an interactive
 * feat/<ref> branch, a manual merge on GitHub) never gets one, so the
 * delivery worker never sees anything to redeliver and the banner is a dead
 * end forever. This gives a human an explicit escape hatch: attest the issue
 * is actually resolved, without pretending a `delivered` event (which implies
 * deliver.ts's merge+deploy actually ran) fired. A note is required — this
 * silences a "needs my action" signal, so it gets the same provenance bar as
 * everything else here. Human-only, like the rest of this file — agents
 * still can't clear their own failures.
 */
/**
 * Deviation reasons a human may clear by hand (SYD-262).
 *
 * Only `done_without_merged_pr` qualifies today, and the reason is structural:
 * it is recorded ONCE at the done transition (SYD-204) and then cleared only by
 * a merged `pr_state` row — which strict agent/<ref> attribution (SYD-206) never
 * produces for the `feat/<topic>` branches CLAUDE.md prescribes for interactive
 * work. So it is a dead end by construction, exactly as delivery_failed was
 * before SYD-178.
 *
 * The other reasons (open_pr_not_in_review, merged_pr_not_done, stale_claim) are
 * recomputed live from current state by getDeviation, so they clear themselves
 * the moment the drift they describe stops being true — a manual override there
 * would be a lie that re-raises on the next read. Keep this list to
 * recorded-once deviations.
 */
export const RESOLVABLE_DEVIATIONS = ["done_without_merged_pr"] as const;
export type ResolvableDeviation = (typeof RESOLVABLE_DEVIATIONS)[number];

/**
 * Clears a stuck recorded-once process deviation. Generic over the reason so a
 * future recorded-once deviation gets the escape hatch for free (Sean's call,
 * 2026-07-24) — the reason rides the payload and attention.ts matches on it, so
 * clearing one signal can never silence another on the same issue.
 *
 * Retroactive by construction: the resolve is compared against the deviation's
 * event id, so an issue flagged days ago (SYD-236 has been stuck since
 * 2026-07-14) clears exactly like a fresh one. A later deviation still re-raises.
 *
 * Human-only with a required note, same provenance bar as resolveDeliveryFailure
 * — this silences a "needs my action" signal, so someone has to own having
 * checked.
 */
export function resolveDeviation(
  db: Db,
  actor: Actor,
  ref: string,
  reason: string,
  note: string,
): IssueView {
  requireHuman(actor, "resolve a process deviation");
  if (!(RESOLVABLE_DEVIATIONS as readonly string[]).includes(reason)) {
    throw new SwitchyardError(
      `"${reason}" cannot be resolved by hand — it is recomputed from current state and clears itself once the drift stops. Resolvable reasons: ${RESOLVABLE_DEVIATIONS.join(", ")}.`,
    );
  }
  if (!note.trim()) {
    throw new SwitchyardError(
      "A note is required — say how you confirmed the work actually landed.",
    );
  }
  const current = getIssue(db, ref);
  const attention = getAttention(db, current.id);
  if (attention?.reason !== reason) {
    throw new SwitchyardError(`${ref} has no unresolved ${reason} deviation to resolve.`);
  }
  recordEvent(db, {
    issueId: current.id,
    actorId: actor.id,
    type: "deviation_resolved",
    payload: { reason, note: note.trim() },
  });
  return getIssue(db, ref);
}

export function resolveDeliveryFailure(db: Db, actor: Actor, ref: string, note: string): IssueView {
  requireHuman(actor, "resolve a delivery failure");
  if (!note.trim()) {
    throw new SwitchyardError(
      "A note is required — say how you confirmed the delivery actually succeeded.",
    );
  }
  const current = getIssue(db, ref);
  const attention = getAttention(db, current.id);
  if (attention?.reason !== "delivery_failed") {
    throw new SwitchyardError(`${ref} has no unresolved delivery failure to resolve.`);
  }
  recordEvent(db, {
    issueId: current.id,
    actorId: actor.id,
    type: "delivery_resolved",
    payload: { note: note.trim() },
  });
  return getIssue(db, ref);
}
