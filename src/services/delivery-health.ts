// Delivery health surface (SYD-180): a human currently has to eyeball the raw
// event stream and count redeliver clicks to tell whether a night was bad.
// This aggregates the same delivery_attempts ledger the worker/UI already
// write (SYD-208) into three numbers over a rolling window: first-attempt
// success rate, how many issues needed a manual redeliver, and which ones
// needed it most.

import { sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { SwitchyardError } from "./errors.js";

export const DEFAULT_WINDOW_HOURS = 24;
export const MAX_TOP_ISSUES = 10;

export type DeliveryHealth = {
  windowHours: number;
  since: number;
  firstAttempt: { total: number; succeeded: number; rate: number | null };
  redeliverRequiredCount: number;
  topByRedeliverCount: { ref: string; redeliverCount: number }[];
};

type FirstAttemptRow = { outcome: string | null };
type RedeliverRow = { ref: string; count: number };

/**
 * `firstAttempt` counts one row per authorization (the min-id delivery_attempts
 * row per authorization_id) so an automatic deploy-only retry (SYD-209, same
 * authorizationId) never counts as a second "first attempt" — only finished
 * attempts started within the window are counted, in-flight ones are excluded
 * since they have no outcome yet.
 *
 * `topByRedeliverCount` counts distinct redeliver_requested authorizations per
 * issue (not delivery_attempts rows), so an issue whose redeliver itself needed
 * a deploy retry isn't double-counted as two redelivers.
 */
export function getDeliveryHealth(
  db: Db,
  windowHours: number = DEFAULT_WINDOW_HOURS,
): DeliveryHealth {
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    throw new SwitchyardError("hours must be a positive number.");
  }
  const since = Math.floor(Date.now() / 1000) - Math.floor(windowHours * 3600);

  const firstAttempts = db.all<FirstAttemptRow>(sql`
    SELECT da.outcome AS outcome
    FROM delivery_attempts da
    WHERE da.finished_at IS NOT NULL
      AND da.started_at >= ${since}
      AND da.id = (SELECT MIN(id) FROM delivery_attempts d2 WHERE d2.authorization_id = da.authorization_id)
  `);
  const total = firstAttempts.length;
  const succeeded = firstAttempts.filter((r) => r.outcome === "merged_deployed").length;

  const redelivers = db.all<RedeliverRow>(sql`
    SELECT da.issue_ref AS ref, COUNT(DISTINCT da.authorization_id) AS count
    FROM delivery_attempts da
    JOIN events e ON e.id = da.authorization_id
    WHERE e.type = 'redeliver_requested'
      AND da.started_at >= ${since}
    GROUP BY da.issue_ref
    ORDER BY count DESC, da.issue_ref ASC
  `);

  return {
    windowHours,
    since,
    firstAttempt: { total, succeeded, rate: total > 0 ? succeeded / total : null },
    redeliverRequiredCount: redelivers.length,
    topByRedeliverCount: redelivers
      .slice(0, MAX_TOP_ISSUES)
      .map((r) => ({ ref: r.ref, redeliverCount: r.count })),
  };
}
