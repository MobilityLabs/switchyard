// Open/merged-PR reads over pr_state (SYD-207, spec: docs/2026-07-12-sync-
// simplification-assessment.md Step 1 cutover). Until SYD-207 these were
// derived from the event log with hand-synced terminal-event IN-lists — the
// drift bug class (SYD-176/177/178/202). Now they read the mutable pr_state
// table, whose single writer upsertPrState (src/services/pr-state.ts) enforces
// the ordering discipline, so a read here can never disagree with the claim
// gate or the poller's observations.
//
// Which rows reach these results is decided by pr_links, not by pr_state:
// every query below joins the two on (repo, pr_number), so a row is visible to
// an issue exactly when that issue holds a live `delivers` link (SYD-280).
// pr_state.issue_ref is not consulted here and has not been since the swap.
//
// Ingestion writes a pr_state row for EVERY PR in a bound repo (SYD-287,
// github-webhook.ts), so the join always has its observation half waiting and
// a declaration completes it whenever it arrives — including long after a
// merge. It did not before: only an agent/<ref> branch produced a row, so a
// declared link on any other branch INNER JOINed to nothing and every reader
// here returned null — no claim gate, no delivery pin, no proof of landing.
//
// The corollary is that a pr_state row means nothing on its own. Rows for
// undeclared PRs are inert here by construction, because the join is what
// carries the attribution. Free-text title matches yield a `references` link,
// which LIVE_DELIVERS excludes: audit history, never claim-gating state.
//
// claimIssue and updateIssue's in_progress gate (src/services/issues.ts) use
// getOpenPr to refuse a second claim while one is already in flight — the gap
// that let SYD-93 get fixed twice in parallel.
import { sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../db/index.js";

// SYD-280: attribution is a declared pr_links row, not a parsed branch name.
// These two fragments are the whole trust model at the read sites, kept as
// named constants so the six call sites can never drift apart the way the
// hand-synced terminal-event IN-lists did before SYD-207.
//
// CLAIM-GATING — any live `delivers` link, confirmed or not. An unconfirmed
// (agent-declared) link still blocks a second claim: over-blocking is safe,
// and a human can revoke it.
const LIVE_DELIVERS = sql`pl.revoked_at IS NULL AND pl.role = 'delivers'`;

// PROOF-BEARING — additionally requires a confirmation, plus the §5a recency
// binding UNLESS a human confirmed it. Recency compares GitHub's own clock
// (ps.gh_updated_at) against the declaration, and fails closed when GitHub
// gave us no timestamp.
//
// The human exception is load-bearing, not a softening: hand-merge-then-update
// is the dominant interactive flow, so a blanket recency rule would make every
// hand-merged issue permanently unable to prove it landed — this epic's own bug,
// reintroduced backwards.
const PROOF_BEARING = sql`
  ${LIVE_DELIVERS}
  AND pl.confirmed_by IS NOT NULL
  AND (
    EXISTS (SELECT 1 FROM actors ca WHERE ca.id = pl.confirmed_by AND ca.type = 'human')
    OR (ps.gh_updated_at IS NOT NULL AND ps.gh_updated_at >= pl.declared_at)
  )
`;

export type OpenPr = { prNumber: number; url: string; repo: string; headSha: string | null };

type Row = { issueId: number; prNumber: number; url: string; repo: string; headSha: string | null };

// issueRef is denormalized text ("SYD-42"), so rows join back to issues via
// project key + number. Ordered by prNumber so listOpenPrByIssueId's Map
// construction (later entries overwrite earlier ones for the same issueId)
// keeps the newest PR when an issue somehow has more than one open at once.
function openRows(db: Db, issueId?: number): Row[] {
  return db.all<Row>(sql`
    SELECT pl.issue_id AS issueId,
           ps.pr_number AS prNumber,
           COALESCE(ps.url, '') AS url,
           ps.repo AS repo,
           ps.head_sha AS headSha
    FROM pr_links pl
    JOIN pr_state ps
      ON lower(ps.repo) = lower(pl.repo) AND ps.pr_number = pl.pr_number
    WHERE ${LIVE_DELIVERS}
      AND ps.status = 'open'
      ${issueId !== undefined ? sql`AND pl.issue_id = ${issueId}` : sql``}
    ORDER BY ps.pr_number ASC
  `);
}

export function getOpenPr(db: Db, issueId: number): OpenPr | null {
  const rows = openRows(db, issueId);
  const row = rows[rows.length - 1];
  return row
    ? { prNumber: row.prNumber, url: row.url, repo: row.repo, headSha: row.headSha }
    : null;
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
    FROM pr_links pl
    JOIN pr_state ps
      ON lower(ps.repo) = lower(pl.repo) AND ps.pr_number = pl.pr_number
    WHERE pl.issue_id = ${issueId}
      AND ${LIVE_DELIVERS}
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
    FROM pr_links pl
    JOIN pr_state ps
      ON lower(ps.repo) = lower(pl.repo) AND ps.pr_number = pl.pr_number
    WHERE pl.issue_id = ${issueId}
      AND ${LIVE_DELIVERS}
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
  // The one read that constitutes EVIDENCE, so it is the one that demands a
  // proof-bearing link rather than a merely claim-gating one.
  const row = db.all<{ prNumber: number; eventId: number }>(sql`
    SELECT ps.pr_number AS prNumber,
           COALESCE(ps.last_transition_event_id, 0) AS eventId
    FROM pr_links pl
    JOIN pr_state ps
      ON lower(ps.repo) = lower(pl.repo) AND ps.pr_number = pl.pr_number
    WHERE pl.issue_id = ${issueId}
      AND ${PROOF_BEARING}
      AND ps.status = 'merged'
    ORDER BY COALESCE(ps.gh_updated_at, 0) DESC, ps.pr_number DESC
    LIMIT 1
  `)[0];
  return row ? { prNumber: row.prNumber, eventId: row.eventId } : null;
}
