// Open/merged-PR reads over pr_state (SYD-207, spec: docs/2026-07-12-sync-
// simplification-assessment.md Step 1 cutover). Until SYD-207 these were
// derived from the event log with hand-synced terminal-event IN-lists — the
// drift bug class (SYD-176/177/178/202). Now they read the mutable pr_state
// table, whose single writer upsertPrState (src/services/pr-state.ts) enforces
// the ordering discipline, so a read here can never disagree with the claim
// gate or the poller's observations.
//
// Only *attributed* rows (issueRef set — strict agent/<ref> branch match on a
// repo bound to that ref's project) ever reach these results. Display-only
// rows, and legacy event-log-only PRs (the old free-text title matches),
// are audit history, never claim-gating state.
//
// claimIssue and updateIssue's in_progress gate (src/services/issues.ts) use
// getOpenPr to refuse a second claim while one is already in flight — the gap
// that let SYD-93 get fixed twice in parallel.
import { sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../db/index.js";

export type OpenPr = { prNumber: number; url: string; repo: string; headSha: string | null };

type Row = { issueId: number; prNumber: number; url: string; repo: string; headSha: string | null };

// issueRef is denormalized text ("SYD-42"), so rows join back to issues via
// project key + number. Ordered by prNumber so listOpenPrByIssueId's Map
// construction (later entries overwrite earlier ones for the same issueId)
// keeps the newest PR when an issue somehow has more than one open at once.
function openRows(db: Db, issueId?: number): Row[] {
  return db.all<Row>(sql`
    SELECT i.id AS issueId,
           ps.pr_number AS prNumber,
           COALESCE(ps.url, '') AS url,
           ps.repo AS repo,
           ps.head_sha AS headSha
    FROM pr_state ps, issues i, projects p
    WHERE i.project_id = p.id
      AND ps.issue_ref = p.key || '-' || i.number
      AND ps.status = 'open'
      ${issueId !== undefined ? sql`AND i.id = ${issueId}` : sql``}
    ORDER BY ps.pr_number ASC
  `);
}

export function getOpenPr(db: Db, issueId: number): OpenPr | null {
  const rows = openRows(db, issueId);
  const row = rows[rows.length - 1];
  return row ? { prNumber: row.prNumber, url: row.url, repo: row.repo, headSha: row.headSha } : null;
}

export function listOpenPrByIssueId(db: Db): Map<number, OpenPr> {
  return new Map(
    openRows(db).map((r) => [
      r.issueId,
      { prNumber: r.prNumber, url: r.url, repo: r.repo, headSha: r.headSha },
    ]),
  );
}

export type DeliveryPin = {
  repo: string;
  prNumber: number;
  headSha: string | null;
  status: "open" | "merged" | "closed";
};

/** The issue's attributed pr_state row a Retry would re-authorize — preferring
 * open over merged over closed, newest first (SYD-208). Called both from
 * plain `Db` reads (redeliverIssue) and from inside updateIssue's transaction
 * (done-stamp pin), hence DbOrTx. */
export function deliveryPinFor(db: DbOrTx, issueId: number): DeliveryPin | null {
  const row = db.all<DeliveryPin>(sql`
    SELECT ps.repo AS repo, ps.pr_number AS prNumber, ps.head_sha AS headSha, ps.status AS status
    FROM pr_state ps, issues i, projects p
    WHERE i.project_id = p.id
      AND i.id = ${issueId}
      AND ps.issue_ref = p.key || '-' || i.number
    ORDER BY CASE ps.status WHEN 'open' THEN 0 WHEN 'merged' THEN 1 ELSE 2 END,
             COALESCE(ps.gh_updated_at, 0) DESC, ps.pr_number DESC
    LIMIT 1
  `)[0];
  return row ?? null;
}

/** The canonical transition event id (upsertPrState's co-write) for an
 * issue's PR, or 0 if the row predates event co-writing — the deviation
 * signal's "episode start" dedup marker. */
export function prTransitionEventId(db: Db, issueId: number, prNumber: number): number {
  const row = db.all<{ eventId: number }>(sql`
    SELECT COALESCE(ps.last_transition_event_id, 0) AS eventId
    FROM pr_state ps, issues i, projects p
    WHERE i.project_id = p.id
      AND i.id = ${issueId}
      AND ps.issue_ref = p.key || '-' || i.number
      AND ps.pr_number = ${prNumber}
  `)[0];
  return row?.eventId ?? 0;
}

export type MergedPr = { prNumber: number; eventId: number };

// The issue's most recently merged PR (by GitHub's own timestamp), with the
// canonical transition event upsertPrState co-wrote — used by the
// process-deviation signal both to name the PR and as the "episode start"
// marker for webhook dedup. eventId falls back to 0 for a row whose
// transition predates event co-writing entirely.
export function getMergedPr(db: Db, issueId: number): MergedPr | null {
  const row = db.all<{ prNumber: number; eventId: number }>(sql`
    SELECT ps.pr_number AS prNumber,
           COALESCE(ps.last_transition_event_id, 0) AS eventId
    FROM pr_state ps, issues i, projects p
    WHERE i.project_id = p.id
      AND i.id = ${issueId}
      AND ps.issue_ref = p.key || '-' || i.number
      AND ps.status = 'merged'
    ORDER BY COALESCE(ps.gh_updated_at, 0) DESC, ps.pr_number DESC
    LIMIT 1
  `)[0];
  return row ? { prNumber: row.prNumber, eventId: row.eventId } : null;
}
