// Inbound GitHub webhook handling (SYD-64): turns pull_request/check_suite
// deliveries into timeline events on the issue they belong to, so the SYD-54
// delivery strip reflects GitHub's own state instead of relying on agents to
// hand-write "merged PR #N" comments. Issues are matched by parsing the
// `agent/<ref>` branch convention (scripts/delivery-lib.ts's agentBranch)
// off the PR/check-suite branch first, falling back to scanning the PR
// title/body for a bare ref — same two signals SYD-64 asked for.
//
// `push` events are accepted (so GitHub's delivery doesn't show as failing)
// but not turned into timeline events yet — there's no push-derived event
// type in the SYD-54 status panel to drive. Filed as a follow-up.

import type { Db } from "../db/index.js";
import { getOrCreateActor } from "./actors.js";
import { getIssue } from "./issues.js";
import { recordEvent } from "./events.js";

const GITHUB_ACTOR_NAME = "github";

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
  | { handled: true; ref: string; type: string }
  | { handled: false; reason: string };

function record(db: Db, ref: string, type: string, payload: Record<string, unknown>): GithubWebhookOutcome {
  let issueId: number;
  try {
    issueId = getIssue(db, ref).id;
  } catch {
    return { handled: false, reason: `no Switchyard issue matches ref ${ref}` };
  }
  const actor = getOrCreateActor(db, GITHUB_ACTOR_NAME, "agent");
  recordEvent(db, { issueId, actorId: actor.id, type, payload });
  return { handled: true, ref, type };
}

function handlePullRequest(db: Db, payload: any): GithubWebhookOutcome {
  const pr = payload?.pull_request;
  if (!pr) return { handled: false, reason: "pull_request payload missing pull_request object" };
  const ref = resolveRef([pr.head?.ref], [pr.title, pr.body]);
  if (!ref) return { handled: false, reason: "no issue ref found in branch, title, or body" };

  const prNumber = Number(pr.number);
  const url = String(pr.html_url ?? "");

  if (payload.action === "opened") {
    return record(db, ref, "gh_pr_opened", { prNumber, url, branch: pr.head?.ref ?? null });
  }
  if (payload.action === "closed") {
    return pr.merged
      ? record(db, ref, "gh_pr_merged", { prNumber, url, mergeSha: pr.merge_commit_sha ?? null })
      : record(db, ref, "gh_pr_closed", { prNumber, url });
  }
  return { handled: false, reason: `ignored pull_request action "${payload.action}"` };
}

function handleCheckSuite(db: Db, payload: any): GithubWebhookOutcome {
  const suite = payload?.check_suite;
  if (!suite) return { handled: false, reason: "check_suite payload missing check_suite object" };
  if (payload.action !== "completed") {
    return { handled: false, reason: `ignored check_suite action "${payload.action}"` };
  }
  const prBranches = Array.isArray(suite.pull_requests) ? suite.pull_requests.map((p: any) => p?.head?.ref) : [];
  const ref = resolveRef([suite.head_branch, ...prBranches]);
  if (!ref) return { handled: false, reason: "no issue ref found in check_suite branch" };

  const conclusion = String(suite.conclusion ?? "");
  const type = conclusion === "success" ? "gh_checks_passed" : "gh_checks_failed";
  return record(db, ref, type, { conclusion, headSha: suite.head_sha ?? null });
}

export function handleGithubWebhook(db: Db, githubEvent: string, payload: any): GithubWebhookOutcome {
  switch (githubEvent) {
    case "pull_request":
      return handlePullRequest(db, payload);
    case "check_suite":
      return handleCheckSuite(db, payload);
    case "push":
      return { handled: false, reason: "push events are accepted but not processed yet" };
    default:
      return { handled: false, reason: `unsupported event type "${githubEvent}"` };
  }
}
