// Attention flag (SYD-84): a red error signal for issues that need a human
// to look. It aggregates three sources, in priority order: an unresolved
// delivery_failed (SYD-54's structured delivery events — the latest one on an
// issue counts only if nothing later resolved it), then a live process
// deviation (SYD-188) from ./deviation.js, then an unresolved
// done_without_merged_pr deviation (SYD-204 — recorded once at the done
// transition itself rather than recomputed live, see doneWithoutMergedPr).
//
// What resolves a delivery failure: a later `delivered` event (the
// delivery-attempt vocabulary stays event-written by the delivery worker), a
// PR the issue DECLARED reaching `merged` in pr_state with a co-written
// transition event newer than the failure (SYD-207, replacing the deleted
// SYD-94 reconcile pass), or a later `delivery_resolved` event (SYD-178 — a
// human explicitly clearing a stuck flag when the fix landed through a path
// nothing observed at all, e.g. a direct push with no PR). Raw gh_pr_merged
// events are audit history here and are never consulted: clearing a delivery
// failure re-authorizes an actual merge+deploy, so the evidence has to be a
// declared link joined to an observed merge, not a string in a PR title.
//
// Both arms below read pr_links ⋈ pr_state, so both cover interactive `feat/`
// work — the declaration supplies the attribution (SYD-280) and ingestion
// supplies the observation (SYD-287). Neither reads a branch name.
//
// A done_without_merged_pr deviation resolves on either: a merged pr_state row
// reached through a PROOF-BEARING link (declared AND confirmed by someone
// accountable — see the SQL comment below for why SYD-267's second arm had to
// go), or a later deviation_resolved recorded by a human (SYD-262).
//
// The two flags demand different strengths of evidence, and the difference is
// what each authorizes. delivery_failed gates a real merge+deploy, so it wants
// the transition ordered after the failure. done_without_merged_pr gates
// nothing — it only asks a human to go verify the work landed — so it stays
// deliberately unordered, but it does demand a confirmed link, because before
// SYD-280 any PR that merely MENTIONED an issue silenced it permanently.
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
      SELECT 1 FROM pr_links pl
      JOIN pr_state ps
        ON lower(ps.repo) = lower(pl.repo) AND ps.pr_number = pl.pr_number
      WHERE pl.issue_id = latest.issue_id
        AND pl.revoked_at IS NULL
        AND pl.role = 'delivers'
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
    -- SYD-280: one arm, where there used to be two.
    --
    -- The old pair was (a) a merged pr_state row for this ref, event-ordered,
    -- and (b) SYD-267's unordered "ANY gh_pr_merged event on this issue".
    -- (b) existed because a feat/ branch's merge was only ever a display
    -- event, so (a) could never see it — but display events come from the
    -- first REF_RE match in a PR title or body, so a PR that merely MENTIONED
    -- an issue cleared its warning permanently. The safety net could be
    -- silenced by the same loose matching it was built to catch. This repo's
    -- own history has the shape: 62763cc, "fix: rehabilitate SYD-245's tests
    -- against the SYD-242 expiresAt param (SYD-265)", first-mentions SYD-245.
    --
    -- Now a merge clears the flag only through a PROOF-BEARING declared link
    -- (declared and confirmed by someone accountable), which both arms'
    -- intents reduce to. A free-text match now yields a references-role link,
    -- which is not proof-bearing, so a passing mention clears nothing.
    --
    -- Deliberately NOT event-id ordered, keeping SYD-267's reasoning: whether
    -- the merge lands before or after the deviation is an accident of poller
    -- lag, and both orders describe the same situation. The cost is that a
    -- reopen-and-re-stamp can't re-raise past an old merge — acceptable
    -- because this flag authorizes nothing, it only asks a human to look.
    WHERE NOT EXISTS (
      SELECT 1 FROM pr_links pl
      JOIN pr_state ps
        ON lower(ps.repo) = lower(pl.repo) AND ps.pr_number = pl.pr_number
      WHERE pl.issue_id = latest.issue_id
        AND pl.revoked_at IS NULL
        AND pl.role = 'delivers'
        AND pl.confirmed_by IS NOT NULL
        AND (
          EXISTS (SELECT 1 FROM actors ca WHERE ca.id = pl.confirmed_by AND ca.type = 'human')
          OR (ps.gh_updated_at IS NOT NULL AND ps.gh_updated_at >= pl.declared_at)
        )
        AND ps.status = 'merged'
    )
    -- SYD-262: the human escape hatch, for work that landed with no PR at all
    -- (so nothing above can vouch for it). Scoped to the matching reason so
    -- clearing one deviation can't silence a different one, and keyed on event
    -- id so a LATER deviation re-raises (same ordering rule delivery_resolved
    -- uses).
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
