// Process-deviation signal (SYD-188): derived from issue status + pr_state +
// the event log — no stored column. Flags issues that have drifted out of the
// board process (claim -> in_progress -> PR -> in_review -> human stamps
// done). NEVER mutates the issues table; it only reads (and, via
// emitProcessDeviations in webhook-dispatcher, records notification events).
// Since SYD-207 the PR facts come from pr_state, and episode dedup keys off
// pr_state.lastTransitionEventId — the canonical transition event
// upsertPrState co-writes — instead of raw event scans.
import { and, eq, inArray, max, ne, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { events, issues, type Status } from "../db/schema.js";
import {
  getOpenPr,
  listOpenPrByIssueId,
  getMergedPr,
  prTransitionEventId,
  type OpenPr,
  type MergedPr,
} from "./pr-status.js";
import { getSetting } from "./settings.js";
import { recordEvent } from "./events.js";

export type DeviationReason =
  "open_pr_not_in_review" | "merged_pr_not_done" | "stale_claim" | "done_without_merged_pr";
export type DeviationFlag = { reason: DeviationReason; message: string };

// Richer computation shared by the read-path (getDeviation) and the webhook
// emitter (Task 4). `episodeStartId` is the id of the event that began this drift
// episode — the dedup key that makes the webhook fire once per episode.
export type DeviationComputation = DeviationFlag & {
  episodeStartId: number;
  prNumber: number | null;
};

type IssueRow = typeof issues.$inferSelect;

const CANDIDATE_STATUSES = ["todo", "in_progress", "in_review"] as const;

// process_deviation events are excluded so the monitoring signal itself can't
// reset the idle clock it's monitoring (SYD-188): recording one at ~now would
// otherwise make the issue look freshly active and clear the stale_claim flag.
function newestEventAt(db: Db, issue: IssueRow): number {
  const row = db
    .select({ createdAt: max(events.createdAt) })
    .from(events)
    .where(and(eq(events.issueId, issue.id), ne(events.type, "process_deviation")))
    .get();
  return row?.createdAt ?? issue.createdAt;
}

function claimStartEventId(db: Db, issueId: number): number {
  const row = db.all<{ eventId: number | null }>(sql`
    SELECT MAX(id) AS eventId FROM events
    WHERE issue_id = ${issueId}
      AND type = 'status_changed'
      AND json_extract(payload, '$.to') = 'in_progress'
  `)[0];
  return row?.eventId ?? 0;
}

// Single source of truth for the three deviation cases, in priority order.
export function computeDeviation(
  db: Db,
  issue: IssueRow,
  openPr: OpenPr | null,
  now: number,
  thresholdSeconds: number,
): DeviationComputation | null {
  if (issue.status === "in_review" && openPr === null) {
    const merged = getMergedPr(db, issue.id);
    if (merged) {
      return {
        reason: "merged_pr_not_done",
        message: `PR #${merged.prNumber} is merged — a human can stamp this done`,
        episodeStartId: merged.eventId,
        prNumber: merged.prNumber,
      };
    }
  }
  if ((issue.status === "todo" || issue.status === "in_progress") && openPr !== null) {
    return {
      reason: "open_pr_not_in_review",
      message: `PR #${openPr.prNumber} is open but issue is ${issue.status} — move it to in_review`,
      episodeStartId: prTransitionEventId(db, issue.id, openPr.prNumber),
      prNumber: openPr.prNumber,
    };
  }
  if (issue.status === "in_progress" && !issue.needsInput) {
    const idle = now - newestEventAt(db, issue);
    if (idle > thresholdSeconds) {
      const idleHours = Math.max(1, Math.round(idle / 3600));
      return {
        reason: "stale_claim",
        message: `claimed but idle for ~${idleHours}h — post a progress note or release the claim`,
        episodeStartId: claimStartEventId(db, issue.id),
        prNumber: null,
      };
    }
  }
  return null;
}

// SYD-204: a point-in-time check run inside updateIssue's done transition —
// unlike the three reasons above (recomputed live from current state on every
// read), this one captures a fact about the transition itself, at the moment
// it happens: an issue someone was writing code for reached done with no PR
// ever recorded open or merged. An in-flight open PR isn't a deviation:
// stamping done over one is the normal SYD-208 flow that authorizes delivery
// to merge it shortly after.
//
// Which statuses count as "someone was writing code" is the whole question.
// A closure from triage/backlog/todo involves no code by definition — nobody
// claimed it — so a research spike or a duplicate must never flag, and those
// are the legitimate no-merge dones this stays attention-only for.
//
// SYD-265 added in_progress to in_review. The original scoping justified
// excluding triage/backlog on the "no code involved" ground; in_progress got
// swept in with them and never had a rationale of its own, but it does not
// share theirs — an issue in in_progress has been CLAIMED, and the claim is
// exactly the signal that code work started. Stamping such an issue straight
// to done with no PR is the same lost-work shape as from in_review, and
// skipping review makes it likelier to go unnoticed, not less.
const STARTED_STATUSES = new Set<Status>(["in_review", "in_progress"]);

export function doneWithoutMergedPr(
  fromStatus: Status,
  openPr: OpenPr | null,
  merged: MergedPr | null,
): DeviationFlag | null {
  if (!STARTED_STATUSES.has(fromStatus) || openPr !== null || merged !== null) return null;
  return {
    reason: "done_without_merged_pr",
    message: `moved to done from ${fromStatus} with no PR ever recorded as open or merged — verify the code actually landed`,
  };
}

export function getDeviation(db: Db, issueId: number): DeviationFlag | null {
  const issue = db.select().from(issues).where(eq(issues.id, issueId)).get();
  if (!issue) return null;
  const now = Math.floor(Date.now() / 1000);
  const threshold = getSetting(db, "claims.deviation_seconds");
  const c = computeDeviation(db, issue, getOpenPr(db, issueId), now, threshold);
  return c ? { reason: c.reason, message: c.message } : null;
}

export function listDeviationByIssueId(db: Db): Map<number, DeviationFlag> {
  const now = Math.floor(Date.now() / 1000);
  const threshold = getSetting(db, "claims.deviation_seconds");
  const openPrs = listOpenPrByIssueId(db);
  const rows = db
    .select()
    .from(issues)
    .where(inArray(issues.status, [...CANDIDATE_STATUSES]))
    .all();
  const out = new Map<number, DeviationFlag>();
  for (const issue of rows) {
    const c = computeDeviation(db, issue, openPrs.get(issue.id) ?? null, now, threshold);
    if (c) out.set(issue.id, { reason: c.reason, message: c.message });
  }
  return out;
}

function alreadyEmitted(
  db: Db,
  issueId: number,
  reason: DeviationReason,
  episodeStartId: number,
): boolean {
  const row = db.all<{ id: number }>(sql`
    SELECT id FROM events
    WHERE issue_id = ${issueId}
      AND type = 'process_deviation'
      AND json_extract(payload, '$.reason') = ${reason}
      AND id > ${episodeStartId}
    LIMIT 1
  `)[0];
  return row !== undefined;
}

// Records a `process_deviation` event for every currently-drifting issue that
// has not already been flagged for this episode (dedup derived from events, so
// it self-re-arms on the next episode — no stored "notified" column). The event
// fans out through the existing webhook dispatcher. Attributed to the assignee
// (else creator), mirroring releaseStaleClaims. Returns the count recorded.
export function emitProcessDeviations(db: Db): number {
  const now = Math.floor(Date.now() / 1000);
  const threshold = getSetting(db, "claims.deviation_seconds");
  const rows = db
    .select()
    .from(issues)
    .where(inArray(issues.status, [...CANDIDATE_STATUSES]))
    .all();
  const openPrs = listOpenPrByIssueId(db);
  let emitted = 0;
  for (const issue of rows) {
    const c = computeDeviation(db, issue, openPrs.get(issue.id) ?? null, now, threshold);
    if (!c) continue;
    if (alreadyEmitted(db, issue.id, c.reason, c.episodeStartId)) continue;
    recordEvent(db, {
      issueId: issue.id,
      actorId: issue.assigneeId ?? issue.creatorId,
      type: "process_deviation",
      payload:
        c.prNumber != null ? { reason: c.reason, prNumber: c.prNumber } : { reason: c.reason },
    });
    emitted++;
  }
  return emitted;
}
