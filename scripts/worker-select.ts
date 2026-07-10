// Pure dispatch-selection logic for scripts/agent-worker.ts.
// Kept separate from the polling/spawning loop so it's trivially unit-testable.

/** The subset of an /api/issues row the selector needs. */
export type WorkerIssue = {
  ref: string; // "<PROJECT>-<number>"
  labels: string[];
  assigneeId: number | null;
  needsInput: boolean;
  updatedAt: number;
  /**
   * Set when the issue already has an open agent PR (SYD-99: a pr_opened or
   * gh_pr_opened event with no later merge/close — see
   * src/services/pr-status.ts). Dispatch must skip these even when
   * assigneeId is null, e.g. a stale claim released back to todo while its
   * PR is still unmerged — dispatching again would just race the open PR.
   */
  openPr?: { prNumber: number; url: string } | null;
  /**
   * True when the issue has at least one open (not done/canceled) blocker
   * (SYD-160: the /api/issues feed computes this via listBlockedIssueIds).
   * Dispatch must skip these — claimIssue would refuse a blocked issue anyway,
   * so dispatching one only burns a session that discovers the blocker and
   * escalates. Optional so older feeds (and test fixtures) default to unblocked.
   */
  blocked?: boolean;
  /**
   * The issue's priority, used to order candidates so dispatch honors priority
   * (SYD-160) — mirrors next_task's PRIORITY_RANK. Optional/unknown values sort
   * last (see priorityRank).
   */
  priority?: string;
  /** Creation timestamp, the oldest-first tiebreak within a priority (SYD-160). */
  createdAt?: number;
};

/**
 * Priority ordering for dispatch selection (SYD-160), mirroring the SQL
 * PRIORITY_RANK in src/services/dependencies.ts: urgent first, then high,
 * medium, low, and anything unset/unknown last.
 */
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

function priorityRank(priority: string | undefined): number {
  return priority !== undefined && priority in PRIORITY_RANK ? PRIORITY_RANK[priority] : 4;
}

/** One extra CLI tool a project's dispatched sessions need beyond the baseline (git, node, claude). */
export type WorkerStackCli = {
  /** Human-readable name, shown in doctor output and session-start failures. */
  name: string;
  /** Shell command that exits 0 iff the tool is present, e.g. "codex --version". */
  check: string;
  /** Shell command that installs/repairs it — shown as a hint; run by `--repair-stack`. */
  install?: string;
};

/**
 * Per-project toolchain declaration (SYD-76): what dispatched sessions for
 * this project need beyond the worker image's baseline, so gaps (missing
 * CLI, wrong Node version) surface as a clear doctor/session-start failure
 * instead of a mid-task ENOENT.
 */
export type WorkerStack = {
  /** Minimum Node.js major version the session needs, e.g. "20". */
  node?: string;
  /** Extra CLIs the session needs beyond git/node/claude. */
  cli?: WorkerStackCli[];
  /** Ports the session may need to bind. Informational only — not yet enforced. */
  ports?: number[];
};

export type WorkerProject = {
  repo: string;
  stack?: WorkerStack;
  /** Integration branch containerized dispatch bases agent/<ref> on (default "main"). */
  baseBranch?: string;
};

export type DeliveryConfig = {
  /** Open a GitHub PR when a containerized session pushes agent/<ref> (default true). */
  openPrs?: boolean;
  /** How often deliver.ts scans the event feed for human done-stamps (default 30s). */
  pollSeconds?: number;
  /** Where deliver.ts keeps its clean deploy clones (default ~/.switchyard/deliver-clones). */
  cloneDir?: string;
  /** Run the merged project's `npm run deploy` after merging (default true). */
  deploy?: boolean;
  /**
   * After merging, run `npm run typecheck && npx vitest run` in the clean
   * clone (i.e. against merged main, not just the reviewed branch) before
   * deploying (default true). On failure, deploy is skipped and a loud
   * `delivery_failed` event/comment is posted instead — main is red but
   * visibly red, rather than silently shipped.
   */
  verify?: boolean;
  /** On merge failure, try a mechanical rebase-onto-main + verify + retry
   * before escalating to a human (default true). SYD-85. */
  autoRebase?: boolean;
  /** Each tick, check issues flagged `delivery_failed` for a PR that was
   * actually merged manually and clear the stale attention flag (default
   * true). SYD-94. */
  reconcile?: boolean;
  /**
   * When autoRebase hits real conflict hunks, dispatch a one-shot
   * conflict-resolution worker session (same container image as code
   * dispatch) instead of escalating straight to a human (default true).
   * SYD-100. Only takes effect when `containerized` is also set — resolution
   * needs the same clone-in/branch-out sandbox as ordinary work dispatch.
   */
  conflictResolution?: boolean;
};

export type GithubPollConfig = {
  /** How often github-poll.ts scans linked repos' PRs/checks (default 120s). */
  pollSeconds?: number;
};

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
  /** Delivery gate (SYD-49): worker-side PR publishing + deliver.ts settings. */
  delivery?: DeliveryConfig;
  /** Answerer mode (SYD-56): max answer sessions dispatched per issue ref, ever (default 3). */
  maxAnswersPerIssue?: number;
  /**
   * Role split (SYD-67): max answer sessions running at once, independent of
   * `maxConcurrent` (which governs code-dispatch capacity only). Default 2.
   */
  maxAnswerConcurrent?: number;
  /** GitHub polling fallback (SYD-71): scripts/github-poll.ts settings. */
  githubPoll?: GithubPollConfig;
};

const DEFAULT_ALLOWED_TOOLS = ["mcp__switchyard__*", "Bash", "Read", "Edit", "Write", "Grep", "Glob"];
const DEFAULT_WORKER_IMAGE = "switchyard-worker";
export const DEFAULT_MAX_ANSWER_CONCURRENT = 2;
const DEFAULT_BASE_BRANCH = "main";

export function projectKeyOf(ref: string): string {
  return ref.split("-")[0];
}

/**
 * Worker role (SYD-67): which loops a process runs. "code" dispatches
 * todo-issue work sessions (tick/resume/publish); "answer" services `@agent`
 * questions (event-poll trigger + the unanswered-questions backstop); "all"
 * (the default) runs both, preserving pre-split behavior.
 */
export type WorkerRole = "code" | "answer" | "all";

export function roleRunsCode(role: WorkerRole): boolean {
  return role === "code" || role === "all";
}

export function roleRunsAnswer(role: WorkerRole): boolean {
  return role === "answer" || role === "all";
}

/** Parses `--role <code|answer|all>` from argv, defaulting to "all" (pre-split behavior) when absent. */
export function parseRole(args: string[]): WorkerRole {
  const idx = args.indexOf("--role");
  if (idx === -1) return "all";
  const value = args[idx + 1];
  if (value !== "code" && value !== "answer" && value !== "all") {
    throw new Error(`--role must be "code", "answer", or "all" (got ${value ?? "<missing>"})`);
  }
  return value;
}

/** Pidfile basename for a role's single-instance lock — kept distinct so "code" and "answer" can run side by side. */
export function workerPidFileName(role: WorkerRole): string {
  return role === "all" ? "worker.pid" : `worker-${role}.pid`;
}

/**
 * Guards against overlapping single-role and combined-role workers on the
 * same machine: an "all" worker would duplicate whatever a single-role
 * worker is already doing, and vice versa. Same-role overlap is handled by
 * the ordinary pidfile lock (acquirePidLock). Pure so the exclusion rule is
 * unit-testable without touching the filesystem.
 */
export function checkRoleLockConflict(
  role: WorkerRole,
  locked: { all: boolean; code: boolean; answer: boolean }
): string | null {
  if (role === "all") {
    if (locked.code) return "a --role code worker is already running — stop it first, or run this worker with a single role";
    if (locked.answer) return "a --role answer worker is already running — stop it first, or run this worker with a single role";
    return null;
  }
  if (locked.all) {
    return "a --role all worker is already running — stop it first, or run this worker without --role";
  }
  return null;
}

/**
 * Filter a list of `todo` issues down to the ones the worker should dispatch this
 * tick: carries the configured label, belongs to a configured project, is
 * unassigned, doesn't need human input, isn't blocked by an open dependency
 * (SYD-160), doesn't already have an open agent PR (SYD-99 — belt-and-suspenders
 * alongside claimIssue's own check, for a claim that was released back to todo
 * while its PR is still open), isn't already running, and fits within remaining
 * maxConcurrent capacity (existing active dispatches + newly selected <=
 * maxConcurrent). Candidates are considered highest-priority-first, then
 * oldest-first within a priority (SYD-160), so capacity is filled by priority
 * rather than by the feed's arrival order.
 */
export function selectDispatchable<T extends WorkerIssue>(
  issues: T[],
  config: WorkerConfig,
  activeRefs: Iterable<string>
): T[] {
  const active = new Set(activeRefs);
  // maxConcurrent governs code-dispatch capacity only (SYD-67) — answer
  // sessions (keyed via answerKey) have their own maxAnswerConcurrent pool
  // and must not eat into it.
  const capacity = config.maxConcurrent - countWorkActive(active);
  if (capacity <= 0) return [];

  // Mirror next_task's (PRIORITY_RANK, createdAt) ordering so dispatch honors
  // priority regardless of the order /api/issues returned rows in (desc(id),
  // i.e. newest-first). Array.sort is stable, so equal keys keep feed order.
  const ordered = [...issues].sort((a, b) => {
    const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
    if (byPriority !== 0) return byPriority;
    return (a.createdAt ?? 0) - (b.createdAt ?? 0);
  });

  const selected: T[] = [];
  for (const issue of ordered) {
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
    if (issue.blocked) continue; // SYD-160: an open dependency; claimIssue would refuse it anyway.
    if (issue.openPr) {
      console.log(`skipping ${issue.ref}: open PR (#${issue.openPr.prNumber}) already in flight`);
      continue;
    }
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
 * Scans a feed of events newer than `lastEventId` on configured projects for
 * one `eventType`, returning the distinct issue refs plus the advanced
 * cursor. A null cursor means "first look at the feed": it initializes to the
 * newest event id without triggering on history, so a worker restart never
 * re-fires old events. Shared by `findResumeRefs` and `findAnswerRefs`.
 */
function findRefsByEventType(
  feed: FeedEvent[],
  config: WorkerConfig,
  lastEventId: number | null,
  eventType: string
): { refs: string[]; lastEventId: number | null } {
  if (feed.length === 0) return { refs: [], lastEventId };
  const newestId = Math.max(...feed.map((e) => e.id));
  if (lastEventId === null) return { refs: [], lastEventId: newestId };

  const refs = new Set<string>();
  for (const e of feed) {
    if (e.id <= lastEventId) continue;
    if (e.type !== eventType) continue;
    if (!(projectKeyOf(e.issue) in config.projects)) continue;
    refs.add(e.issue);
  }
  return { refs: [...refs], lastEventId: Math.max(newestId, lastEventId) };
}

/**
 * Scans the global event feed for `needs_input_cleared` events newer than
 * `lastEventId` on configured projects — each one means a human just answered
 * an escalation and the issue should be re-dispatched without waiting for the
 * next full poll.
 */
export function findResumeRefs(
  feed: FeedEvent[],
  config: WorkerConfig,
  lastEventId: number | null
): { refs: string[]; lastEventId: number | null } {
  return findRefsByEventType(feed, config, lastEventId, "needs_input_cleared");
}

/**
 * Scans the global event feed for `agent_question` events (SYD-56: a human
 * comment addressed to agents via a leading `@agent`) newer than
 * `lastEventId` on configured projects — each one is a signal to dispatch a
 * read-only answer session on that issue, regardless of its status.
 */
export function findAnswerRefs(
  feed: FeedEvent[],
  config: WorkerConfig,
  lastEventId: number | null
): { refs: string[]; lastEventId: number | null } {
  return findRefsByEventType(feed, config, lastEventId, "agent_question");
}

/** Per-ref count of answer sessions dispatched, kept in memory by the polling loop. */
export type AnswerState = Map<string, number>;

const DEFAULT_MAX_ANSWERS_PER_ISSUE = 3;

/**
 * Filters out refs that have already hit `maxAnswers` dispatched answer
 * sessions — a cost/rate control so a chatty or looping `@agent` thread can't
 * spin up unbounded sessions on one issue. Unlike `filterRetryCapped`, this
 * count never resets (it isn't tied to the issue's `updatedAt`): each
 * dispatched answer is a real session cost regardless of whether the issue
 * changed since.
 */
export function filterAnswerCapped(
  refs: string[],
  answerState: ReadonlyMap<string, number>,
  maxAnswers = DEFAULT_MAX_ANSWERS_PER_ISSUE
): string[] {
  return refs.filter((ref) => (answerState.get(ref) ?? 0) < maxAnswers);
}

/** Records a dispatched answer session for `ref`. Mutates `answerState` in place. */
export function recordAnswerAttempt(answerState: AnswerState, ref: string): void {
  answerState.set(ref, (answerState.get(ref) ?? 0) + 1);
}

const ANSWER_KEY_SUFFIX = "#answer";

/** Distinct `active` map key for an answer session, so it never collides with a work dispatch on the same ref. */
export function answerKey(ref: string): string {
  return `${ref}${ANSWER_KEY_SUFFIX}`;
}

/** Count of `active` keys that are answer sessions (suffixed via answerKey). */
function countAnswerActive(activeKeys: Iterable<string>): number {
  let n = 0;
  for (const key of activeKeys) if (key.endsWith(ANSWER_KEY_SUFFIX)) n++;
  return n;
}

/** Count of `active` keys that are code-dispatch (work) sessions — everything that isn't an answer session. */
function countWorkActive(activeKeys: Iterable<string>): number {
  let n = 0;
  for (const key of activeKeys) if (!key.endsWith(ANSWER_KEY_SUFFIX)) n++;
  return n;
}

/**
 * Remaining answer-session capacity under `config.maxAnswerConcurrent`
 * (default `DEFAULT_MAX_ANSWER_CONCURRENT`) — independent of `maxConcurrent`,
 * which governs code-dispatch capacity only (SYD-67: answer sessions used to
 * compete with code dispatch for the same pool, which caused SYD-60
 * deferrals under load).
 */
export function remainingAnswerCapacity(config: WorkerConfig, activeKeys: Iterable<string>): number {
  return (config.maxAnswerConcurrent ?? DEFAULT_MAX_ANSWER_CONCURRENT) - countAnswerActive(activeKeys);
}

/**
 * Filters unanswered-question refs (SYD-60: derived from the event log by
 * GET /api/unanswered-questions, a restart-proof backstop for questions
 * deferred at capacity or asked while the worker was down) down to the ones
 * the worker should dispatch an answer session for right now: belongs to a
 * configured project, doesn't already have an answer session running,
 * hasn't hit `maxAnswersPerIssue`, and fits within remaining
 * `maxAnswerConcurrent` capacity — its own pool, separate from the
 * code-dispatch `maxConcurrent` pool (SYD-67). `activeKeys` is every key
 * currently in the worker's `active` map — work dispatches and answer
 * sessions alike — but only the answer-keyed entries count against this
 * pool.
 */
export function selectAnswerable(
  refs: string[],
  config: WorkerConfig,
  activeKeys: Iterable<string>,
  answerState: ReadonlyMap<string, number>
): string[] {
  const active = new Set(activeKeys);
  const capacity = remainingAnswerCapacity(config, active);
  if (capacity <= 0) return [];

  const eligible = refs.filter(
    (ref) => projectKeyOf(ref) in config.projects && !active.has(answerKey(ref))
  );
  return filterAnswerCapped(eligible, answerState, config.maxAnswersPerIssue).slice(0, capacity);
}

/**
 * Read-only allowlist for answerer-mode sessions (SYD-56): no Edit/Write/Bash
 * and no MCP tools that could claim, transition, or otherwise mutate an
 * existing issue — only enough to read context, post the answer as a
 * comment, and file new issues (SYD-79: `file_issue` is the most-governed
 * write in the system — agent filings land in `triage` with required
 * provenance and only a human can move them out, so it feeds the human gate
 * rather than bypassing it). This is enforced here (not just in the prompt)
 * since the worker fully controls the tool allowlist it hands to a headless
 * session.
 */
export const ANSWER_ALLOWED_TOOLS = [
  "mcp__switchyard__get_issue",
  "mcp__switchyard__search_issues",
  "mcp__switchyard__list_projects",
  "mcp__switchyard__comment",
  "mcp__switchyard__file_issue",
  "Read",
  "Grep",
  "Glob",
];

/**
 * Prompt for an answerer-mode session (SYD-56): a human addressed a question
 * to agents on `ref` (a comment leading with `@agent`); the session reads the
 * issue + activity + repo and answers in a comment, with no write powers
 * beyond that comment and filing new issues — it never claims, transitions,
 * or edits anything.
 */
export function buildAnswerPrompt(ref: string): string {
  return (
    `A human asked a question addressed to an agent on Switchyard issue ${ref} ` +
    `(a comment leading with @agent). Call get_issue first and read the activity ` +
    `feed to find that question, then read whatever repo context you need to answer ` +
    `it accurately. Post your answer as a comment on ${ref} using the comment tool. ` +
    `If the question asks for work to be tracked, file it with file_issue (it lands ` +
    `in triage for human review) and cite the refs in your answer. This is a ` +
    `read-only, answer-only session otherwise: do not claim the issue, change its ` +
    `status, or edit any files — just answer the question in a comment, filing new ` +
    `issues as needed.`
  );
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
 * since the human reviewing has no other way to find it. Also spells out the
 * permission-prompt escalation explicitly (SYD-80): NOC-7 stalled and exited
 * silently asking for a permission grant into a headless session that could
 * never answer it, leaving the board showing in_progress with no trace of
 * why. The container pre-trusts the workspace so this shouldn't recur, but
 * the instruction stands as a backstop for whatever prompt slips through.
 * Also names the base branch (SYD-69) so a session whose work should target
 * something other than the default knows that's a human decision, not
 * something to assume.
 */
export function buildContainerizedPrompt(
  ref: string,
  opts: { resumed?: boolean; baseBranch?: string } = {}
): string {
  const baseBranch = opts.baseBranch ?? DEFAULT_BASE_BRANCH;
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
    `with your question and stop. If a permission prompt blocks you, call ` +
    `request_human_input with what you need and stop — never exit silently. ` +
    `You are in a disposable clone based on origin/${baseBranch}, on branch ` +
    `agent/${ref}; commit your work — it will be pushed for review. The issue ` +
    `comment MUST include the branch name. If this work should target a base ` +
    `branch other than ${baseBranch}, that's a human decision — ask via ` +
    `request_human_input rather than assuming.`
  );
}

/**
 * Thrown by tracker-write helpers (deliver.ts, agent-worker.ts) when a fetch
 * gets a non-ok response, carrying the status so `isRetryableError` can tell
 * a transient 5xx (the tracker restarting mid-deploy, SYD-66) from a
 * permanent 4xx that retrying would never fix.
 */
export class HttpStatusError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

/**
 * Backoff schedule for retrying tracker writes across a self-deploy restart
 * (SYD-66): every SYD delivery restarts the tracker for ~5-15s, and a
 * worker/deliver write landing in that window used to be silently lost.
 * These delays (3s/6s/12s/24s, ~45s total) span that window with margin.
 */
export const RETRY_BACKOFFS_MS = [3000, 6000, 12000, 24000];

/**
 * Only network failures (fetch throws a bare TypeError, e.g. "fetch failed",
 * when the connection is refused or reset) and 5xx responses look like a
 * tracker restart in progress — worth retrying. A 4xx is a real, permanent
 * problem with the request that retrying won't fix.
 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof HttpStatusError) return err.status >= 500;
  return err instanceof TypeError;
}

/**
 * Retries `fn` on retryable errors (network errors, 5xx — see
 * isRetryableError) using `backoffsMs` as the sleep between attempts,
 * calling `onRetry` before each sleep. A non-retryable error, or exhausting
 * every backoff, rethrows the last error unchanged so callers' existing
 * catch/log handling still applies. `sleep` is injectable so tests can run
 * the full schedule without waiting on it.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    backoffsMs?: number[];
    onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<T> {
  const backoffs = opts.backoffsMs ?? RETRY_BACKOFFS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= backoffs.length || !isRetryableError(err)) throw err;
      opts.onRetry?.(attempt + 1, err, backoffs[attempt]);
      await sleep(backoffs[attempt]);
    }
  }
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
  const baseBranch = project.baseBranch ?? DEFAULT_BASE_BRANCH;
  const prompt = buildContainerizedPrompt(issue.ref, { ...opts, baseBranch });
  const image = config.image ?? DEFAULT_WORKER_IMAGE;
  const stackChecks = stackChecksEnv(project.stack);

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
    ...(stackChecks ? ["-e", `STACK_CHECKS=${stackChecks}`] : []),
    "-e", `BASE_BRANCH=${baseBranch}`,
    image,
  ];
}

/**
 * Serializes a project's declared CLI checks (SYD-76) into the JSON payload
 * scripts/stack-check.mjs reads from STACK_CHECKS before a containerized
 * session starts — a session-start fast-fail instead of a mid-task ENOENT.
 * Returns undefined when there's nothing to check, so buildDockerArgs omits
 * the env var entirely rather than passing an empty array.
 */
export function stackChecksEnv(stack: WorkerStack | undefined): string | undefined {
  if (!stack?.cli || stack.cli.length === 0) return undefined;
  return JSON.stringify(stack.cli.map(({ name, check, install }) => ({ name, check, install })));
}
