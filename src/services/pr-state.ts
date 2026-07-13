// Mutable PR state with one write path (SYD-206, spec: docs/2026-07-12-sync-
// simplification-assessment.md Step 1). upsertPrState() is the ONLY writer of
// the pr_state table; its callers are the GitHub webhook handler, the poller
// (via /github-events), the worker's PR publish and the delivery worker's
// merge (via /issues/:ref/delivery-events), and — at cutover (SYD-207) — the
// one-time backfill.
//
// The ordering discipline is the load-bearing part. GitHub webhooks are
// at-least-once and unordered, and the poller reads GitHub's eventually-
// consistent windowed search, so:
//
// - Terminal states never regress. merged is final; closed may still become
//   merged (a merge is more final than a close); open-after-terminal happens
//   ONLY via an explicit `reopened` observation whose GitHub timestamp is
//   strictly newer than the stored terminal row's (fail-closed on a missing
//   or unparseable timestamp on either side).
// - Same-status refreshes are monotonic on ghUpdatedAt: an observation with
//   no timestamp, or one older than the stored row, is a no-op. Equal
//   timestamps apply (same-second last-write-wins — GitHub timestamps have
//   second precision; documented tie behavior, and safe because ties can only
//   refresh fields, never transition status).
// - Absence is not evidence: this function only ever moves state forward from
//   an observation; a PR missing from a poll window simply produces no call.
// - Authoritative attribution is branch-only AND repo-bound: issueRef is set
//   only when the branch is a strict agent/<ref> match AND this repo is bound
//   to that ref's project (github_repos.projectId). An agent/SYD-1 PR in some
//   other project's repo records display-only state, never SYD-1's claim-
//   gating state. Free-text ref scans never reach this function.
// - On a real transition it co-writes ONE canonical audit event
//   (gh_pr_opened/gh_pr_merged/gh_pr_closed/gh_pr_reopened), deduped against
//   history via findEventIdByPayload so a redelivery — or a pre-cutover event
//   recorded by the old direct-write path — never yields a second copy; the
//   event id (new or the deduped original's) becomes lastTransitionEventId.

import { and, eq } from "drizzle-orm";
import type { Db, DbOrTx } from "../db/index.js";
import { prState, githubRepos } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { getIssue } from "./issues.js";
import { getProjectByKey } from "./projects.js";
import { recordEvent, findEventIdByPayload } from "./events.js";
import { parseGhTimestamp, refFromBranch } from "./github-webhook.js";

export type PrStateRow = typeof prState.$inferSelect;
export type PrStatus = "open" | "merged" | "closed";
export type PrTransition = "opened" | "merged" | "closed" | "reopened";

export type PrObservation = {
  repo: string;
  prNumber: number;
  status: PrStatus;
  /** The caller saw an explicit GitHub `reopened` action — the only signal
   * allowed to move a terminal row back to open. */
  reopened?: boolean;
  branch?: string | null;
  url?: string | null;
  headSha?: string | null;
  /** GitHub's own updated_at (ISO), never a local clock. Parsed fail-closed. */
  ghUpdatedAt?: string | null;
  /** Merge commit SHA, recorded on the co-written gh_pr_merged event. */
  mergeSha?: string | null;
};

export type UpsertPrStateOutcome = {
  applied: boolean;
  transition: PrTransition | null;
  reason?: string;
};

function ghEpoch(value: unknown): number | null {
  const iso = parseGhTimestamp(value);
  return iso === null ? null : Math.floor(Date.parse(iso) / 1000);
}

export function findPrState(db: DbOrTx, repo: string, prNumber: number): PrStateRow | undefined {
  return db
    .select()
    .from(prState)
    .where(and(eq(prState.repo, repo), eq(prState.prNumber, prNumber)))
    .get();
}

const PR_STATUSES: readonly PrStatus[] = ["open", "merged", "closed"];

/** Read surface for the poller's targeted refresh (and, at SYD-207 cutover,
 * the consumers proper). `status`, when given, must be a valid PrStatus. */
export function listPrState(
  db: Db,
  filter: { repo?: string; status?: string } = {},
): PrStateRow[] {
  if (filter.status !== undefined && !PR_STATUSES.includes(filter.status as PrStatus)) {
    throw new SwitchyardError(
      `Unknown pr_state status "${filter.status}" — expected one of ${PR_STATUSES.join(", ")}.`,
    );
  }
  const conditions = [
    filter.repo !== undefined ? eq(prState.repo, filter.repo) : undefined,
    filter.status !== undefined ? eq(prState.status, filter.status as PrStatus) : undefined,
  ].filter((c) => c !== undefined);
  const query = db.select().from(prState);
  return (conditions.length > 0 ? query.where(and(...conditions)) : query).all();
}

/** issueRef for a PR, or null: strict agent/<ref> branch match, repo bound to
 * that ref's project, and the issue actually exists. */
export function attributedRef(
  db: DbOrTx,
  repo: string,
  branch: string | null | undefined,
): string | null {
  const ref = refFromBranch(branch);
  if (!ref) return null;
  let projectId: number;
  try {
    projectId = getProjectByKey(db, ref.split("-")[0]).id;
  } catch {
    return null;
  }
  const bound = db
    .select({ id: githubRepos.id })
    .from(githubRepos)
    .where(and(eq(githubRepos.fullName, repo), eq(githubRepos.projectId, projectId)))
    .get();
  if (!bound) return null;
  try {
    getIssue(db, ref);
  } catch {
    return null;
  }
  return ref;
}

const EVENT_KIND: Record<PrTransition, string> = {
  opened: "gh_pr_opened",
  merged: "gh_pr_merged",
  closed: "gh_pr_closed",
  reopened: "gh_pr_reopened",
};

type Decision =
  | { apply: true; transition: PrTransition | null }
  | { apply: false; reason: string };

function decide(existing: PrStateRow | undefined, o: PrObservation, ts: number | null): Decision {
  if (!existing) {
    const transition: PrTransition =
      o.status === "open" ? (o.reopened ? "reopened" : "opened") : o.status;
    return { apply: true, transition };
  }
  if (o.status === existing.status) {
    // Same-status refresh: monotonic on ghUpdatedAt, fail-closed without one.
    if (ts === null) return { apply: false, reason: "refresh carries no GitHub timestamp" };
    if (existing.ghUpdatedAt !== null && ts < existing.ghUpdatedAt) {
      return { apply: false, reason: "older than the stored observation" };
    }
    return { apply: true, transition: null };
  }
  if (existing.status === "open") {
    // Terminal transitions are governed by the terminal rules alone, not the
    // monotonic guard — a close/merge must land even if its timestamp lost a
    // race with a same-status refresh.
    return { apply: true, transition: o.status === "merged" ? "merged" : "closed" };
  }
  if (existing.status === "closed" && o.status === "merged") {
    return { apply: true, transition: "merged" };
  }
  if (o.status === "open") {
    if (!o.reopened) {
      return { apply: false, reason: "terminal states never regress on a plain open observation" };
    }
    if (ts === null || existing.ghUpdatedAt === null || ts <= existing.ghUpdatedAt) {
      return {
        apply: false,
        reason: "reopened is not strictly newer than the stored terminal state (fail-closed)",
      };
    }
    return { apply: true, transition: "reopened" };
  }
  return { apply: false, reason: "merged is final" };
}

export function upsertPrState(db: Db, actor: Actor, o: PrObservation): UpsertPrStateOutcome {
  const ts = ghEpoch(o.ghUpdatedAt);
  return db.transaction((tx): UpsertPrStateOutcome => {
    const existing = findPrState(tx, o.repo, o.prNumber);
    const decision = decide(existing, o, ts);
    if (!decision.apply) return { applied: false, transition: null, reason: decision.reason };

    const issueRef = attributedRef(tx, o.repo, o.branch) ?? existing?.issueRef ?? null;

    let lastTransitionEventId = existing?.lastTransitionEventId ?? null;
    if (decision.transition !== null && issueRef !== null) {
      const issueId = getIssue(tx, issueRef).id;
      const kind = EVENT_KIND[decision.transition];
      const ghUpdatedAtIso = parseGhTimestamp(o.ghUpdatedAt);
      const dedupe =
        decision.transition === "reopened"
          ? { jsonPath: "$.ghUpdatedAt", value: ghUpdatedAtIso }
          : { jsonPath: "$.prNumber", value: o.prNumber };
      const duplicate = findEventIdByPayload(tx, issueId, kind, dedupe.jsonPath, dedupe.value);
      if (duplicate !== null) {
        lastTransitionEventId = duplicate;
      } else {
        const payload: Record<string, unknown> = {
          prNumber: o.prNumber,
          url: o.url ?? existing?.url ?? null,
          repo: o.repo,
          headSha: o.headSha ?? existing?.headSha ?? null,
          ghUpdatedAt: ghUpdatedAtIso,
        };
        if (decision.transition === "merged") payload.mergeSha = o.mergeSha ?? null;
        else payload.branch = o.branch ?? existing?.branch ?? null;
        lastTransitionEventId = recordEvent(tx, {
          issueId,
          actorId: actor.id,
          type: kind,
          payload,
        });
      }
    }

    const next = {
      branch: o.branch ?? existing?.branch ?? null,
      issueRef,
      status: o.status,
      headSha: o.headSha ?? existing?.headSha ?? null,
      // Never let a transition with a missing/older timestamp regress the
      // stored freshness marker.
      ghUpdatedAt:
        ts === null ? (existing?.ghUpdatedAt ?? null) : Math.max(ts, existing?.ghUpdatedAt ?? ts),
      url: o.url ?? existing?.url ?? null,
      lastTransitionEventId,
      updatedAt: Math.floor(Date.now() / 1000),
    };
    if (existing) {
      tx.update(prState)
        .set(next)
        .where(and(eq(prState.repo, o.repo), eq(prState.prNumber, o.prNumber)))
        .run();
    } else {
      tx.insert(prState)
        .values({ repo: o.repo, prNumber: o.prNumber, ...next })
        .run();
    }
    return { applied: true, transition: decision.transition };
  });
}
