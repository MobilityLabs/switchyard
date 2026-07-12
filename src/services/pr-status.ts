// Open-PR status (SYD-99): an issue counts as having an open agent PR when
// one of its pr_opened (worker's own publish, SYD-54) or gh_pr_opened
// (GitHub webhook/poll fallback, SYD-71) events for a given PR number has no
// later delivered/gh_pr_merged/gh_pr_closed event *for that same PR number*
// closing it out (SYD-125: a close is matched to its own prNumber rather than
// to whichever pr_opened/gh_pr_opened happens to have the highest id, so a
// belated close for an old PR can't report a newer still-open PR as closed).
// claimIssue and updateIssue's in_progress gate (src/services/issues.ts) use
// this to refuse a second claim while one is already in flight — the gap
// that let SYD-93 get fixed twice in parallel (worker PR #41 vs a
// coordinating session's PR #42).
import { sql } from "drizzle-orm";
import type { Db } from "../db/index.js";

export type OpenPr = { prNumber: number; url: string };

type Row = { issueId: number; prNumber: number; url: string };

// Ordered oldest-eventId-first so listOpenPrByIssueId's Map construction
// (later entries overwrite earlier ones for the same issueId) keeps the most
// recently opened PR when an issue somehow has more than one open at once.
function openPrRows(db: Db, issueId?: number): Row[] {
  return db.all<Row>(sql`
    SELECT latest.issue_id AS issueId,
           latest.prNumber AS prNumber,
           json_extract(f.payload, '$.url') AS url
    FROM (
      SELECT issue_id,
             json_extract(payload, '$.prNumber') AS prNumber,
             MAX(id) AS eventId
      FROM events
      WHERE type IN ('pr_opened', 'gh_pr_opened')
      ${issueId !== undefined ? sql`AND issue_id = ${issueId}` : sql``}
      GROUP BY issue_id, json_extract(payload, '$.prNumber')
    ) latest
    JOIN events f ON f.id = latest.eventId
    WHERE NOT EXISTS (
      SELECT 1 FROM events e2
      WHERE e2.issue_id = latest.issue_id
        AND e2.type IN ('delivered', 'gh_pr_merged', 'gh_pr_closed')
        AND json_extract(e2.payload, '$.prNumber') = latest.prNumber
        AND e2.id > latest.eventId
    )
    ORDER BY latest.eventId ASC
  `);
}

export function getOpenPr(db: Db, issueId: number): OpenPr | null {
  const rows = openPrRows(db, issueId);
  const row = rows[rows.length - 1];
  return row ? { prNumber: row.prNumber, url: row.url } : null;
}

export function listOpenPrByIssueId(db: Db): Map<number, OpenPr> {
  return new Map(openPrRows(db).map((r) => [r.issueId, { prNumber: r.prNumber, url: r.url }]));
}

export type MergedPrEvent = { prNumber: number; eventId: number };

// The latest merge event for an issue (a `delivered` self-publish or a
// `gh_pr_merged` webhook), with its event id — used by the process-deviation
// signal both to name the PR and as the "episode start" marker for webhook
// dedup. Note `delivered` payloads carry no url, so only prNumber is returned.
export function getMergedPrEvent(db: Db, issueId: number): MergedPrEvent | null {
  const row = db.all<{ prNumber: number; eventId: number }>(sql`
    SELECT json_extract(payload, '$.prNumber') AS prNumber, id AS eventId
    FROM events
    WHERE issue_id = ${issueId} AND type IN ('gh_pr_merged', 'delivered')
    ORDER BY id DESC
    LIMIT 1
  `)[0];
  return row ? { prNumber: row.prNumber, eventId: row.eventId } : null;
}
