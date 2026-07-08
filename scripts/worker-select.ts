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

export type WorkerConfig = {
  url: string;
  label: string;
  intervalSeconds: number;
  /** How often to scan the event feed for answered escalations (default 15s). */
  eventPollSeconds?: number;
  maxConcurrent: number;
  projects: Record<string, { repo: string }>;
  allowedTools?: string[];
};

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
    if (!issue.labels.includes(config.label)) continue;
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
