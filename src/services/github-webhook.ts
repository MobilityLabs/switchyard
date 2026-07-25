// Inbound GitHub webhook handling (SYD-64): turns pull_request/check_suite/push
// deliveries into timeline events on the issue they belong to, so the SYD-54
// delivery strip and activity feed reflect GitHub's own state instead of
// relying on agents to hand-write "merged PR #N" comments. Issues are matched
// by parsing the `agent/<ref>` branch convention (scripts/delivery-lib.ts's
// agentBranch) off the PR/check-suite/push branch first, falling back to
// scanning free text (PR title/body, or commit messages for push) for a bare
// ref — same two signals SYD-64 asked for.
//
// push (SYD-73) records a gh_pushed event (commit count, head sha, compare
// url) rather than folding into the SYD-54 delivery strip — a push isn't a
// state transition like open/merged/closed, so it renders as a plain
// activity-feed line instead of a strip badge.

import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/index.js";
import type { EventKind } from "../db/schema.js";
import { getOrCreateActor } from "./actors.js";
import { getIssue } from "./issues.js";
import { recordEvent } from "./events.js";
import { boundRepoFullNames, normalizeRepoFullName } from "./github-repos.js";
import { upsertPrState, attributedRef, type PrObservation } from "./pr-state.js";

const GITHUB_ACTOR_NAME = "github";

// Only the fields actually read below are declared — these are untrusted
// external payloads (webhook delivery or poller-derived), so unknown extra
// fields are ignored rather than rejected, and every field we read is
// optional/nullable to match what GitHub actually sends across event types.
const pullRequestPayloadSchema = z.object({
  action: z.string().optional(),
  pull_request: z
    .object({
      number: z.union([z.number(), z.string()]).optional(),
      html_url: z.string().optional(),
      merged: z.boolean().optional(),
      merge_commit_sha: z.string().nullable().optional(),
      title: z.string().nullable().optional(),
      body: z.string().nullable().optional(),
      head: z.object({ ref: z.string().optional(), sha: z.string().optional() }).optional(),
      // Deliberately unknown, not string: a malformed timestamp must fail
      // closed to null (parseGhTimestamp), never reject the whole delivery.
      updated_at: z.unknown().optional(),
    })
    .optional(),
});

const pushPayloadSchema = z.object({
  ref: z.string().optional(),
  deleted: z.boolean().optional(),
  after: z.string().optional(),
  compare: z.string().nullable().optional(),
  commits: z.array(z.object({ message: z.string().optional() })).optional(),
});

const checkSuitePayloadSchema = z.object({
  action: z.string().optional(),
  check_suite: z
    .object({
      head_branch: z.string().nullable().optional(),
      head_sha: z.string().nullable().optional(),
      conclusion: z.string().nullable().optional(),
      pull_requests: z
        .array(z.object({ head: z.object({ ref: z.string().optional() }).optional() }))
        .optional(),
    })
    .optional(),
});

const repositoryPayloadSchema = z.object({
  repository: z.object({ full_name: z.string().optional() }).optional(),
});

/** Used before the event type is known, to pick which secret to verify the delivery against. */
export function repositoryFullName(payload: unknown): string | undefined {
  const fullName = repositoryPayloadSchema.safeParse(payload).data?.repository?.full_name;
  return fullName === undefined ? undefined : normalizeRepoFullName(fullName);
}

const AGENT_BRANCH_RE = /^agent\/([A-Z]{2,10}-\d+)$/;
const REF_RE = /\b([A-Z]{2,10}-\d+)\b/;

export function refFromBranch(branch: unknown): string | null {
  if (typeof branch !== "string") return null;
  return AGENT_BRANCH_RE.exec(branch)?.[1] ?? null;
}

export function refFromText(text: unknown): string | null {
  if (typeof text !== "string") return null;
  return REF_RE.exec(text)?.[1] ?? null;
}

function resolveRef(branchCandidates: unknown[], textCandidates: unknown[] = []): string | null {
  for (const c of branchCandidates) {
    const ref = refFromBranch(c);
    if (ref) return ref;
  }
  for (const c of textCandidates) {
    const ref = refFromText(c);
    if (ref) return ref;
  }
  return null;
}

export type GithubWebhookOutcome =
  | { handled: true; ref: string; type: string; duplicate?: true; recorded?: false }
  | { handled: false; reason: string };

/**
 * GitHub timestamps parse fail-closed (SYD-205): a malformed or absent
 * `updated_at` becomes null — "no freshness information" — never "treat as
 * newest". The pr_state monotonic guard (SYD-206) builds on this.
 */
export function parseGhTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return value;
}

/**
 * Dedupe key for a delivery: matches an existing event of the same type on
 * the same issue whose payload already carries this JSON-path value. GitHub
 * redelivers at-least-once and the SYD-71 poller can re-post a derived
 * payload on a schedule, so without this every redelivery would append
 * another gh_pr_opened/gh_pushed/etc and inflate push commit counts.
 */
function isDuplicate(
  db: Db,
  issueId: number,
  type: EventKind,
  jsonPath: string,
  value: string | number | null,
): boolean {
  if (value === null) return false;
  const [row] = db.all<{ hit: number }>(sql`
    SELECT 1 AS hit FROM events
    WHERE issue_id = ${issueId} AND type = ${type} AND json_extract(payload, ${jsonPath}) = ${value}
    LIMIT 1
  `);
  return !!row;
}

const AMBIGUOUS_REPO_REASON =
  "repo is ambiguous — the issue's project has multiple bound repos and the delivery does not name one";

/** Fills in `repo` when the delivery didn't name one (SYD-205 deploy-skew
 * rule): a sole bound repo is unambiguous, several bound repos reject rather
 * than guess, none bound records null (nothing to attribute to). */
function resolveRepo(db: Db, projectId: number, repo: string | null): string | null | "ambiguous" {
  if (repo !== null) return repo;
  const bound = boundRepoFullNames(db, projectId);
  if (bound.length === 1) return bound[0];
  if (bound.length > 1) return "ambiguous";
  return null;
}

function record(
  db: Db,
  ref: string,
  type: EventKind,
  payload: Record<string, unknown>,
  repo: string | null,
  dedupe?: { jsonPath: string; value: string | number | null },
): GithubWebhookOutcome {
  let issue: { id: number; projectId: number };
  try {
    issue = getIssue(db, ref);
  } catch {
    return { handled: false, reason: `no Switchyard issue matches ref ${ref}` };
  }
  const resolvedRepo = resolveRepo(db, issue.projectId, repo);
  if (resolvedRepo === "ambiguous") return { handled: false, reason: AMBIGUOUS_REPO_REASON };
  if (dedupe && isDuplicate(db, issue.id, type, dedupe.jsonPath, dedupe.value)) {
    return { handled: true, ref, type, duplicate: true };
  }
  const actor = getOrCreateActor(db, GITHUB_ACTOR_NAME, "agent");
  recordEvent(db, {
    issueId: issue.id,
    actorId: actor.id,
    type,
    payload: { ...payload, repo: resolvedRepo },
  });
  return { handled: true, ref, type };
}

const PR_ACTIONS = new Set(["opened", "closed", "reopened", "synchronize"]);

function handlePullRequest(db: Db, rawPayload: unknown, repo: string | null): GithubWebhookOutcome {
  const parsed = pullRequestPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) return { handled: false, reason: "malformed pull_request payload" };
  const payload = parsed.data;
  const pr = payload.pull_request;
  if (!pr) return { handled: false, reason: "pull_request payload missing pull_request object" };
  const ref = resolveRef([pr.head?.ref], [pr.title, pr.body]);
  if (!ref) return { handled: false, reason: "no issue ref found in branch, title, or body" };
  const action = payload.action ?? "";
  if (!PR_ACTIONS.has(action)) {
    return { handled: false, reason: `ignored pull_request action "${action}"` };
  }

  const prNumber = Number(pr.number);
  const url = String(pr.html_url ?? "");
  const branch = pr.head?.ref ?? null;
  const headSha = pr.head?.sha ?? null;
  const ghUpdatedAt = parseGhTimestamp(pr.updated_at);

  let issue: { id: number; projectId: number };
  try {
    issue = getIssue(db, ref);
  } catch {
    return { handled: false, reason: `no Switchyard issue matches ref ${ref}` };
  }
  const resolvedRepo = resolveRepo(db, issue.projectId, repo);
  if (resolvedRepo === "ambiguous") return { handled: false, reason: AMBIGUOUS_REPO_REASON };

  // Authoritative path (SYD-206): a strict agent/<ref> branch in the repo
  // bound to that ref's project routes through upsertPrState, which owns the
  // state row AND co-writes the canonical transition event — no direct event
  // write here, so one physical transition never appears twice. Everything
  // else (free-text matches, cross-repo agent branches) records display/audit
  // events only and never touches pr_state.
  const attributed = resolvedRepo !== null && attributedRef(db, resolvedRepo, branch) === ref;
  if (attributed) {
    const actor = getOrCreateActor(db, GITHUB_ACTOR_NAME, "agent");
    const base = {
      repo: resolvedRepo!,
      prNumber,
      url,
      branch,
      headSha,
      ghUpdatedAt,
    };
    if (action === "synchronize") {
      upsertPrState(db, actor, { ...base, status: "open" });
      return { handled: true, ref, type: "synchronize", recorded: false };
    }
    const observation: PrObservation =
      action === "opened"
        ? { ...base, status: "open" }
        : action === "reopened"
          ? { ...base, status: "open", reopened: true }
          : pr.merged
            ? { ...base, status: "merged", mergeSha: pr.merge_commit_sha ?? null }
            : { ...base, status: "closed" };
    const type =
      action === "opened"
        ? "gh_pr_opened"
        : action === "reopened"
          ? "gh_pr_reopened"
          : pr.merged
            ? "gh_pr_merged"
            : "gh_pr_closed";
    const outcome = upsertPrState(db, actor, observation);
    return outcome.transition !== null
      ? { handled: true, ref, type }
      : { handled: true, ref, type, duplicate: true };
  }

  const byPrNumber = { jsonPath: "$.prNumber", value: prNumber };
  if (action === "opened") {
    return record(
      db,
      ref,
      "gh_pr_opened",
      { prNumber, url, branch, headSha, ghUpdatedAt },
      resolvedRepo,
      byPrNumber,
    );
  }
  if (action === "closed") {
    return pr.merged
      ? record(
          db,
          ref,
          "gh_pr_merged",
          { prNumber, url, mergeSha: pr.merge_commit_sha ?? null, headSha, ghUpdatedAt },
          resolvedRepo,
          byPrNumber,
        )
      : record(
          db,
          ref,
          "gh_pr_closed",
          { prNumber, url, headSha, ghUpdatedAt },
          resolvedRepo,
          byPrNumber,
        );
  }
  if (action === "reopened") {
    // A PR can legitimately reopen more than once, so dedupe by GitHub's own
    // timestamp (a redelivery repeats it; a genuine re-reopen carries a newer
    // one) rather than by prNumber.
    return record(
      db,
      ref,
      "gh_pr_reopened",
      { prNumber, url, branch, headSha, ghUpdatedAt },
      resolvedRepo,
      { jsonPath: "$.ghUpdatedAt", value: ghUpdatedAt },
    );
  }
  // synchronize, display-only: acknowledged, nothing recorded — a head
  // refresh on an unattributed PR has no state row to keep fresh.
  return { handled: true, ref, type: "synchronize", recorded: false };
}

function branchFromGitRef(gitRef: unknown): string | null {
  if (typeof gitRef !== "string" || !gitRef.startsWith("refs/heads/")) return null;
  return gitRef.slice("refs/heads/".length);
}

function handlePush(db: Db, rawPayload: unknown, repo: string | null): GithubWebhookOutcome {
  const parsed = pushPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) return { handled: false, reason: "malformed push payload" };
  const payload = parsed.data;
  if (payload.deleted) return { handled: false, reason: "ignored branch-deletion push" };

  const commits = payload.commits ?? [];
  if (commits.length === 0) return { handled: false, reason: "push has no commits" };

  const branch = branchFromGitRef(payload.ref);
  const messages = commits.map((c) => c.message);
  const ref = resolveRef([branch], messages);
  if (!ref) return { handled: false, reason: "no issue ref found in branch or commit messages" };

  const headSha = typeof payload.after === "string" ? payload.after : null;
  return record(
    db,
    ref,
    "gh_pushed",
    {
      commitCount: commits.length,
      headSha,
      branch,
      url: typeof payload.compare === "string" ? payload.compare : null,
    },
    repo,
    { jsonPath: "$.headSha", value: headSha },
  );
}

// Conclusions that actually mean the suite failed. Everything else GitHub can
// report as "completed" — neutral, skipped, cancelled, stale — is either an
// intentionally-skipped check or a non-failure outcome, so it's ignored
// rather than misreported as gh_checks_failed (SYD-194).
const FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "action_required", "startup_failure"]);

function handleCheckSuite(db: Db, rawPayload: unknown, repo: string | null): GithubWebhookOutcome {
  const parsed = checkSuitePayloadSchema.safeParse(rawPayload);
  if (!parsed.success) return { handled: false, reason: "malformed check_suite payload" };
  const payload = parsed.data;
  const suite = payload.check_suite;
  if (!suite) return { handled: false, reason: "check_suite payload missing check_suite object" };
  if (payload.action !== "completed") {
    return { handled: false, reason: `ignored check_suite action "${payload.action}"` };
  }
  const prBranches = (suite.pull_requests ?? []).map((p) => p.head?.ref);
  const ref = resolveRef([suite.head_branch, ...prBranches]);
  if (!ref) return { handled: false, reason: "no issue ref found in check_suite branch" };

  const conclusion = String(suite.conclusion ?? "");
  if (conclusion !== "success" && !FAILING_CONCLUSIONS.has(conclusion)) {
    return { handled: false, reason: `ignored check_suite conclusion "${conclusion}"` };
  }
  const type = conclusion === "success" ? "gh_checks_passed" : "gh_checks_failed";
  const headSha = suite.head_sha ?? null;
  return record(db, ref, type, { conclusion, headSha }, repo, {
    jsonPath: "$.headSha",
    value: headSha,
  });
}

export function handleGithubWebhook(
  db: Db,
  githubEvent: string,
  payload: unknown,
  repo?: string,
): GithubWebhookOutcome {
  // Repo identity (SYD-205): an explicitly named repo (the /github-events
  // top-level field) wins, then the payload's own repository.full_name (real
  // webhook deliveries always carry it), then the sole-bound-repo inference
  // in record() for producers that predate the field. Normalized here (SYD-212)
  // so an explicitly named repo converges on the same casing as one parsed
  // out of the payload, regardless of how the caller typed it.
  const namedRepo = repo !== undefined ? normalizeRepoFullName(repo) : undefined;
  const resolvedRepo = namedRepo ?? repositoryFullName(payload) ?? null;
  switch (githubEvent) {
    case "pull_request":
      return handlePullRequest(db, payload, resolvedRepo);
    case "check_suite":
      return handleCheckSuite(db, payload, resolvedRepo);
    case "push":
      return handlePush(db, payload, resolvedRepo);
    default:
      return { handled: false, reason: `unsupported event type "${githubEvent}"` };
  }
}
