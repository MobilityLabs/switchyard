// Pure dispatch-selection logic for scripts/agent-worker.ts.
// Kept separate from the polling/spawning loop so it's trivially unit-testable.

/** The subset of an /api/issues row the selector needs. */
export type WorkerIssue = {
  ref: string; // "<PROJECT>-<number>"
  labels: string[];
  assigneeId: number | null;
};

export type WorkerConfig = {
  url: string;
  label: string;
  intervalSeconds: number;
  maxConcurrent: number;
  projects: Record<string, { repo: string }>;
};

export function projectKeyOf(ref: string): string {
  return ref.split("-")[0];
}

/**
 * Filter a list of `todo` issues down to the ones the worker should dispatch this
 * tick: carries the configured label, belongs to a configured project, is
 * unassigned, isn't already running, and fits within remaining maxConcurrent
 * capacity (existing active dispatches + newly selected <= maxConcurrent).
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
    if (active.has(issue.ref)) continue;
    selected.push(issue);
  }
  return selected;
}
