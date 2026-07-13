// Attention flag (SYD-84): a red error signal for issues that need a human
// to look. It aggregates two sources, in priority order: an unresolved
// delivery_failed (SYD-54's structured delivery events — the latest one on an
// issue counts only if nothing later resolved it) and, if none, a process
// deviation (SYD-188) from ./deviation.js.
//
// What resolves a failure (SYD-207): a later `delivered` event (the
// delivery-attempt vocabulary stays event-written by the delivery worker), or
// the issue's PR reaching `merged` in pr_state with a co-written transition
// event newer than the failure — which is how a manual merge observed by the
// webhook/poller clears the flag, replacing the deleted SYD-94 reconcile
// pass. Raw gh_pr_merged events are audit history and no longer consulted.
import { sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { getDeviation, listDeviationByIssueId, type DeviationFlag } from "./deviation.js";

export type AttentionFlag = { reason: "delivery_failed"; message: string } | DeviationFlag;

type Row = { issueId: number; message: string | null };

function unresolvedDeliveryFailures(db: Db, issueId?: number): Row[] {
  return db.all<Row>(sql`
    SELECT latest.issue_id AS issueId, json_extract(f.payload, '$.message') AS message
    FROM (
      SELECT issue_id, MAX(id) AS eventId
      FROM events
      WHERE type = 'delivery_failed'
      ${issueId !== undefined ? sql`AND issue_id = ${issueId}` : sql``}
      GROUP BY issue_id
    ) latest
    JOIN events f ON f.id = latest.eventId
    WHERE NOT EXISTS (
      SELECT 1 FROM events e2
      WHERE e2.issue_id = latest.issue_id
        AND e2.type = 'delivered'
        AND e2.id > latest.eventId
    )
    AND NOT EXISTS (
      SELECT 1 FROM pr_state ps, issues i, projects p
      WHERE i.id = latest.issue_id
        AND i.project_id = p.id
        AND ps.issue_ref = p.key || '-' || i.number
        AND ps.status = 'merged'
        AND ps.last_transition_event_id > latest.eventId
    )
  `);
}

export function getAttention(db: Db, issueId: number): AttentionFlag | null {
  const [row] = unresolvedDeliveryFailures(db, issueId);
  if (row) return { reason: "delivery_failed", message: row.message ?? "delivery failed" };
  return getDeviation(db, issueId);
}

export function listAttentionByIssueId(db: Db): Map<number, AttentionFlag> {
  // Start from deviations, then let unresolved delivery failures overwrite —
  // delivery_failed (a hard error) outranks any process deviation on collision.
  const map = new Map<number, AttentionFlag>(listDeviationByIssueId(db));
  for (const r of unresolvedDeliveryFailures(db)) {
    map.set(r.issueId, { reason: "delivery_failed", message: r.message ?? "delivery failed" });
  }
  return map;
}
