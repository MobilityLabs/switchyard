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

/** Last-seen state per PR number, persisted across ticks so re-polling the
 * same unchanged PR never re-emits an event. */
export type TrackedPr = {
  state: GhPrState;
  lastRunConclusion: string | null;
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
      head: { ref: pr.headRefName },
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
 * Diffs a repo's current PRs (and each open one's latest workflow run, when
 * known) against the last-seen state and returns the events that changed
 * since, plus the updated state to persist.
 *
 * - A PR seen for the first time while OPEN → "opened".
 * - A PR previously tracked OPEN that is no longer OPEN → "closed" (the
 *   payload's `merged` flag distinguishes a merge from a plain close, same
 *   as the real webhook's `pull_request.closed` action).
 * - A PR first observed already CLOSED/MERGED (e.g. the repo was linked
 *   after the PR settled) is recorded but produces no event — we never
 *   witnessed it open, so there's no transition to report.
 * - An OPEN PR whose latest *completed* run conclusion differs from the
 *   last-seen conclusion → "check_suite" (a run still queued/in_progress
 *   never fires; only a conclusion change does, mirroring `check_suite`
 *   only firing on `action: "completed"`).
 *
 * PRs missing from `prs` (e.g. they fell outside the poll window) are left
 * untouched in the returned state rather than dropped.
 */
export function diffRepoState(
  prs: GhPr[],
  runs: Map<number, GhRun | null>,
  prior: RepoPollState
): { events: PollEvent[]; next: RepoPollState } {
  const events: PollEvent[] = [];
  const next: RepoPollState = { ...prior };

  for (const pr of prs) {
    const known = prior[pr.number];
    if (!known) {
      if (pr.state === "OPEN") {
        events.push({ event: "pull_request", payload: prPayload(pr, "opened") });
      }
    } else if (known.state === "OPEN" && pr.state !== "OPEN") {
      events.push({ event: "pull_request", payload: prPayload(pr, "closed") });
    }

    let lastRunConclusion = known?.lastRunConclusion ?? null;
    if (pr.state === "OPEN") {
      const run = runs.get(pr.number);
      if (run && run.status === "completed" && run.conclusion !== lastRunConclusion) {
        events.push({ event: "check_suite", payload: checkSuitePayload(pr, run) });
        lastRunConclusion = run.conclusion;
      }
    }
    next[pr.number] = { state: pr.state, lastRunConclusion };
  }

  return { events, next };
}

export type PollStateFile = Record<string, RepoPollState>; // keyed by repo "owner/repo"

export function parsePollStateText(text: string): PollStateFile {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("github-poll state file must be a JSON object");
  }
  return parsed as PollStateFile;
}
