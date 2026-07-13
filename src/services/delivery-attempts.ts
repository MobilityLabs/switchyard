// Delivery ledger (SYD-208, spec: docs/2026-07-12-sync-simplification-
// assessment.md delivery-attempts section). One `delivery_attempts` row per
// attempted delivery, keyed off an "authorization" event so a human trigger
// (a done-stamp or an explicit redeliver_requested) is consumed exactly
// once — the no-spin rule enforced by startDeliveryAttempt.
//
// Latest-stamp-per-issue rule: of every status_changed->done event on an
// issue, only the newest one is a live authorization. An older stamp that
// was retracted (done -> something else) and later re-stamped stays
// disarmed on purpose — the human's retract explicitly withdrew that
// trigger, so only the fresh stamp authorizes a new attempt. A
// redeliver_requested event is always its own authorization, independent of
// the done-stamp history.
//
// Parity-by-construction: ensureRolloutBackfill (the one-time SYD-208
// cutover backfill) calls the exact same listPendingDeliveryAuthorizations
// the live trigger consumes, so whatever the backfill doesn't see at
// go-live time the live trigger will never see either — there is no second
// predicate to drift out of sync with the first.

import { eq, desc, isNull, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../db/index.js";
import {
  deliveryAttempts,
  deliveryRollout,
  events,
  type DeliveryOutcome,
} from "../db/schema.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { getIssue } from "./issues.js";

export type DeliveryPinPayload = { repo: string; prNumber: number; headSha: string | null };

export type PendingAuthorization = {
  authorizationId: number;
  ref: string;
  kind: "done_stamp" | "redeliver";
  pin: DeliveryPinPayload | null;
};

export type DeliveryAttemptRow = typeof deliveryAttempts.$inferSelect;

export type DeployRetry = {
  authorizationId: number;
  ref: string;
  prNumber: number | null;
  headSha: string | null;
  /** 1-based: the first automatic retry after the original attempt is retry 1. */
  retryNumber: number;
};

type PendingRow = {
  authorizationId: number;
  ref: string;
  kind: "done_stamp" | "redeliver";
  pinRepo: string | null;
  pinPrNumber: number | null;
  pinHeadSha: string | null;
};

/**
 * Issues currently `done` with a live authorization event (see file header)
 * that has no delivery_attempts row yet. This is THE trigger predicate — the
 * live delivery worker and the one-time rollout backfill both call it, so
 * they can never see a different set of "what's owed a delivery attempt".
 */
export function listPendingDeliveryAuthorizations(db: DbOrTx): PendingAuthorization[] {
  const rows = db.all<PendingRow>(sql`
    SELECT e.id AS authorizationId,
           p.key || '-' || i.number AS ref,
           CASE e.type WHEN 'redeliver_requested' THEN 'redeliver' ELSE 'done_stamp' END AS kind,
           json_extract(e.payload, '$.pin.repo') AS pinRepo,
           json_extract(e.payload, '$.pin.prNumber') AS pinPrNumber,
           json_extract(e.payload, '$.pin.headSha') AS pinHeadSha
    FROM events e
    JOIN issues i ON i.id = e.issue_id
    JOIN projects p ON p.id = i.project_id
    WHERE i.status = 'done'
      AND (
        e.type = 'redeliver_requested'
        OR (
          e.type = 'status_changed'
          AND json_extract(e.payload, '$.to') = 'done'
          AND e.id = (
            SELECT MAX(e2.id) FROM events e2
            WHERE e2.issue_id = e.issue_id
              AND e2.type = 'status_changed'
              AND json_extract(e2.payload, '$.to') = 'done'
          )
        )
      )
      AND NOT EXISTS (SELECT 1 FROM delivery_attempts da WHERE da.authorization_id = e.id)
    ORDER BY e.id ASC
  `);
  return rows.map((r) => ({
    authorizationId: r.authorizationId,
    ref: r.ref,
    kind: r.kind,
    pin:
      r.pinRepo !== null
        ? { repo: r.pinRepo, prNumber: r.pinPrNumber as number, headSha: r.pinHeadSha }
        : null,
  }));
}

/**
 * Opens a delivery attempt against an authorization event. Refuses agent
 * actors for the same reason recordDeliveryEvent does (SYD-108): a delivery
 * attempt is infrastructure state, not something a dispatched agent should
 * be able to trigger or fake for itself.
 */
export function startDeliveryAttempt(
  db: Db,
  actor: Actor,
  ref: string,
  input: { authorizationId: number; prNumber?: number; headSha?: string; deployRetry?: boolean },
): DeliveryAttemptRow {
  if (actor.type === "agent") {
    throw new SwitchyardError(
      "Only the delivery infrastructure (a human-typed token) may start a delivery attempt — agents cannot self-authorize their own delivery.",
    );
  }
  return db.transaction((tx): DeliveryAttemptRow => {
    const issue = getIssue(tx, ref);
    const authEvent = tx
      .select({ id: events.id, issueId: events.issueId, type: events.type })
      .from(events)
      .where(eq(events.id, input.authorizationId))
      .get();
    if (
      !authEvent ||
      authEvent.issueId !== issue.id ||
      (authEvent.type !== "redeliver_requested" && authEvent.type !== "status_changed")
    ) {
      throw new SwitchyardError(
        `Authorization event ${input.authorizationId} does not authorize a delivery attempt on ${ref}.`,
      );
    }
    const priorAttempts = tx
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.authorizationId, input.authorizationId))
      .orderBy(desc(deliveryAttempts.id))
      .all();
    if (!input.deployRetry) {
      if (priorAttempts.length > 0) {
        throw new SwitchyardError(
          `${ref} already has a delivery attempt — once per human trigger; re-stamp or click Retry to re-authorize.`,
        );
      }
    } else {
      const latest = priorAttempts[0];
      if (!latest || latest.outcome !== "merged_deploy_failed") {
        throw new SwitchyardError(
          `${ref} has no merged_deploy_failed attempt on authorization ${input.authorizationId} to retry.`,
        );
      }
    }
    return tx
      .insert(deliveryAttempts)
      .values({
        issueRef: issue.ref,
        prNumber: input.prNumber ?? null,
        headSha: input.headSha ?? null,
        authorizationId: input.authorizationId,
      })
      .returning()
      .get();
  });
}

/**
 * Records the outcome of an open delivery attempt. Human-token gate, same
 * rationale as startDeliveryAttempt. `skipped_rollout` is reserved for the
 * one-time rollout backfill — refused here so a real attempt can never be
 * mistaken for a pre-cutover no-op.
 */
export function finishDeliveryAttempt(
  db: Db,
  actor: Actor,
  attemptId: number,
  input: { outcome: DeliveryOutcome; derivedHeadSha?: string },
): DeliveryAttemptRow {
  if (actor.type === "agent") {
    throw new SwitchyardError(
      "Only the delivery infrastructure (a human-typed token) may finish a delivery attempt — agents cannot post delivery outcomes.",
    );
  }
  if (input.outcome === "skipped_rollout") {
    throw new SwitchyardError("skipped_rollout is written only by the rollout backfill.");
  }
  return db.transaction((tx): DeliveryAttemptRow => {
    const existing = tx
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.id, attemptId))
      .get();
    if (!existing || existing.finishedAt !== null) {
      throw new SwitchyardError(
        `Delivery attempt ${attemptId} does not exist or has already been finished.`,
      );
    }
    return tx
      .update(deliveryAttempts)
      .set({
        outcome: input.outcome,
        derivedHeadSha: input.derivedHeadSha ?? existing.derivedHeadSha,
        finishedAt: sql`(unixepoch())`,
      })
      .where(eq(deliveryAttempts.id, attemptId))
      .returning()
      .get();
  });
}

/** Attempts still awaiting an outcome, oldest first. */
export function listUnfinishedAttempts(db: Db): DeliveryAttemptRow[] {
  return db
    .select()
    .from(deliveryAttempts)
    .where(isNull(deliveryAttempts.finishedAt))
    .orderBy(deliveryAttempts.id)
    .all();
}

export const MAX_DEPLOY_RETRIES = 3;
export const DEPLOY_RETRY_BACKOFF_SECONDS = 300;

/**
 * Pure predicate: is a deploy-only retry due for an authorization whose
 * latest attempt is number `attemptCount` (1 = the original attempt),
 * finished at `finishedAt`? Exponential backoff from DEPLOY_RETRY_BACKOFF_SECONDS,
 * capped at MAX_DEPLOY_RETRIES automatic retries.
 */
export function deployRetryDue(attemptCount: number, finishedAt: number, nowSeconds: number): boolean {
  return (
    attemptCount - 1 < MAX_DEPLOY_RETRIES &&
    nowSeconds >= finishedAt + DEPLOY_RETRY_BACKOFF_SECONDS * 2 ** (attemptCount - 1)
  );
}

type DeployRetryRow = {
  authorizationId: number;
  ref: string;
  prNumber: number | null;
  headSha: string | null;
  finishedAt: number;
  attemptCount: number;
};

/**
 * Authorizations whose latest attempt failed at the deploy step
 * (merged_deploy_failed — the merge landed, only the deploy step failed) and
 * whose backoff window has elapsed. `retryNumber` is the 1-based number of
 * the retry about to run (the original attempt is attempt 1, so the first
 * automatic retry reports retryNumber: 1).
 */
export function listDeployRetries(db: Db, nowSeconds?: number): DeployRetry[] {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const rows = db.all<DeployRetryRow>(sql`
    SELECT da.authorization_id AS authorizationId,
           da.issue_ref AS ref,
           da.pr_number AS prNumber,
           da.head_sha AS headSha,
           da.finished_at AS finishedAt,
           (SELECT COUNT(*) FROM delivery_attempts c WHERE c.authorization_id = da.authorization_id) AS attemptCount
    FROM delivery_attempts da
    WHERE da.outcome = 'merged_deploy_failed'
      AND da.id = (
        SELECT MAX(id) FROM delivery_attempts d2 WHERE d2.authorization_id = da.authorization_id
      )
  `);
  return rows
    .filter((r) => deployRetryDue(r.attemptCount, r.finishedAt, now))
    .map((r) => ({
      authorizationId: r.authorizationId,
      ref: r.ref,
      prNumber: r.prNumber,
      headSha: r.headSha,
      retryNumber: r.attemptCount,
    }));
}

/**
 * One-time SYD-208 cutover backfill: writes a `skipped_rollout` attempt for
 * every authorization that was already pending at go-live time, so the live
 * trigger starts clean instead of firing a flood of real deliveries for
 * history it never saw merge. Guarded by the `delivery_rollout` marker row —
 * once-only, even across restarts, so a later real pending authorization is
 * never swallowed by a second call.
 */
export function ensureRolloutBackfill(db: Db): { backfilled: number; alreadyDone: boolean } {
  return db.transaction((tx) => {
    const marker = tx.select().from(deliveryRollout).get();
    if (marker) return { backfilled: 0, alreadyDone: true };
    const pending = listPendingDeliveryAuthorizations(tx);
    const now = Math.floor(Date.now() / 1000);
    for (const p of pending) {
      tx.insert(deliveryAttempts)
        .values({
          issueRef: p.ref,
          prNumber: p.pin?.prNumber ?? null,
          headSha: p.pin?.headSha ?? null,
          authorizationId: p.authorizationId,
          finishedAt: now,
          outcome: "skipped_rollout",
        })
        .run();
    }
    tx.insert(deliveryRollout).values({ id: 1 }).run();
    return { backfilled: pending.length, alreadyDone: false };
  });
}
