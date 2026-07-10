// Open-PR status (SYD-99): an issue counts as having an open agent PR when its
// latest pr_opened (worker's own publish, SYD-54) or gh_pr_opened (GitHub
// webhook/poll fallback, SYD-71) event has no later delivered/gh_pr_merged/
// gh_pr_closed event closing it out. claimIssue and updateIssue's in_progress
// gate (src/services/issues.ts) use this to refuse a second claim while one
// is already in flight — the gap that let SYD-93 get fixed twice in parallel
// (worker PR #41 vs a coordinating session's PR #42).
import { sql } from "drizzle-orm";
import type { Db } from "../db/index.js";

export type OpenPr = { prNumber: number; url: string };

type Row = { issueId: number; prNumber: number; url: string };

function openPrRows(db: Db, issueId?: number): Row[] {
  return db.all<Row>(sql`
    SELECT latest.issue_id AS issueId,
           json_extract(f.payload, '$.prNumber') AS prNumber,
           json_extract(f.payload, '$.url') AS url
    FROM (
      SELECT issue_id, MAX(id) AS eventId
      FROM events
      WHERE type IN ('pr_opened', 'gh_pr_opened')
      ${issueId !== undefined ? sql`AND issue_id = ${issueId}` : sql``}
      GROUP BY issue_id
    ) latest
    JOIN events f ON f.id = latest.eventId
    WHERE NOT EXISTS (
      SELECT 1 FROM events e2
      WHERE e2.issue_id = latest.issue_id
        AND e2.type IN ('delivered', 'gh_pr_merged', 'gh_pr_closed')
        AND e2.id > latest.eventId
    )
  `);
}

export function getOpenPr(db: Db, issueId: number): OpenPr | null {
  const [row] = openPrRows(db, issueId);
  return row ? { prNumber: row.prNumber, url: row.url } : null;
}

export function listOpenPrByIssueId(db: Db): Map<number, OpenPr> {
  return new Map(openPrRows(db).map((r) => [r.issueId, { prNumber: r.prNumber, url: r.url }]));
}
