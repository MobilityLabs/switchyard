// Attention flag (SYD-84): a red error signal for issues that need a human
// to look, derived from the event log the same way listUnansweredQuestions
// derives its "waiting on humans" flag — no stored column, so it can never
// drift from what actually happened. Today's only source is an unresolved
// delivery_failed (SYD-54's structured delivery events): the latest one on
// an issue counts only if no later delivered/gh_pr_merged event cleared it.
import { sql } from "drizzle-orm";
import type { Db } from "../db/index.js";

export type AttentionFlag = { reason: "delivery_failed"; message: string };

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
        AND e2.type IN ('delivered', 'gh_pr_merged')
        AND e2.id > latest.eventId
    )
  `);
}

export function getAttention(db: Db, issueId: number): AttentionFlag | null {
  const [row] = unresolvedDeliveryFailures(db, issueId);
  return row ? { reason: "delivery_failed", message: row.message ?? "delivery failed" } : null;
}

export function listAttentionByIssueId(db: Db): Map<number, AttentionFlag> {
  const rows = unresolvedDeliveryFailures(db);
  return new Map(
    rows.map((r) => [
      r.issueId,
      { reason: "delivery_failed", message: r.message ?? "delivery failed" },
    ]),
  );
}
