// Attention flag (SYD-84): a red error signal for issues that need a human
// to look. It aggregates three sources, in priority order: an unresolved
// delivery_failed (SYD-54's structured delivery events — the latest one on an
// issue counts only if nothing later resolved it), then a live process
// deviation (SYD-188) from ./deviation.js, then an unresolved
// done_without_merged_pr deviation (SYD-204 — recorded once at the done
// transition itself rather than recomputed live, see doneWithoutMergedPr).
//
// What resolves a delivery failure: a later `delivered` event (the
// delivery-attempt vocabulary stays event-written by the delivery worker), the
// issue's PR reaching `merged` in pr_state with a co-written transition event
// newer than the failure (SYD-207 — a manual merge of the agent/<ref> branch
// observed by the webhook/poller, replacing the deleted SYD-94 reconcile
// pass), or a later `delivery_resolved` event (SYD-178 — a human explicitly
// clearing a stuck flag when the fix landed through a path pr_state never
// attributes, e.g. an interactive feat/ branch). Raw gh_pr_merged events are
// audit history and no longer consulted — pr_state's strict agent/<ref>
// attribution is deliberate (SYD-206), so a non-agent merge never auto-clears
// the flag; only an explicit human resolve does.
// A done_without_merged_pr deviation resolves the same way: a later pr_state
// row reaching `merged` (e.g. a human manually pushes the stale branch and
// merges it by hand after the fact).
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
        AND e2.type IN ('delivered', 'delivery_resolved')
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

function unresolvedDoneWithoutMerge(db: Db, issueId?: number): Row[] {
  return db.all<Row>(sql`
    SELECT latest.issue_id AS issueId, json_extract(f.payload, '$.message') AS message
    FROM (
      SELECT issue_id, MAX(id) AS eventId
      FROM events
      WHERE type = 'process_deviation'
        AND json_extract(payload, '$.reason') = 'done_without_merged_pr'
        ${issueId !== undefined ? sql`AND issue_id = ${issueId}` : sql``}
      GROUP BY issue_id
    ) latest
    JOIN events f ON f.id = latest.eventId
    JOIN issues i ON i.id = latest.issue_id AND i.status = 'done'
    WHERE NOT EXISTS (
      SELECT 1 FROM pr_state ps, projects p
      WHERE i.project_id = p.id
        AND ps.issue_ref = p.key || '-' || i.number
        AND ps.status = 'merged'
        AND ps.last_transition_event_id > latest.eventId
    )
    -- SYD-262: the human escape hatch. pr_state attributes strictly by
    -- agent/<ref> (SYD-206), so work landed on an interactive feat/ branch
    -- never produces the merged row above and the flag would stay red
    -- forever. Scoped to the matching reason so clearing one deviation can't
    -- silence a different one, and keyed on event id so a LATER deviation
    -- re-raises (same ordering rule delivery_resolved uses).
    AND NOT EXISTS (
      SELECT 1 FROM events r
      WHERE r.issue_id = latest.issue_id
        AND r.type = 'deviation_resolved'
        AND json_extract(r.payload, '$.reason') = 'done_without_merged_pr'
        AND r.id > latest.eventId
    )
  `);
}

export function getAttention(db: Db, issueId: number): AttentionFlag | null {
  const [row] = unresolvedDeliveryFailures(db, issueId);
  if (row) return { reason: "delivery_failed", message: row.message ?? "delivery failed" };
  const deviation = getDeviation(db, issueId);
  if (deviation) return deviation;
  const [doneRow] = unresolvedDoneWithoutMerge(db, issueId);
  if (doneRow) {
    return {
      reason: "done_without_merged_pr",
      message: doneRow.message ?? "done without a merged PR",
    };
  }
  return null;
}

export function listAttentionByIssueId(db: Db): Map<number, AttentionFlag> {
  // Start from deviations, then let done_without_merged_pr and finally
  // unresolved delivery failures overwrite — delivery_failed (a hard error)
  // outranks everything else on collision.
  const map = new Map<number, AttentionFlag>(listDeviationByIssueId(db));
  for (const r of unresolvedDoneWithoutMerge(db)) {
    map.set(r.issueId, {
      reason: "done_without_merged_pr",
      message: r.message ?? "done without a merged PR",
    });
  }
  for (const r of unresolvedDeliveryFailures(db)) {
    map.set(r.issueId, { reason: "delivery_failed", message: r.message ?? "delivery failed" });
  }
  return map;
}
