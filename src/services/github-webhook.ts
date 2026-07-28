// Inbound GitHub webhook handling (SYD-64): turns pull_request/check_suite/push
// deliveries into timeline events on the issue they belong to, so the SYD-54
// delivery strip and activity feed reflect GitHub's own state instead of
// relying on agents to hand-write "merged PR #N" comments.
//
// Two separate questions, deliberately not one (SYD-280/SYD-287):
//
// - WHICH ISSUE'S FEED does a delivery belong on? Parsed, as SYD-64 asked:
//   the `agent/<ref>` branch convention (scripts/delivery-lib.ts's agentBranch)
//   first, then a bare ref in free text (PR title/body, or commit messages for
//   push). This is display, and a string may decide it.
// - IS THE PR ATTRIBUTED to an issue's work? DECLARED, never parsed: a live
//   `delivers` row in pr_links (SYD-280). An `agent/<ref>` branch auto-declares
//   its own link inside upsertPrState, which is why dispatched work needs no
//   extra step; everyone else calls declare_pr_link.
//
// pull_request ingestion answers NEITHER question before writing `pr_state`:
// since SYD-287 every PR in a bound repo is observed, because pr_state records
// what GitHub did to a PR and never whose work it is. An unattributed row is
// inert — see handlePullRequest.
//
// Nothing here may read a ref out of a branch or a PR title to decide what a
// PR *belongs to*. That is the rule SYD-280 exists to enforce (CLAUDE.md).
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
import { getIssue, issueRefById } from "./issues.js";
import { recordEvent } from "./events.js";
import { boundRepoFullNames, findGithubRepo, normalizeRepoFullName } from "./github-repos.js";
import { upsertPrState, attributedRef, type PrObservation } from "./pr-state.js";
import { recordIngestedPrLink, deliversLinkIssueIds } from "./pr-links.js";

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

/**
 * EVERY ref the given strings name, deduped, first-seen order (SYD-274).
 *
 * `refFromText` deliberately takes only the first match, because exactly one
 * ref can own the activity-feed line. But one PR routinely carries several
 * issues' work — `0ae22a9` closed SYD-243 and SYD-244 under SYD-242's PR — and
 * for the refs after the first, the first-match rule meant the board held
 * *nothing at all*: no event, no link, no trace the PR existed. Their
 * `done_without_merged_pr` warnings then had no evidence to reach, which is
 * what left them lit with no path to resolution but archaeology.
 *
 * Same regex, same trust: what this feeds is the `references` suggestion,
 * which gates nothing and proves nothing.
 */
export function refsFromText(texts: unknown[]): string[] {
  const seen = new Set<string>();
  for (const text of texts) {
    if (typeof text !== "string") continue;
    for (const [, ref] of text.matchAll(new RegExp(REF_RE, "g"))) seen.add(ref);
  }
  return [...seen];
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
  // `ref` is null when nothing attributes the PR to an issue — since SYD-287 a
  // PR in a bound repo is observed regardless, so "handled" no longer implies
  // "belongs to someone". Naming an issue anyway would be a guess.
  | { handled: true; ref: string | null; type: string; duplicate?: true; recorded?: false }
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
/** Whether a repo is linked AND bound to a project — the line SYD-287 draws
 * around observation, and the same one `declarePrLink` draws around
 * declaration (`assertRepoBound`). A linked-but-unbound repo is the SYD-207
 * preflight's warning case, deliberately left un-observed so it stays visible
 * rather than silently accruing rows. */
function isBoundRepo(db: Db, repo: string): boolean {
  return findGithubRepo(db, repo)?.projectId != null;
}

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
  // SYD-280: this is the display/free-text path — the ref came from the first
  // REF_RE match in a PR title or body, which anyone can write. It records a
  // `references` link: a suggestion a human may promote, which gates no claim
  // and proves no landing. Never `delivers`.
  //
  // This is the narrowing that closes the false-clear hole: before, ANY
  // gh_pr_merged event cleared done_without_merged_pr (attention.ts), so a PR
  // that merely mentioned an issue silenced its warning permanently.
  if (resolvedRepo !== null && typeof payload.prNumber === "number") {
    recordIngestedPrLink(db, {
      issueId: issue.id,
      repo: resolvedRepo,
      prNumber: payload.prNumber,
      role: "references",
      actorId: actor.id,
    });
  }
  return { handled: true, ref, type };
}

const PR_ACTIONS = new Set(["opened", "closed", "reopened", "synchronize"]);

function handlePullRequest(db: Db, rawPayload: unknown, repo: string | null): GithubWebhookOutcome {
  const parsed = pullRequestPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) return { handled: false, reason: "malformed pull_request payload" };
  const payload = parsed.data;
  const pr = payload.pull_request;
  if (!pr) return { handled: false, reason: "pull_request payload missing pull_request object" };
  const prNumber = Number(pr.number);
  const branch = pr.head?.ref ?? null;
  // The ref the PR's *strings* name — the branch convention first, then the
  // first bare ref in the title or body. Since SYD-280 this decides only what
  // the activity feed shows and which issue gets a `references` suggestion;
  // it decides nothing about attribution.
  const textRef = resolveRef([branch], [pr.title, pr.body]);

  // SYD-287: a PR in a bound repo is worth observing whether or not anything
  // attributes it, so "the text names no issue" stops being a dead end. It is
  // only one when we cannot even identify the repo — resolveRepo's
  // sole-bound-repo inference (SYD-205) needs a project, which only a ref can
  // supply.
  if (textRef === null && !(repo !== null && isBoundRepo(db, repo))) {
    return { handled: false, reason: "no issue ref found in branch, title, or body" };
  }
  const action = payload.action ?? "";
  if (!PR_ACTIONS.has(action)) {
    return { handled: false, reason: `ignored pull_request action "${action}"` };
  }

  const url = String(pr.html_url ?? "");
  const headSha = pr.head?.sha ?? null;
  const ghUpdatedAt = parseGhTimestamp(pr.updated_at);

  // The issue the PR's text names, when it names a real one. Only this path
  // can infer an unnamed repo, and only it records the display events — a
  // declared-but-unmentioned PR has none of either.
  let issue: { ref: string; id: number; projectId: number } | undefined;
  if (textRef !== null) {
    try {
      issue = { ...getIssue(db, textRef), ref: textRef };
    } catch {
      // A ref naming no issue is a dead end only if there is nothing to
      // observe either — a bound repo still has an observation worth keeping.
      if (!(repo !== null && isBoundRepo(db, repo))) {
        return { handled: false, reason: `no Switchyard issue matches ref ${textRef}` };
      }
    }
  }
  const resolvedRepo = issue ? resolveRepo(db, issue.projectId, repo) : repo;
  if (resolvedRepo === "ambiguous") return { handled: false, reason: AMBIGUOUS_REPO_REASON };

  // Resolved rather than named: a legacy producer that omitted `repo` (the
  // SYD-205 deploy-skew path) only learns which repo it meant after the
  // sole-bound-repo inference above.
  const linkedIssueIds =
    resolvedRepo === null ? [] : deliversLinkIssueIds(db, resolvedRepo, prNumber);
  const branchAttributed =
    resolvedRepo !== null && attributedRef(db, resolvedRepo, branch) !== null;

  // OBSERVATION (SYD-206, widened by SYD-287). Every PR in a bound repo, full
  // stop — no branch test, no link test.
  //
  // `pr_state` is keyed (repo, prNumber) and carries no issue identity: it
  // records what GitHub did to a PR, never whose work it is. Gating that on
  // who the PR is attributed to is the same conflation SYD-280 removed one
  // layer up, and it is what made attribution ORDER-DEPENDENT — declare then
  // observe worked, observe then declare needed a later re-observation to
  // heal, and a PR that had dropped out of the poller's window never healed at
  // all. Observing unconditionally retires that class: the row is already
  // there whenever someone declares.
  //
  // Observing is not attributing, and nothing downstream confuses the two. An
  // unattributed row is INERT: every reader in pr-status.ts joins through a
  // live `delivers` link, upsertPrState co-writes its transition event per
  // linked issue, and the cutover backfill reads `issue_ref IS NOT NULL`. So
  // an undeclared PR gets a row, gates nothing, proves nothing, and lands on
  // no issue's timeline.
  //
  // Bound-to-a-project is the line, matching what declarePrLink already
  // enforces. An unbound repo is exactly the misconfiguration the SYD-207
  // preflight warns about, and quietly accumulating rows for one would paper
  // over it.
  const observed = resolvedRepo !== null && isBoundRepo(db, resolvedRepo);
  // Null when nothing attributes the PR: there is genuinely no issue to name,
  // and naming one anyway would be the inference this epic exists to delete.
  const ref = textRef ?? issueRefById(db, linkedIssueIds[0] ?? null);

  let observedOutcome: GithubWebhookOutcome | null = null;
  if (observed) {
    const actor = getOrCreateActor(db, GITHUB_ACTOR_NAME, "agent");
    const base = { repo: resolvedRepo!, prNumber, url, branch, headSha, ghUpdatedAt };
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
    const applied = upsertPrState(db, actor, observation);
    observedOutcome =
      applied.transition !== null
        ? { handled: true, ref, type }
        : { handled: true, ref, type, duplicate: true };
  }

  // DISPLAY. Unchanged, but no longer the observation's else-branch: a PR
  // whose text names some OTHER issue keeps the activity-feed line and the
  // `references` suggestion it has always had, even when a declaration made
  // the PR observable for the issue that actually owns it. Skipped when the
  // text ref's issue already took upsertPrState's canonical co-write, which is
  // what keeps one transition from appearing twice.
  let displayOutcome: GithubWebhookOutcome | null = null;
  if (issue !== undefined && !branchAttributed && !linkedIssueIds.includes(issue.id)) {
    const textOnlyRef = issue.ref;
    const byPrNumber = { jsonPath: "$.prNumber", value: prNumber };
    if (action === "opened") {
      displayOutcome = record(
        db,
        textOnlyRef,
        "gh_pr_opened",
        { prNumber, url, branch, headSha, ghUpdatedAt },
        resolvedRepo,
        byPrNumber,
      );
    } else if (action === "closed") {
      displayOutcome = pr.merged
        ? record(
            db,
            textOnlyRef,
            "gh_pr_merged",
            { prNumber, url, mergeSha: pr.merge_commit_sha ?? null, headSha, ghUpdatedAt },
            resolvedRepo,
            byPrNumber,
          )
        : record(
            db,
            textOnlyRef,
            "gh_pr_closed",
            { prNumber, url, headSha, ghUpdatedAt },
            resolvedRepo,
            byPrNumber,
          );
    } else if (action === "reopened") {
      // A PR can legitimately reopen more than once, so dedupe by GitHub's own
      // timestamp (a redelivery repeats it; a genuine re-reopen carries a newer
      // one) rather than by prNumber.
      displayOutcome = record(
        db,
        textOnlyRef,
        "gh_pr_reopened",
        { prNumber, url, branch, headSha, ghUpdatedAt },
        resolvedRepo,
        { jsonPath: "$.ghUpdatedAt", value: ghUpdatedAt },
      );
    }
  }

  // SIBLING SUGGESTIONS (SYD-274). The display path above serves exactly one
  // ref — the first the text names. Every other ref the PR names got nothing,
  // so an issue whose work landed under a sibling's PR (SYD-243 and SYD-244
  // under SYD-242's, merged as 0ae22a9) showed no trace of that PR anywhere,
  // and its done_without_merged_pr warning had no evidence a human could even
  // navigate to.
  //
  // This mints the same inert `references` suggestion the primary ref has
  // always had, for the rest of them. Deliberately NOT `delivers`, and
  // deliberately not a gh_pr_merged event: recording either from PR prose is
  // the false-clear hole SYD-280 closed, and it would let anyone silence a
  // safety net by typing a ref. What clears the warning is unchanged — a
  // human-confirmed `delivers` link, or SYD-262's human resolve. The point is
  // to make the evidence reachable, not to decide on the human's behalf.
  //
  // Same project only. A ref from another project would carry its own repo
  // binding, and minting a link across that boundary from free text is a
  // guess this epic exists to delete.
  if (issue !== undefined && resolvedRepo !== null) {
    const primaryIssue = issue;
    const actor = getOrCreateActor(db, GITHUB_ACTOR_NAME, "agent");
    for (const siblingRef of refsFromText([pr.title, pr.body])) {
      if (siblingRef === primaryIssue.ref) continue;
      let sibling;
      try {
        sibling = getIssue(db, siblingRef);
      } catch {
        continue; // names no real issue
      }
      if (sibling.projectId !== primaryIssue.projectId) continue;
      recordIngestedPrLink(db, {
        issueId: sibling.id,
        repo: resolvedRepo,
        prNumber,
        role: "references",
        actorId: actor.id,
      });
    }
  }

  // The observation is the more meaningful answer when both halves ran (a
  // declared PR that also mentions some other issue), so it wins the single
  // return slot; the display write already happened either way. Falling
  // through to neither means synchronize on an unattributed PR: acknowledged,
  // nothing recorded — there is no state row to keep fresh.
  return (
    observedOutcome ??
    displayOutcome ?? { handled: true, ref, type: "synchronize", recorded: false }
  );
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
