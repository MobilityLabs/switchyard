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
import { getOrCreateActor } from "./actors.js";
import { getIssue } from "./issues.js";
import { recordEvent } from "./events.js";

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
      head: z.object({ ref: z.string().optional() }).optional(),
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
  return repositoryPayloadSchema.safeParse(payload).data?.repository?.full_name;
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
  | { handled: true; ref: string; type: string; duplicate?: true }
  | { handled: false; reason: string };

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
  type: string,
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

function record(
  db: Db,
  ref: string,
  type: string,
  payload: Record<string, unknown>,
  dedupe?: { jsonPath: string; value: string | number | null },
): GithubWebhookOutcome {
  let issueId: number;
  try {
    issueId = getIssue(db, ref).id;
  } catch {
    return { handled: false, reason: `no Switchyard issue matches ref ${ref}` };
  }
  if (dedupe && isDuplicate(db, issueId, type, dedupe.jsonPath, dedupe.value)) {
    return { handled: true, ref, type, duplicate: true };
  }
  const actor = getOrCreateActor(db, GITHUB_ACTOR_NAME, "agent");
  recordEvent(db, { issueId, actorId: actor.id, type, payload });
  return { handled: true, ref, type };
}

function handlePullRequest(db: Db, rawPayload: unknown): GithubWebhookOutcome {
  const parsed = pullRequestPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) return { handled: false, reason: "malformed pull_request payload" };
  const payload = parsed.data;
  const pr = payload.pull_request;
  if (!pr) return { handled: false, reason: "pull_request payload missing pull_request object" };
  const ref = resolveRef([pr.head?.ref], [pr.title, pr.body]);
  if (!ref) return { handled: false, reason: "no issue ref found in branch, title, or body" };

  const prNumber = Number(pr.number);
  const url = String(pr.html_url ?? "");

  const byPrNumber = { jsonPath: "$.prNumber", value: prNumber };
  if (payload.action === "opened") {
    return record(
      db,
      ref,
      "gh_pr_opened",
      { prNumber, url, branch: pr.head?.ref ?? null },
      byPrNumber,
    );
  }
  if (payload.action === "closed") {
    return pr.merged
      ? record(
          db,
          ref,
          "gh_pr_merged",
          { prNumber, url, mergeSha: pr.merge_commit_sha ?? null },
          byPrNumber,
        )
      : record(db, ref, "gh_pr_closed", { prNumber, url }, byPrNumber);
  }
  return { handled: false, reason: `ignored pull_request action "${payload.action}"` };
}

function branchFromGitRef(gitRef: unknown): string | null {
  if (typeof gitRef !== "string" || !gitRef.startsWith("refs/heads/")) return null;
  return gitRef.slice("refs/heads/".length);
}

function handlePush(db: Db, rawPayload: unknown): GithubWebhookOutcome {
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
    { jsonPath: "$.headSha", value: headSha },
  );
}

function handleCheckSuite(db: Db, rawPayload: unknown): GithubWebhookOutcome {
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
  const type = conclusion === "success" ? "gh_checks_passed" : "gh_checks_failed";
  const headSha = suite.head_sha ?? null;
  return record(db, ref, type, { conclusion, headSha }, { jsonPath: "$.headSha", value: headSha });
}

export function handleGithubWebhook(
  db: Db,
  githubEvent: string,
  payload: unknown,
): GithubWebhookOutcome {
  switch (githubEvent) {
    case "pull_request":
      return handlePullRequest(db, payload);
    case "check_suite":
      return handleCheckSuite(db, payload);
    case "push":
      return handlePush(db, payload);
    default:
      return { handled: false, reason: `unsupported event type "${githubEvent}"` };
  }
}
