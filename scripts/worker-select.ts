// Pure dispatch-selection logic for scripts/agent-worker.ts.
// Kept separate from the polling/spawning loop so it's trivially unit-testable.

import { DEFAULT_CODEX_IMAGE } from "./engines/codex.js";

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
  /**
   * Soft dispatch routing (SYD-201): the preferred worker classification (its
   * engine, e.g. "codex"). A worker sorts issues matching its classification
   * ahead of neutral (null) ones, and foreign-preferred ones last — never
   * excluded, so an idle worker still falls back to them. Optional/unknown =
   * neutral.
   */
  workerPreference?: string | null;
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
   * Refuse to start (log + exit 1) instead of only warning when a linked
   * repo's `main` branch protection is relaxed (SYD-222). Default false —
   * `warnOnRelaxedBranchProtection` stays a loud but non-blocking startup
   * alarm, matching its existing best-effort/never-blocks-delivery contract.
   */
  requireBranchProtection?: boolean;
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
  /** SYD-210 Layer B: server lease heartbeat window (from dispatch-policy); the
   * host derives its miss-limit from it. Undefined until first policy fetch. */
  heartbeatWindowSeconds?: number;
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
  /** Which agent engine this worker drives: "claude" (default) or "codex". Selected per-worker-process. */
  engine?: "claude" | "codex";
  /**
   * NAME of the env var holding this worker's switchyard bearer token (default
   * "SWITCHYARD_TOKEN"). Lets a second worker process (e.g. a codex worker via
   * `--config`) use its own minted token (`SWITCHYARD_CODEX_TOKEN`) from .env —
   * the value stays in .env, never in the plist or argv.
   */
  token?: string;
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
  /**
   * Per-session watchdog (SYD-115): a dispatched session (CLI child, docker
   * container, or in-process SDK query — work or answer alike) running longer
   * than this is killed/aborted and its concurrency slot freed. Backstop for
   * a hung `claude -p`, a stuck `docker run`, or an SDK query that never
   * yields a `result` message, any of which would otherwise hold a
   * maxConcurrent/maxAnswerConcurrent slot forever. Default 3600 (1h).
   */
  sessionTimeoutSeconds?: number;
  /**
   * Container egress policy (SYD-110). "proxy" (default) puts dispatch
   * containers on an internal Docker network whose only way out is a
   * domain-allowlisted proxy sidecar — a prompt-injected session (or a
   * malicious npm lifecycle script) can't exfiltrate the tokens in its env.
   * "open" is the escape hatch: plain default-bridge networking, full egress.
   */
  egress?: "proxy" | "open";
  /** Extra hostnames the egress proxy should allow, beyond the tracker host,
   * api.anthropic.com, and registry.npmjs.org. */
  egressAllow?: string[];
};

const DEFAULT_ALLOWED_TOOLS = [
  "mcp__switchyard__*",
  "Bash",
  "Read",
  "Edit",
  "Write",
  "Grep",
  "Glob",
];
const DEFAULT_WORKER_IMAGE = "switchyard-worker";
export const DEFAULT_MAX_ANSWER_CONCURRENT = 2;
const DEFAULT_BASE_BRANCH = "main";
export const DEFAULT_SESSION_TIMEOUT_SECONDS = 3600;

/** Effective per-session watchdog timeout in ms — see `WorkerConfig.sessionTimeoutSeconds`. */
export function sessionTimeoutMs(config: WorkerConfig): number {
  return (config.sessionTimeoutSeconds ?? DEFAULT_SESSION_TIMEOUT_SECONDS) * 1000;
}

/**
 * Shape of `GET /api/dispatch-policy` (src/services/settings.ts) — the
 * `dispatch.*` settings group, worker-facing and agent-token readable.
 */
export type DispatchPolicy = {
  maxConcurrent: number;
  maxAnswerConcurrent: number;
  intervalSeconds: number;
  eventPollSeconds: number;
  // SYD-210 Layer B: the server's lease heartbeat window; the host derives its
  // miss-limit from it so the two can't diverge. Optional so an un-upgraded
  // tracker (no field) falls back to the host default.
  heartbeatWindowSeconds?: number;
};

/**
 * Overlays a fetched dispatch policy onto a live `WorkerConfig` in place
 * (SYD-155). Host concerns (url, image, containerized, roles, paths) stay
 * file-only; only these four policy fields come from Settings, so a human
 * can retune a running worker's concurrency and poll cadence without a
 * launchd restart. Mutating in place (rather than returning a new config)
 * means every closure already holding a reference to `config` sees the
 * update immediately.
 */
export function applyDispatchPolicy(config: WorkerConfig, policy: DispatchPolicy): void {
  config.maxConcurrent = policy.maxConcurrent;
  config.maxAnswerConcurrent = policy.maxAnswerConcurrent;
  config.intervalSeconds = policy.intervalSeconds;
  config.eventPollSeconds = policy.eventPollSeconds;
  if (policy.heartbeatWindowSeconds !== undefined) {
    config.heartbeatWindowSeconds = policy.heartbeatWindowSeconds;
  }
}

/**
 * SYD-210 Layer B: the host's consecutive-transient-miss cancel limit, derived
 * from the server's heartbeat window so the host cancels a session BEFORE the
 * server can expire its lease (the double-work direction), never after.
 *
 * The server expires a lease `window` seconds after the last successful beat.
 * A worst-case miss cycle is up to `interval + fetchTimeout` (a black-holing
 * tracker holds each beat open the full timeout, then the loop waits `interval`
 * before the next), so N misses take up to N·(interval+timeout). Solving
 * N·(interval+timeout) < window with `floor` guarantees the Nth miss lands
 * strictly inside the window — leaving margin for the 2s sweep. (SYD-210 review,
 * codex HIGH: the old `round(window/interval)` put the last miss AT/after
 * expiry.) Falls back to the default window for an un-upgraded tracker; ≥1.
 */
export function heartbeatMissLimit(config: WorkerConfig): number {
  const windowSeconds = config.heartbeatWindowSeconds ?? DEFAULT_HEARTBEAT_WINDOW_SECONDS;
  const cycleMs = HEARTBEAT_INTERVAL_MS + HEARTBEAT_FETCH_TIMEOUT_MS;
  // Largest N with N·cycle STRICTLY < window. `ceil(x)-1` is `floor(x)` for a
  // non-integer ratio and `x-1` when window divides evenly by the cycle — so an
  // operator retuning to a multiple (e.g. 140s → 1 miss @ 70s, not 2 @ 140s =
  // expiry) still cancels before the server can release (SYD-210 review, codex).
  // Floored at 1: a sub-cycle window is an operator misconfig, not defensible.
  return Math.max(1, Math.ceil((windowSeconds * 1000) / cycleMs) - 1);
}

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

/**
 * Parses `--config <path>` from argv, defaulting to `defaultPath` when absent.
 * Lets a second worker process (e.g. a codex worker) load its own config file
 * (`switchyard-worker.codex.json`) alongside the default one. A relative path is
 * resolved against `repoRoot` so a launchd job can name it repo-relative.
 */
export function configPathFromArgs(args: string[], defaultPath: string, repoRoot: string): string {
  const idx = args.indexOf("--config");
  const value = idx === -1 ? undefined : args[idx + 1];
  if (!value) return defaultPath;
  return value.startsWith("/") ? value : `${repoRoot}/${value}`;
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
  locked: { all: boolean; code: boolean; answer: boolean },
): string | null {
  if (role === "all") {
    if (locked.code)
      return "a --role code worker is already running — stop it first, or run this worker with a single role";
    if (locked.answer)
      return "a --role answer worker is already running — stop it first, or run this worker with a single role";
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
  activeRefs: Iterable<string>,
): T[] {
  const active = new Set(activeRefs);
  // maxConcurrent governs code-dispatch capacity only (SYD-67) — answer
  // sessions (keyed via answerKey) have their own maxAnswerConcurrent pool
  // and must not eat into it.
  const capacity = config.maxConcurrent - countWorkActive(active);
  if (capacity <= 0) return [];

  // Soft routing (SYD-201): this worker's classification is its engine. An
  // issue matching it sorts first, neutral (no preference) next, another
  // classification's last — ahead of priority, so each worker prefers its own
  // but (since nothing is excluded below) still falls back to foreign-preferred
  // work when it's all that's left. No preference set anywhere => all neutral,
  // i.e. today's behavior unchanged.
  const classification = config.engine ?? "claude";
  const affinity = (issue: T): number => {
    const pref = issue.workerPreference;
    if (pref == null) return 1; // neutral
    return pref === classification ? 0 : 2; // match : foreign
  };

  // Then mirror next_task's (PRIORITY_RANK, createdAt) ordering so dispatch
  // honors priority regardless of the order /api/issues returned rows in
  // (desc(id), i.e. newest-first). Array.sort is stable, so equal keys keep feed order.
  const ordered = [...issues].sort((a, b) => {
    const byAffinity = affinity(a) - affinity(b);
    if (byAffinity !== 0) return byAffinity;
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
  eventType: string,
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
  lastEventId: number | null,
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
  lastEventId: number | null,
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
  maxAnswers = DEFAULT_MAX_ANSWERS_PER_ISSUE,
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
export function remainingAnswerCapacity(
  config: WorkerConfig,
  activeKeys: Iterable<string>,
): number {
  return (
    (config.maxAnswerConcurrent ?? DEFAULT_MAX_ANSWER_CONCURRENT) - countAnswerActive(activeKeys)
  );
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
  answerState: ReadonlyMap<string, number>,
): string[] {
  const active = new Set(activeKeys);
  const capacity = remainingAnswerCapacity(config, active);
  if (capacity <= 0) return [];

  const eligible = refs.filter(
    (ref) => projectKeyOf(ref) in config.projects && !active.has(answerKey(ref)),
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
      void runGated(gate, fn).catch((err) =>
        console.error(`re-armed tick failed: ${(err as Error).message}`),
      );
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
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): T[] {
  return issues.filter((issue) => {
    const state = retryState.get(issue.ref);
    if (!state || state.lastUpdatedAt !== issue.updatedAt) return true;
    if (state.attempts >= maxAttempts) {
      console.log(
        `parking ${issue.ref}: ${state.attempts} dispatch attempts with no change since the last one`,
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
export function recordAttempt(
  retryState: Map<string, RetryState>,
  ref: string,
  updatedAt: number,
): void {
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
  opts: { resumed?: boolean; baseBranch?: string } = {},
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
    // SYD-210: the dispatch host already claimed this issue for your session and
    // holds its lease — do NOT call claim_issue (a re-claim would fail); your
    // claim-scoped writes are authorized automatically. Call get_issue to read it.
    `This issue is already claimed for your session — do not call claim_issue; call get_issue to read it. ` +
    `Implement the work with tests. Comment verification ` +
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
  } = {},
): Promise<T> {
  const backoffs = opts.backoffsMs ?? RETRY_BACKOFFS_MS;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
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
 * Docker container name this worker uses for a containerized dispatch of
 * `ref` — must stay in sync between `buildDockerArgs` (which sets `--name`)
 * and the SYD-121 startup reconciler (which reads names back via `docker
 * ps`) so a still-running container is recognized as the same session.
 */
export function containerNameFor(ref: string): string {
  return `syd-${ref}`;
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
 *
 * Applies conservative resource limits (SYD-116) so a runaway or
 * fork-bombing session can't exhaust the host, which also runs the
 * Switchyard tracker, dispatch worker, and the user's desktop.
 */
const CONTAINER_MEMORY_LIMIT = "4g";
const CONTAINER_CPU_LIMIT = "2";
const CONTAINER_PIDS_LIMIT = "512";

// SYD-110 + SYD-186 egress guard: an --internal Docker network (no route out)
// whose only exit is the syd-egress sidecar. The sidecar runs mitmproxy with a
// domain allowlist (default-deny) AND injects the real provider credentials
// into MITM'd provider traffic, so a compromised session can neither exfiltrate
// to arbitrary hosts nor read the real key — it holds only a placeholder.
export const EGRESS_NETWORK = "syd-workers";
export const EGRESS_PROXY_NAME = "syd-egress";
export const EGRESS_PROXY_IMAGE = "switchyard-egress-proxy";
export const EGRESS_PROXY_PORT = 8888;

// The persisted CA lives in a named volume mounted at mitmproxy's confdir. It
// is generated once (on the sidecar's first run) and NEVER regenerated on a
// recreate — agent containers must keep trusting the same CA across dispatches.
export const EGRESS_CA_VOLUME = "syd-egress-ca";
export const EGRESS_CA_DIR = "/home/mitmproxy/.mitmproxy";

// Provider credential vars the sidecar injects (SYD-186). Anthropic is live
// now; OpenAI/Gemini are provisioned for Project 2. Passed into the sidecar as
// bare `-e VAR` (value read from the worker env at run time, never argv).
export const PROVIDER_KEY_VARS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "CODEX_OAUTH_TOKEN",
] as const;

/** Bare `-e VAR` docker args for each provider key present (non-empty) in env —
 * the value is read from the worker's environment at run time, never argv. */
export function injectKeyEnvArgs(env: NodeJS.ProcessEnv): string[] {
  const args: string[] = [];
  for (const v of PROVIDER_KEY_VARS) {
    if (env[v]) args.push("-e", v);
  }
  return args;
}

/** Sorted names of the provider keys present in env — the recreate-freshness
 * sentinel (INJECT_KEYS). Names only, never values. */
export function injectKeyNames(env: NodeJS.ProcessEnv): string[] {
  return PROVIDER_KEY_VARS.filter((v) => env[v]).sort();
}

/** Baseline hosts every session needs: the Anthropic API and npm's registry
 * (sessions run `npm ci`). The tracker host comes from config.url. */
const EGRESS_BASELINE = ["api.anthropic.com", "registry.npmjs.org"];

export function egressMode(config: WorkerConfig): "proxy" | "open" {
  return config.egress ?? "proxy";
}

/** The full, sorted, deduped set of hostnames the proxy sidecar allows. */
export function egressAllowlist(config: WorkerConfig): string[] {
  const hosts = new Set(EGRESS_BASELINE);
  hosts.add(new URL(config.url).hostname);
  for (const extra of config.egressAllow ?? []) hosts.add(extra);
  return [...hosts].sort();
}

/** Minimal exec shape ensureEgressGuard needs — injected so tests never touch docker. */
export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

/**
 * Idempotently stands up the SYD-110/SYD-186 egress guard: the internal network
 * and the injecting proxy sidecar. Called at worker/deliver startup (and
 * harmless to call repeatedly): missing pieces are created; a proxy whose
 * allowlist OR injected key-set no longer matches (or that stopped) is
 * recreated. The persisted CA volume is mounted but never removed, so the CA
 * survives a recreate. `env` supplies the real provider credentials injected
 * into the sidecar (bare `-e VAR`, never argv). ALLOWED_DOMAINS and INJECT_KEYS
 * are plain hostnames / var-names, safe to embed in argv.
 */
export async function ensureEgressGuard(
  config: WorkerConfig,
  exec: ExecFn,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  // Several processes ensure concurrently at boot (deliver + both workers
  // kickstart together — observed live 2026-07-11): every mutating step below
  // races an identical twin, so a failure only counts if the desired state
  // genuinely isn't there when we look again.
  const inspectProxy = async (): Promise<
    { running: boolean; sameDomains: boolean; sameKeys: boolean } | null
  > => {
    try {
      const { stdout } = await exec("docker", [
        "inspect",
        "-f",
        "{{.State.Running}} {{range .Config.Env}}{{.}} {{end}}",
        EGRESS_PROXY_NAME,
      ]);
      return {
        running: stdout.trim().startsWith("true"),
        sameDomains: stdout.includes(`ALLOWED_DOMAINS=${domainsCsv}`),
        sameKeys: stdout.includes(`INJECT_KEYS=${keysCsv}`),
      };
    } catch {
      return null;
    }
  };
  const networkExists = async (): Promise<boolean> => {
    try {
      await exec("docker", ["network", "inspect", EGRESS_NETWORK]);
      return true;
    } catch {
      return false;
    }
  };

  const domainsCsv = egressAllowlist(config).join(",");
  const keysCsv = injectKeyNames(env).join(",");

  if (!(await networkExists())) {
    try {
      await exec("docker", ["network", "create", "--internal", EGRESS_NETWORK]);
    } catch (err) {
      if (!(await networkExists())) throw err; // a twin didn't win — real failure
    }
  }

  let proxy = await inspectProxy();
  if (proxy && proxy.running && proxy.sameDomains && proxy.sameKeys) return;

  if (proxy) {
    // Remove the container only — the CA volume is left in place so the
    // regenerated sidecar reuses the same CA every agent already trusts.
    await exec("docker", ["rm", "-f", EGRESS_PROXY_NAME]);
  }
  try {
    await exec("docker", [
      "run",
      "-d",
      "--restart",
      "unless-stopped",
      "--name",
      EGRESS_PROXY_NAME,
      "-v",
      `${EGRESS_CA_VOLUME}:${EGRESS_CA_DIR}`,
      "-e",
      `ALLOWED_DOMAINS=${domainsCsv}`,
      "-e",
      `INJECT_KEYS=${keysCsv}`,
      ...injectKeyEnvArgs(env),
      EGRESS_PROXY_IMAGE,
    ]);
  } catch (err) {
    // Name-conflict race: accept the winner's proxy if it's healthy — and
    // leave the network connect to the winner too.
    proxy = await inspectProxy();
    if (proxy && proxy.running && proxy.sameDomains && proxy.sameKeys) return;
    throw err;
  }
  // Dual-home the sidecar: created on the default bridge (egress), connected
  // to the internal network (where the session containers can reach it).
  try {
    await exec("docker", ["network", "connect", EGRESS_NETWORK, EGRESS_PROXY_NAME]);
  } catch (err) {
    if (!/already exists/i.test((err as Error).message)) throw err;
  }
}

/**
 * The docker-run argv fragment that scopes a session container's network
 * (SYD-110): join the internal network and point every HTTP(S) client at the
 * proxy sidecar — Claude Code, npm, and git all honor these env vars (both
 * cases needed: npm/git read the lowercase forms). Empty in "open" mode.
 * Shared by buildDockerArgs and delivery-lib's conflict-resolution builder.
 */
export function egressDockerArgs(config: WorkerConfig): string[] {
  if (egressMode(config) === "open") return [];
  const proxyUrl = `http://${EGRESS_PROXY_NAME}:${EGRESS_PROXY_PORT}`;
  const args = ["--network", EGRESS_NETWORK];
  for (const v of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
    args.push("-e", `${v}=${proxyUrl}`);
  }
  for (const v of ["NO_PROXY", "no_proxy"]) {
    args.push("-e", `${v}=localhost,127.0.0.1`);
  }
  return args;
}

export function buildDockerArgs(
  issue: WorkerIssue,
  project: WorkerProject,
  config: WorkerConfig,
  env: NodeJS.ProcessEnv,
  opts: { resumed?: boolean; leaseToken?: string } = {},
): string[] {
  const engine = config.engine ?? "claude";

  if (engine === "claude" && !env.CLAUDE_CODE_OAUTH_TOKEN && !env.ANTHROPIC_API_KEY) {
    throw new Error(
      "containerized Claude dispatch requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in the worker's environment",
    );
  }
  if (engine === "codex" && !env.CODEX_OAUTH_TOKEN) {
    throw new Error(
      "containerized Codex dispatch requires CODEX_OAUTH_TOKEN in the worker's environment (the injector's ChatGPT token)",
    );
  }

  const allowedTools = config.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
  const baseBranch = project.baseBranch ?? DEFAULT_BASE_BRANCH;
  const prompt = buildContainerizedPrompt(issue.ref, { ...opts, baseBranch });
  const image = config.image ?? (engine === "codex" ? DEFAULT_CODEX_IMAGE : DEFAULT_WORKER_IMAGE);
  const stackChecks = stackChecksEnv(project.stack);

  // Provider-credential handling depends on the egress mode (SYD-186) and,
  // now, the engine (SYD-187):
  // - proxy (default): the syd-egress sidecar injects the real credential, so
  //   the container holds only a placeholder + the CA public cert (read-only).
  //   The real key never crosses into the agent container.
  // - open: no injecting sidecar, so the real credential must reach the
  //   container — bare `-e VAR` (value from the worker env, never argv).
  // Codex additionally always gets the non-secret CODEX_ACCOUNT_ID (needed for
  // the placeholder/real auth.json's chatgpt-account-id) in both modes.
  const proxy = egressMode(config) === "proxy";
  const credArgs =
    engine === "codex"
      ? [
          "-e",
          "CODEX_ACCOUNT_ID",
          ...(proxy ? ["-v", `${EGRESS_CA_VOLUME}:/ca:ro`] : ["-e", "CODEX_OAUTH_TOKEN"]),
        ]
      : proxy
        ? ["-e", "CLAUDE_CODE_OAUTH_TOKEN=placeholder", "-v", `${EGRESS_CA_VOLUME}:/ca:ro`]
        : ["-e", "CLAUDE_CODE_OAUTH_TOKEN", "-e", "ANTHROPIC_API_KEY"];

  return [
    "run",
    "--rm",
    "--name",
    containerNameFor(issue.ref),
    "--memory",
    CONTAINER_MEMORY_LIMIT,
    "--cpus",
    CONTAINER_CPU_LIMIT,
    "--pids-limit",
    CONTAINER_PIDS_LIMIT,
    // SYD-117: the image already drops to a non-root user (Dockerfile.worker),
    // this stops a compromised session from regaining privilege via a setuid
    // binary even so.
    "--security-opt",
    "no-new-privileges",
    ...egressDockerArgs(config),
    "-v",
    `${project.repo}:/origin`,
    "-e",
    `ISSUE_REF=${issue.ref}`,
    "-e",
    `SWITCHYARD_URL=${config.url}`,
    "-e",
    "SWITCHYARD_TOKEN",
    // SYD-210 Layer B: the session-scoped lease, passed bare (value from the
    // spawn env, never argv) exactly like SWITCHYARD_TOKEN — the entry script
    // adds it as the X-Switchyard-Lease MCP header so the session's
    // claim-scoped writes carry the lease without it entering the transcript.
    // Both engines now consume it: container-entry.sh writes it into the claude
    // MCP headers file; container-entry.codex.sh names it via codex's
    // env_http_headers (verified on codex 0.144.x — parity with
    // bearer_token_env_var), so codex reads the value from the env at runtime
    // (SYD-220). Absent for answer/non-lease sessions.
    ...(opts.leaseToken ? ["-e", "SWITCHYARD_LEASE"] : []),
    ...credArgs,
    "-e",
    `WORKER_PROMPT=${prompt}`,
    "-e",
    `ALLOWED_TOOLS=${allowedTools.join(",")}`,
    ...(stackChecks ? ["-e", `STACK_CHECKS=${stackChecks}`] : []),
    "-e",
    `BASE_BRANCH=${baseBranch}`,
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

/** The subset of a GET /api/agent-sessions?active=true row the SYD-121 startup reconciler needs. */
export type RunningContainerSessionRow = {
  id: number;
  ref: string;
  mode: string;
  issueTitle: string;
};

/**
 * Splits recorded-"running" agent sessions into ones whose container is still
 * actually alive per `docker ps` (live — the worker restarted mid-session but
 * the container survived, so it can be re-adopted) and ones whose container
 * isn't running anymore (orphaned — it already exited, or never really
 * started, while no worker process was around to report it; SYD-121). Bare
 * cli/sdk sessions never survive their worker process exiting, so there's
 * nothing to reconcile for them here — they're filtered out entirely and left
 * to the server's time-based sweepOrphanedAgentSessions.
 */
export function partitionContainerSessions(
  sessions: RunningContainerSessionRow[],
  liveContainerNames: ReadonlySet<string>,
): { orphaned: RunningContainerSessionRow[]; live: RunningContainerSessionRow[] } {
  const orphaned: RunningContainerSessionRow[] = [];
  const live: RunningContainerSessionRow[] = [];
  for (const s of sessions) {
    if (s.mode !== "container") continue;
    (liveContainerNames.has(containerNameFor(s.ref)) ? live : orphaned).push(s);
  }
  return { orphaned, live };
}

// SYD-210 Layer B host-side heartbeat cadence. Interval 60s x miss-limit 10 =
// a ~10-min window that comfortably exceeds the worst-case tracker redeploy
// (~5-15s, SYD-66) — and the server also gates expiry on its own uptime, so a
// redeploy can't mass-expire live leases regardless.
export const HEARTBEAT_INTERVAL_MS = 60_000;
export const HEARTBEAT_MISS_LIMIT = 10;
// Per-beat fetch timeout (agent-worker postHeartbeat). A worst-case miss cycle
// is up to interval + this (a black-holing tracker holds each beat open the
// full timeout), so the host's effective cancel deadline must budget for it —
// see heartbeatMissLimit.
export const HEARTBEAT_FETCH_TIMEOUT_MS = 10_000;
// Default lease window when the tracker hasn't advertised one (matches the
// server's claims.heartbeat_window_seconds default).
export const DEFAULT_HEARTBEAT_WINDOW_SECONDS = 600;
// A definitive 4xx means the lease is GONE server-side (takeover / expiry) —
// unrecoverable, and the session is now doing sanctioned double-work on exactly
// the SYD-93 failure mode. Cancel fast (a couple of confirming beats) rather
// than waiting out the full transient window.
export const HEARTBEAT_INVALID_LIMIT = 2;

/** A single heartbeat's classified outcome. `invalid` = 4xx (lease revoked,
 * permanent); `unreachable` = network error / timeout / 5xx (transient). */
export type HeartbeatOutcome = "ok" | "invalid" | "unreachable";

/**
 * Fold one classified heartbeat outcome into the running counters and decide
 * whether to cancel the session. `ok` resets both counters. A definitive 4xx
 * (`invalid`) cancels after `invalidLimit` — the lease is gone, so stop the
 * zombie promptly. A transient `unreachable` cancels only after the full
 * `missLimit` — the tracker may just be briefly unreachable while the
 * server-side lease is still safe, so be patient. Pure, so the two-class
 * decision is unit-tested independently of the timer/fetch wiring.
 */
export function heartbeatTick(
  state: { misses: number; invalids: number },
  outcome: HeartbeatOutcome,
  missLimit: number = HEARTBEAT_MISS_LIMIT,
  invalidLimit: number = HEARTBEAT_INVALID_LIMIT,
): { misses: number; invalids: number; cancel: boolean } {
  if (outcome === "ok") return { misses: 0, invalids: 0, cancel: false };
  if (outcome === "invalid") {
    const invalids = state.invalids + 1;
    return { misses: state.misses, invalids, cancel: invalids >= invalidLimit };
  }
  const misses = state.misses + 1;
  return { misses, invalids: state.invalids, cancel: misses >= missLimit };
}
