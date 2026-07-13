// Pure logic for the GitHub polling fallback (SYD-71): decides, from a
// repo's current pull requests and each open one's latest workflow run,
// which pull_request/check_suite webhook-shaped events to emit. The shapes
// match exactly what a real GitHub webhook delivery carries, so POSTing them
// to POST /api/github-events (src/rest/api-routes.ts) runs through the same
// matching/recording logic src/services/github-webhook.ts (SYD-64) already
// has — this polling path and the real webhook converge on one place instead
// of growing a second copy of the ref-matching/event-recording rules.
//
// I/O-free so it's trivially unit-testable; scripts/github-poll-exec.ts does
// the actual `gh` calls and scripts/github-poll.ts sequences the tick loop —
// same split as delivery-lib.ts / delivery-exec.ts / deliver.ts.

export type GhPrState = "OPEN" | "CLOSED" | "MERGED";

/** The subset of `gh pr list --json ...` fields the diff needs. */
export type GhPr = {
  number: number;
  headRefName: string;
  headRefOid: string;
  updatedAt: string;
  title: string;
  body: string | null;
  url: string;
  state: GhPrState;
  mergeCommit: { oid: string } | null;
};

/** The subset of `gh run list --json ...` fields the diff needs. */
export type GhRun = {
  headSha: string;
  status: string; // "completed" | "in_progress" | "queued" | ...
  conclusion: string | null; // set once status is "completed"
  url: string;
};

/** Last-seen state per PR number, persisted across ticks. Since SYD-206 the
 * pull_request observation is NOT gated on this (every seen PR re-emits and
 * the server's upsert/dedupe absorbs repeats) — it still gates check_suite
 * conclusions (fire once per change) and carries the targeted-refresh
 * bookkeeping for open pr_state rows outside the poll window. */
export type TrackedPr = {
  state: GhPrState;
  lastRunConclusion: string | null;
  /** Last targeted `gh pr view` attempt (ms epoch) — refreshes run on a
   * slower cadence than the tick. */
  lastRefreshAt?: number;
  /** Consecutive targeted-refresh failures; past a threshold the poller
   * raises the staleness alarm (and never transitions state on error). */
  refreshFailures?: number;
};

export type RepoPollState = Record<number, TrackedPr>;

export type PollEvent =
  | { event: "pull_request"; payload: Record<string, unknown> }
  | { event: "check_suite"; payload: Record<string, unknown> };

function prPayload(pr: GhPr, action: "opened" | "closed"): Record<string, unknown> {
  return {
    action,
    pull_request: {
      number: pr.number,
      html_url: pr.url,
      // head.sha + updated_at keep poll-only repos' headSha/ghUpdatedAt fresh
      // (SYD-205) — same shape a real webhook delivery carries.
      head: { ref: pr.headRefName, sha: pr.headRefOid },
      updated_at: pr.updatedAt,
      title: pr.title,
      body: pr.body,
      merged: pr.state === "MERGED",
      merge_commit_sha: pr.mergeCommit?.oid ?? null,
    },
  };
}

function checkSuitePayload(pr: GhPr, run: GhRun): Record<string, unknown> {
  return {
    action: "completed",
    check_suite: {
      head_branch: pr.headRefName,
      head_sha: run.headSha,
      conclusion: run.conclusion,
      pull_requests: [{ head: { ref: pr.headRefName } }],
    },
  };
}

/**
 * Upsert-observed-state (SYD-206, replacing the old emit-transitions diff):
 * EVERY PR in the poll result yields a pull_request observation on every
 * tick — "opened" for OPEN, "closed" (with the `merged` flag) for
 * CLOSED/MERGED, including PRs first observed already terminal. The server's
 * upsertPrState/dedupe absorbs repeats, so a lost POST heals within one tick
 * and a repo linked after its PRs settled still gets correct terminal state
 * (never-saw-open heal) — this is what deletes the SYD-94 reconcile pass.
 *
 * check_suite stays state-gated: an OPEN PR whose latest *completed* run
 * conclusion differs from the last-seen conclusion fires once per change.
 *
 * PRs missing from `prs` (fell outside the poll window) are left untouched in
 * the returned state rather than dropped — absence is not evidence; the
 * targeted refresh below covers open rows beyond the window.
 */
export function observeRepoState(
  prs: GhPr[],
  runs: Map<number, GhRun | null>,
  prior: RepoPollState,
): { events: PollEvent[]; next: RepoPollState } {
  const events: PollEvent[] = [];
  const next: RepoPollState = { ...prior };

  for (const pr of prs) {
    const known = prior[pr.number];
    events.push({
      event: "pull_request",
      payload: prPayload(pr, pr.state === "OPEN" ? "opened" : "closed"),
    });

    let lastRunConclusion = known?.lastRunConclusion ?? null;
    if (pr.state === "OPEN") {
      const run = runs.get(pr.number);
      if (run && run.status === "completed" && run.conclusion !== lastRunConclusion) {
        events.push({ event: "check_suite", payload: checkSuitePayload(pr, run) });
        lastRunConclusion = run.conclusion;
      }
    }
    next[pr.number] = { ...known, state: pr.state, lastRunConclusion };
  }

  return { events, next };
}

/**
 * Which open pr_state rows deserve a targeted `gh pr view` this tick: they
 * are absent from the poll window (so the tick itself won't refresh them) and
 * haven't been attempted within `intervalMs` (the refresh runs on a slower
 * cadence than the tick — it burns a GitHub API call per PR).
 */
export function selectRefreshCandidates(
  openRowNumbers: number[],
  windowNumbers: Set<number>,
  state: RepoPollState,
  nowMs: number,
  intervalMs: number,
): number[] {
  return openRowNumbers.filter((n) => {
    if (windowNumbers.has(n)) return false;
    const lastRefreshAt = state[n]?.lastRefreshAt;
    return lastRefreshAt === undefined || nowMs - lastRefreshAt > intervalMs;
  });
}

/** Strict agent branch shape — must stay in lockstep with the server's
 * refFromBranch (src/services/github-webhook.ts): upsertPrState only ever
 * attributes rows whose branch matches this. */
const AGENT_BRANCH_RE = /^agent\/([A-Z]{2,10}-\d+)$/;

export type LinkedRepoBinding = { fullName: string; projectId: number | null };

/**
 * Cutover preflight (SYD-207): every worker-configured project's repo must be
 * linked AND bound to that project (`github_repos.projectId` is nullable —
 * an unbound repo silently turns real agent PRs into display-only rows and
 * blinds the claim gate). Returns one problem string per broken project;
 * a non-empty result blocks the backfill and, from the poller's periodic
 * check, is logged loudly so a post-cutover unbinding is caught too.
 */
export function preflightRepoBindings(
  configured: { projectKey: string; repo: string }[],
  linked: LinkedRepoBinding[],
  serverProjects: { id: number; key: string }[],
): string[] {
  const projectIdByKey = new Map(serverProjects.map((p) => [p.key, p.id]));
  const problems: string[] = [];
  for (const { projectKey, repo } of configured) {
    const projectId = projectIdByKey.get(projectKey);
    if (projectId === undefined) {
      problems.push(`project "${projectKey}" (repo ${repo}) does not exist on the server`);
      continue;
    }
    const row = linked.find((l) => l.fullName === repo);
    if (!row) {
      problems.push(
        `project "${projectKey}": repo ${repo} is not linked — add it via POST /api/github-repos with projectKey "${projectKey}"`,
      );
    } else if (row.projectId === null) {
      problems.push(
        `project "${projectKey}": repo ${repo} is linked but not bound to a project — its agent PRs are display-only and never gate claims; re-link it with projectKey "${projectKey}"`,
      );
    } else if (row.projectId !== projectId) {
      problems.push(
        `project "${projectKey}": repo ${repo} is bound to a different project (id ${row.projectId}, expected ${projectId})`,
      );
    }
  }
  return problems;
}

/**
 * Backfill work selection (SYD-207): which windowed PRs are agent PRs worth
 * upserting, and which agent branches still need a targeted `gh pr list
 * --head` lookup. Lookups happen ONLY when the window returned exactly
 * `windowLimit` rows — a shorter result means the repo's entire PR history
 * fit in the window, so a beyond-window PR (the SYD-179 shape) cannot exist.
 */
export function selectBackfillWork(
  windowPrs: GhPr[],
  windowLimit: number,
  issueRefs: string[],
): { agentPrs: GhPr[]; lookupBranches: string[] } {
  const agentPrs = windowPrs.filter((pr) => AGENT_BRANCH_RE.test(pr.headRefName));
  if (windowPrs.length < windowLimit) return { agentPrs, lookupBranches: [] };
  const covered = new Set(windowPrs.map((pr) => pr.headRefName));
  const lookupBranches = issueRefs
    .map((ref) => `agent/${ref}`)
    .filter((branch) => !covered.has(branch));
  return { agentPrs, lookupBranches };
}

export type PollStateFile = Record<string, RepoPollState>; // keyed by repo "owner/repo"

export function parsePollStateText(text: string): PollStateFile {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("github-poll state file must be a JSON object");
  }
  return parsed as PollStateFile;
}
