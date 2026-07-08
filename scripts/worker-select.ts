// Pure dispatch-selection logic for scripts/agent-worker.ts.
// Kept separate from the polling/spawning loop so it's trivially unit-testable.

/** The subset of an /api/issues row the selector needs. */
export type WorkerIssue = {
  ref: string; // "<PROJECT>-<number>"
  labels: string[];
  assigneeId: number | null;
  needsInput: boolean;
  updatedAt: number;
};

export type WorkerProject = { repo: string };

export type WorkerConfig = {
  url: string;
  label: string;
  intervalSeconds: number;
  /** How often to scan the event feed for answered escalations (default 15s). */
  eventPollSeconds?: number;
  maxConcurrent: number;
  projects: Record<string, WorkerProject>;
  allowedTools?: string[];
  dispatchPolicy?: "labeled" | "all-todo";
  /** Run dispatched sessions in a Docker container instead of bare on the host. */
  containerized?: boolean;
  /** Image to run when `containerized` is set. Defaults to "switchyard-worker". */
  image?: string;
  /**
   * How sessions are spun up: "cli" shells out to `claude -p` (bare or in
   * Docker per `containerized`); "sdk" runs in-process via the Claude Agent
   * SDK (worker-sdk/ must be installed; incompatible with `containerized`).
   */
  runner?: "cli" | "sdk";
};

const DEFAULT_ALLOWED_TOOLS = ["mcp__switchyard__*", "Bash", "Read", "Edit", "Write", "Grep", "Glob"];
const DEFAULT_WORKER_IMAGE = "switchyard-worker";

export function projectKeyOf(ref: string): string {
  return ref.split("-")[0];
}

/**
 * Filter a list of `todo` issues down to the ones the worker should dispatch this
 * tick: carries the configured label, belongs to a configured project, is
 * unassigned, doesn't need human input, isn't already running, and fits within
 * remaining maxConcurrent capacity (existing active dispatches + newly
 * selected <= maxConcurrent).
 */
export function selectDispatchable<T extends WorkerIssue>(
  issues: T[],
  config: WorkerConfig,
  activeRefs: Iterable<string>
): T[] {
  const active = new Set(activeRefs);
  const capacity = config.maxConcurrent - active.size;
  if (capacity <= 0) return [];

  const selected: T[] = [];
  for (const issue of issues) {
    if (selected.length >= capacity) break;
    if ((config.dispatchPolicy ?? "labeled") === "labeled") {
      // Opt-in: only issues a human explicitly labeled for dispatch.
      if (!issue.labels.includes(config.label)) continue;
    } else {
      // all-todo: every vetted-ready issue is fair game unless held back.
      if (issue.labels.includes("hold")) continue;
    }
    if (!(projectKeyOf(issue.ref) in config.projects)) continue;
    if (issue.assigneeId !== null) continue;
    if (issue.needsInput) continue;
    if (active.has(issue.ref)) continue;
    selected.push(issue);
  }
  return selected;
}

/** The subset of a GET /api/events row the resume trigger needs. */
export type FeedEvent = {
  id: number;
  type: string;
  issue: string; // "<PROJECT>-<number>"
};

/**
 * Scans the global event feed for `needs_input_cleared` events newer than
 * `lastEventId` on configured projects — each one means a human just answered
 * an escalation and the issue should be re-dispatched without waiting for the
 * next full poll. Returns the distinct refs to resume plus the advanced
 * cursor. A null cursor means "first look at the feed": it initializes to the
 * newest event id without triggering on history, so a worker restart never
 * re-fires old answers.
 */
export function findResumeRefs(
  feed: FeedEvent[],
  config: WorkerConfig,
  lastEventId: number | null
): { refs: string[]; lastEventId: number | null } {
  if (feed.length === 0) return { refs: [], lastEventId };
  const newestId = Math.max(...feed.map((e) => e.id));
  if (lastEventId === null) return { refs: [], lastEventId: newestId };

  const refs = new Set<string>();
  for (const e of feed) {
    if (e.id <= lastEventId) continue;
    if (e.type !== "needs_input_cleared") continue;
    if (!(projectKeyOf(e.issue) in config.projects)) continue;
    refs.add(e.issue);
  }
  return { refs: [...refs], lastEventId: Math.max(newestId, lastEventId) };
}

/**
 * Coordinates re-entrant calls to a single-flight async task (agent-worker's
 * tick): at most one invocation of `fn` runs at a time. A call that arrives
 * while one is already running doesn't run `fn` itself — it marks a re-run
 * as queued, and the in-flight call replays `fn` once more immediately after
 * it finishes. This is what lets the event poll's resume trigger land a
 * dispatch even when it arrives mid-tick, instead of being silently dropped
 * until the next periodic tick (up to `intervalSeconds` later).
 */
export type TickGate = { inFlight: boolean; queued: boolean };

export function newTickGate(): TickGate {
  return { inFlight: false, queued: false };
}

export async function runGated(gate: TickGate, fn: () => Promise<void>): Promise<void> {
  if (gate.inFlight) {
    gate.queued = true;
    return;
  }
  gate.inFlight = true;
  try {
    await fn();
  } finally {
    gate.inFlight = false;
    if (gate.queued) {
      gate.queued = false;
      void runGated(gate, fn).catch((err) => console.error(`re-armed tick failed: ${(err as Error).message}`));
    }
  }
}

/** Per-ref dispatch-attempt tracking, kept in memory by the polling loop. */
export type RetryState = { attempts: number; lastUpdatedAt: number };

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Filters out refs that have been dispatched `maxAttempts` times in a row with
 * no change to the issue's `updatedAt` since the last attempt — a sign of an
 * escalate -> stale-release -> re-dispatch loop rather than real progress. If
 * the issue's `updatedAt` has moved past the recorded attempt, it's treated as
 * fresh work and is never capped (the caller resets the counter via
 * `recordAttempt`). Logs when it parks a ref.
 */
export function filterRetryCapped<T extends WorkerIssue>(
  issues: T[],
  retryState: ReadonlyMap<string, RetryState>,
  maxAttempts = DEFAULT_MAX_ATTEMPTS
): T[] {
  return issues.filter((issue) => {
    const state = retryState.get(issue.ref);
    if (!state || state.lastUpdatedAt !== issue.updatedAt) return true;
    if (state.attempts >= maxAttempts) {
      console.log(
        `parking ${issue.ref}: ${state.attempts} dispatch attempts with no change since the last one`
      );
      return false;
    }
    return true;
  });
}

/**
 * Records a dispatch attempt for `ref` in `retryState`: increments the
 * attempt counter if the issue's `updatedAt` matches the last recorded
 * attempt, otherwise starts a fresh count at 1 for the new `updatedAt`.
 * Mutates `retryState` in place.
 */
export function recordAttempt(retryState: Map<string, RetryState>, ref: string, updatedAt: number): void {
  const state = retryState.get(ref);
  if (state && state.lastUpdatedAt === updatedAt) {
    retryState.set(ref, { attempts: state.attempts + 1, lastUpdatedAt: updatedAt });
  } else {
    retryState.set(ref, { attempts: 1, lastUpdatedAt: updatedAt });
  }
}

/**
 * Prompt for a containerized dispatch: same conventions as the bare-host
 * prompt, plus the branch/push contract the container's entrypoint enforces
 * (see scripts/container-entry.sh) — the session must commit its work so the
 * entrypoint has something to push, and must name the branch in its comment
 * since the human reviewing has no other way to find it.
 */
export function buildContainerizedPrompt(ref: string, opts: { resumed?: boolean } = {}): string {
  const resumedPreamble = opts.resumed
    ? `You previously escalated a question on Switchyard issue ${ref} and a human ` +
      `has now answered it. Call get_issue first and read the activity feed for ` +
      `the answer, then continue the work from where the escalation left off. `
    : "";
  return (
    resumedPreamble +
    `Work Switchyard issue ${ref} using the switchyard MCP tools. ` +
    `Call claim_issue first. Implement the work with tests. Comment verification ` +
    `evidence describing what you did and how you verified it, then move the issue ` +
    `to in_review. Never move it to done — a human or review step does that. ` +
    `If you are blocked on a decision only a human can make, call request_human_input ` +
    `with your question and stop. You are in a disposable clone on branch agent/${ref}; ` +
    `commit your work — it will be pushed for review. The issue comment MUST include ` +
    `the branch name.`
  );
}

/**
 * Builds the `docker run` argv for a containerized dispatch. Pure so it's
 * unit-testable without actually spawning docker. Secrets (SWITCHYARD_TOKEN,
 * CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY) are passed with the bare `-e
 * VAR` form so their values flow through from the worker's own environment
 * at `docker run` time rather than being embedded in argv (which would be
 * visible to anything that can read the process list). Only non-secret
 * values (issue ref, switchyard URL, prompt, tool allowlist) are embedded
 * directly.
 *
 * Throws if neither auth env var is present, so a misconfigured worker fails
 * before spinning up a container that would just fail the same check inside
 * scripts/container-entry.sh.
 */
export function buildDockerArgs(
  issue: WorkerIssue,
  project: WorkerProject,
  config: WorkerConfig,
  env: NodeJS.ProcessEnv,
  opts: { resumed?: boolean } = {}
): string[] {
  if (!env.CLAUDE_CODE_OAUTH_TOKEN && !env.ANTHROPIC_API_KEY) {
    throw new Error(
      "containerized dispatch requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in the worker's environment"
    );
  }

  const allowedTools = config.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
  const prompt = buildContainerizedPrompt(issue.ref, opts);
  const image = config.image ?? DEFAULT_WORKER_IMAGE;

  return [
    "run",
    "--rm",
    "--name", `syd-${issue.ref}`,
    "-v", `${project.repo}:/origin`,
    "-e", `ISSUE_REF=${issue.ref}`,
    "-e", `SWITCHYARD_URL=${config.url}`,
    "-e", "SWITCHYARD_TOKEN",
    "-e", "CLAUDE_CODE_OAUTH_TOKEN",
    "-e", "ANTHROPIC_API_KEY",
    "-e", `WORKER_PROMPT=${prompt}`,
    "-e", `ALLOWED_TOOLS=${allowedTools.join(",")}`,
    image,
  ];
}
