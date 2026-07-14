import { describe, it, expect, vi, afterEach } from "vitest";
import {
  selectDispatchable,
  INTERACTIVE_PREFERENCE,
  filterRetryCapped,
  recordAttempt,
  findResumeRefs,
  findAnswerRefs,
  filterAnswerCapped,
  recordAnswerAttempt,
  buildAnswerPrompt,
  ANSWER_ALLOWED_TOOLS,
  buildDockerArgs,
  egressMode,
  egressAllowlist,
  ensureEgressGuard,
  buildContainerizedPrompt,
  stackChecksEnv,
  containerNameFor,
  partitionContainerSessions,
  type RunningContainerSessionRow,
  newTickGate,
  runGated,
  answerKey,
  selectAnswerable,
  remainingAnswerCapacity,
  roleRunsCode,
  roleRunsAnswer,
  parseRole,
  configPathFromArgs,
  workerPidFileName,
  checkRoleLockConflict,
  DEFAULT_MAX_ANSWER_CONCURRENT,
  DEFAULT_SESSION_TIMEOUT_SECONDS,
  sessionTimeoutMs,
  HttpStatusError,
  RETRY_BACKOFFS_MS,
  isRetryableError,
  withRetry,
  applyDispatchPolicy,
  type WorkerConfig,
  type WorkerIssue,
  type WorkerProject,
  type RetryState,
  type FeedEvent,
  type AnswerState,
  type DispatchPolicy,
} from "../../scripts/worker-select.js";

/** A promise plus its resolve/reject, for controlling when async work settles in tests. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const config: WorkerConfig = {
  url: "http://localhost:3300",
  label: "auto",
  intervalSeconds: 300,
  maxConcurrent: 2,
  projects: { SYD: { repo: "/repo/syd" } },
};

const issue = (overrides: Partial<WorkerIssue>): WorkerIssue => ({
  ref: "SYD-1",
  labels: ["auto"],
  assigneeId: null,
  needsInput: false,
  updatedAt: 1000,
  ...overrides,
});

describe("selectDispatchable", () => {
  it("only selects issues carrying the configured label", () => {
    const issues = [
      issue({ ref: "SYD-1", labels: ["auto"] }),
      issue({ ref: "SYD-2", labels: ["manual"] }),
    ];
    expect(selectDispatchable(issues, config, [])).toEqual([issues[0]]);
  });

  it("only selects issues in a configured project", () => {
    const issues = [issue({ ref: "SYD-1" }), issue({ ref: "AIPI-1" })];
    expect(selectDispatchable(issues, config, [])).toEqual([issues[0]]);
  });

  it("skips issues that already have an assignee", () => {
    const issues = [
      issue({ ref: "SYD-1", assigneeId: null }),
      issue({ ref: "SYD-2", assigneeId: 7 }),
    ];
    expect(selectDispatchable(issues, config, [])).toEqual([issues[0]]);
  });

  it("skips unassigned issues with an open agent PR (SYD-99: a stale claim released back to todo)", () => {
    const issues = [
      issue({ ref: "SYD-1" }),
      issue({ ref: "SYD-2", openPr: { prNumber: 41, url: "https://x/41" } }),
    ];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(selectDispatchable(issues, config, [])).toEqual([issues[0]]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/skipping SYD-2.*open PR.*#41/));
    logSpy.mockRestore();
  });

  it("skips issues marked workerPreference=interactive (human-attended only, never headless-dispatch)", () => {
    const issues = [
      issue({ ref: "SYD-1", labels: ["auto"] }),
      issue({ ref: "SYD-2", labels: ["auto"], workerPreference: INTERACTIVE_PREFERENCE }),
    ];
    expect(selectDispatchable(issues, config, [])).toEqual([issues[0]]);
  });

  it("caps selection so active + selected never exceeds maxConcurrent", () => {
    const issues = [issue({ ref: "SYD-1" }), issue({ ref: "SYD-2" }), issue({ ref: "SYD-3" })];
    expect(selectDispatchable(issues, { ...config, maxConcurrent: 2 }, ["SYD-9"])).toEqual([
      issues[0],
    ]);
    expect(selectDispatchable(issues, { ...config, maxConcurrent: 1 }, [])).toEqual([issues[0]]);
  });

  it("excludes issues that are already active", () => {
    const issues = [issue({ ref: "SYD-1" }), issue({ ref: "SYD-2" })];
    expect(selectDispatchable(issues, config, ["SYD-1"])).toEqual([issues[1]]);
  });

  it("does not count active answer sessions against maxConcurrent (SYD-67: separate pools)", () => {
    const issues = [issue({ ref: "SYD-1" }), issue({ ref: "SYD-2" })];
    // config.maxConcurrent is 2; two answer sessions are active but that pool is separate.
    expect(selectDispatchable(issues, config, [answerKey("SYD-8"), answerKey("SYD-9")])).toEqual(
      issues,
    );
  });

  it("returns nothing when already at capacity", () => {
    const issues = [issue({ ref: "SYD-1" })];
    expect(selectDispatchable(issues, config, ["SYD-9", "SYD-10"])).toEqual([]);
  });

  it("skips issues with needsInput set, even if otherwise eligible", () => {
    const issues = [
      issue({ ref: "SYD-1", needsInput: true }),
      issue({ ref: "SYD-2", needsInput: false }),
    ];
    expect(selectDispatchable(issues, config, [])).toEqual([issues[1]]);
  });

  it("skips issues with an open blocker, even if otherwise eligible (SYD-160)", () => {
    const issues = [
      issue({ ref: "SYD-1", blocked: true }),
      issue({ ref: "SYD-2", blocked: false }),
    ];
    expect(selectDispatchable(issues, config, [])).toEqual([issues[1]]);
  });

  it("prefers the higher-priority issue regardless of the feed's arrival order (SYD-160)", () => {
    // The feed arrives newest-id-first; priority must win over arrival order.
    const issues = [
      issue({ ref: "SYD-3", priority: "low" }),
      issue({ ref: "SYD-2", priority: "urgent" }),
      issue({ ref: "SYD-1", priority: "medium" }),
    ];
    expect(
      selectDispatchable(issues, { ...config, maxConcurrent: 1 }, []).map((i) => i.ref),
    ).toEqual(["SYD-2"]);
  });

  it("orders selection by priority, then oldest-first within a priority (SYD-160)", () => {
    const issues = [
      issue({ ref: "SYD-1", priority: "high", createdAt: 200 }),
      issue({ ref: "SYD-2", priority: "high", createdAt: 100 }),
      issue({ ref: "SYD-3", priority: "urgent", createdAt: 300 }),
    ];
    expect(
      selectDispatchable(issues, { ...config, maxConcurrent: 5 }, []).map((i) => i.ref),
    ).toEqual(["SYD-3", "SYD-2", "SYD-1"]);
  });

  it("treats an unset priority as lowest, below any ranked priority (SYD-160)", () => {
    const issues = [issue({ ref: "SYD-1" }), issue({ ref: "SYD-2", priority: "low" })];
    expect(
      selectDispatchable(issues, { ...config, maxConcurrent: 1 }, []).map((i) => i.ref),
    ).toEqual(["SYD-2"]);
  });
});

describe("filterRetryCapped", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes through issues with no retry state", () => {
    const issues = [issue({ ref: "SYD-1" })];
    expect(filterRetryCapped(issues, new Map())).toEqual(issues);
  });

  it("parks a ref at maxAttempts when updatedAt hasn't changed since the last attempt, and logs it", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const issues = [issue({ ref: "SYD-1", updatedAt: 1000 })];
    const state = new Map<string, RetryState>([["SYD-1", { attempts: 3, lastUpdatedAt: 1000 }]]);
    expect(filterRetryCapped(issues, state)).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/SYD-1/);
  });

  it("does not park below maxAttempts", () => {
    const issues = [issue({ ref: "SYD-1", updatedAt: 1000 })];
    const state = new Map<string, RetryState>([["SYD-1", { attempts: 2, lastUpdatedAt: 1000 }]]);
    expect(filterRetryCapped(issues, state)).toEqual(issues);
  });

  it("un-parks a ref once the issue's updatedAt has moved past the last attempt", () => {
    const issues = [issue({ ref: "SYD-1", updatedAt: 2000 })];
    const state = new Map<string, RetryState>([["SYD-1", { attempts: 5, lastUpdatedAt: 1000 }]]);
    expect(filterRetryCapped(issues, state)).toEqual(issues);
  });

  it("respects a custom maxAttempts", () => {
    const issues = [issue({ ref: "SYD-1", updatedAt: 1000 })];
    const state = new Map<string, RetryState>([["SYD-1", { attempts: 1, lastUpdatedAt: 1000 }]]);
    expect(filterRetryCapped(issues, state, 1)).toEqual([]);
  });
});

describe("findResumeRefs", () => {
  const ev = (overrides: Partial<FeedEvent>): FeedEvent => ({
    id: 1,
    type: "needs_input_cleared",
    issue: "SYD-1",
    ...overrides,
  });

  it("initializes a null cursor to the newest feed id without triggering on history", () => {
    const feed = [ev({ id: 9 }), ev({ id: 3 })];
    expect(findResumeRefs(feed, config, null)).toEqual({ refs: [], lastEventId: 9 });
  });

  it("keeps a null cursor when the feed is empty", () => {
    expect(findResumeRefs([], config, null)).toEqual({ refs: [], lastEventId: null });
  });

  it("returns refs of needs_input_cleared events newer than the cursor", () => {
    const feed = [ev({ id: 12, issue: "SYD-4" }), ev({ id: 10, issue: "SYD-2" })];
    expect(findResumeRefs(feed, config, 10)).toEqual({ refs: ["SYD-4"], lastEventId: 12 });
  });

  it("ignores other event types but still advances the cursor past them", () => {
    const feed = [ev({ id: 8, type: "comment" }), ev({ id: 7, type: "status_changed" })];
    expect(findResumeRefs(feed, config, 5)).toEqual({ refs: [], lastEventId: 8 });
  });

  it("ignores events for projects the worker is not configured for", () => {
    const feed = [ev({ id: 6, issue: "AIPI-3" })];
    expect(findResumeRefs(feed, config, 2)).toEqual({ refs: [], lastEventId: 6 });
  });

  it("dedupes repeated refs", () => {
    const feed = [ev({ id: 5 }), ev({ id: 4 }), ev({ id: 3, issue: "SYD-2" })];
    expect(findResumeRefs(feed, config, 2)).toEqual({ refs: ["SYD-1", "SYD-2"], lastEventId: 5 });
  });
});

describe("findAnswerRefs", () => {
  const ev = (overrides: Partial<FeedEvent>): FeedEvent => ({
    id: 1,
    type: "agent_question",
    issue: "SYD-1",
    ...overrides,
  });

  it("initializes a null cursor to the newest feed id without triggering on history", () => {
    const feed = [ev({ id: 9 }), ev({ id: 3 })];
    expect(findAnswerRefs(feed, config, null)).toEqual({ refs: [], lastEventId: 9 });
  });

  it("returns refs of agent_question events newer than the cursor", () => {
    const feed = [ev({ id: 12, issue: "SYD-4" }), ev({ id: 10, issue: "SYD-2" })];
    expect(findAnswerRefs(feed, config, 10)).toEqual({ refs: ["SYD-4"], lastEventId: 12 });
  });

  it("ignores needs_input_cleared and other event types but still advances the cursor", () => {
    const feed = [ev({ id: 8, type: "needs_input_cleared" }), ev({ id: 7, type: "comment" })];
    expect(findAnswerRefs(feed, config, 5)).toEqual({ refs: [], lastEventId: 8 });
  });

  it("ignores events for projects the worker is not configured for", () => {
    const feed = [ev({ id: 6, issue: "AIPI-3" })];
    expect(findAnswerRefs(feed, config, 2)).toEqual({ refs: [], lastEventId: 6 });
  });

  it("dedupes repeated refs", () => {
    const feed = [ev({ id: 5 }), ev({ id: 4 }), ev({ id: 3, issue: "SYD-2" })];
    expect(findAnswerRefs(feed, config, 2)).toEqual({ refs: ["SYD-1", "SYD-2"], lastEventId: 5 });
  });
});

describe("filterAnswerCapped / recordAnswerAttempt", () => {
  it("passes through refs with no recorded answers", () => {
    expect(filterAnswerCapped(["SYD-1"], new Map())).toEqual(["SYD-1"]);
  });

  it("caps at the default of 3 answers per issue", () => {
    const state: AnswerState = new Map([["SYD-1", 3]]);
    expect(filterAnswerCapped(["SYD-1"], state)).toEqual([]);
  });

  it("does not cap below the default", () => {
    const state: AnswerState = new Map([["SYD-1", 2]]);
    expect(filterAnswerCapped(["SYD-1"], state)).toEqual(["SYD-1"]);
  });

  it("respects a custom maxAnswers", () => {
    const state: AnswerState = new Map([["SYD-1", 1]]);
    expect(filterAnswerCapped(["SYD-1"], state, 1)).toEqual([]);
  });

  it("recordAnswerAttempt increments a fresh or existing ref", () => {
    const state: AnswerState = new Map();
    recordAnswerAttempt(state, "SYD-1");
    recordAnswerAttempt(state, "SYD-1");
    expect(state.get("SYD-1")).toBe(2);
  });
});

describe("selectAnswerable", () => {
  it("selects an unanswered ref with no answer session running and capacity available", () => {
    expect(selectAnswerable(["SYD-1"], config, [], new Map())).toEqual(["SYD-1"]);
  });

  it("drops refs from projects the worker isn't configured for", () => {
    expect(selectAnswerable(["AIPI-1"], config, [], new Map())).toEqual([]);
  });

  it("skips a ref that already has an answer session running (the drain-on-free path's duplicate suppression)", () => {
    expect(selectAnswerable(["SYD-1"], config, [answerKey("SYD-1")], new Map())).toEqual([]);
  });

  it("does not skip a ref just because its work session is active — work and answer sessions are independent", () => {
    expect(selectAnswerable(["SYD-1"], config, ["SYD-1"], new Map())).toEqual(["SYD-1"]);
  });

  it("answer capacity is independent of active work sessions (SYD-67: no more shared-pool coupling)", () => {
    // config.maxConcurrent is 2, but that no longer bounds answer capacity —
    // only maxAnswerConcurrent (default 2) does, and only one answer session
    // (answerKey("SYD-9")) is active here, so there's still room.
    expect(selectAnswerable(["SYD-2"], config, ["SYD-1", answerKey("SYD-9")], new Map())).toEqual([
      "SYD-2",
    ]);
  });

  it("caps the number selected to remaining maxAnswerConcurrent capacity, ignoring active work sessions", () => {
    const roomy = { ...config, maxConcurrent: 4 };
    // Two work sessions active — irrelevant to answer capacity (default maxAnswerConcurrent 2).
    expect(
      selectAnswerable(["SYD-1", "SYD-2", "SYD-3"], roomy, ["SYD-9", "SYD-8"], new Map()),
    ).toEqual(["SYD-1", "SYD-2"]);
  });

  it("excludes refs that already hit maxAnswersPerIssue", () => {
    const state: AnswerState = new Map([["SYD-1", 3]]);
    expect(selectAnswerable(["SYD-1", "SYD-2"], config, [], state)).toEqual(["SYD-2"]);
  });

  it("returns nothing when already at maxAnswerConcurrent capacity", () => {
    expect(
      selectAnswerable(["SYD-1"], config, [answerKey("SYD-8"), answerKey("SYD-9")], new Map()),
    ).toEqual([]);
  });

  it("respects a configured maxAnswerConcurrent", () => {
    const tight = { ...config, maxAnswerConcurrent: 1 };
    expect(selectAnswerable(["SYD-1"], tight, [answerKey("SYD-9")], new Map())).toEqual([]);
  });
});

describe("sessionTimeoutMs (SYD-115)", () => {
  it("defaults to DEFAULT_SESSION_TIMEOUT_SECONDS when unconfigured", () => {
    expect(sessionTimeoutMs(config)).toBe(DEFAULT_SESSION_TIMEOUT_SECONDS * 1000);
  });

  it("respects a configured sessionTimeoutSeconds", () => {
    expect(sessionTimeoutMs({ ...config, sessionTimeoutSeconds: 60 })).toBe(60_000);
  });
});

describe("applyDispatchPolicy (SYD-155)", () => {
  const policy: DispatchPolicy = {
    maxConcurrent: 5,
    maxAnswerConcurrent: 7,
    intervalSeconds: 60,
    eventPollSeconds: 10,
  };

  it("overlays every policy field onto the config in place", () => {
    const live: WorkerConfig = { ...config };
    applyDispatchPolicy(live, policy);
    expect(live).toMatchObject(policy);
    // host concerns are untouched
    expect(live.url).toBe(config.url);
    expect(live.label).toBe(config.label);
    expect(live.projects).toBe(config.projects);
  });

  it("mutates the same object other closures hold a reference to", () => {
    const live: WorkerConfig = { ...config };
    const alias = live;
    applyDispatchPolicy(live, policy);
    expect(alias.maxConcurrent).toBe(5);
    expect(alias.intervalSeconds).toBe(60);
  });
});

describe("remainingAnswerCapacity", () => {
  it("defaults to DEFAULT_MAX_ANSWER_CONCURRENT when unconfigured", () => {
    expect(remainingAnswerCapacity(config, [])).toBe(DEFAULT_MAX_ANSWER_CONCURRENT);
  });

  it("only counts answer-keyed active entries, not work sessions", () => {
    expect(remainingAnswerCapacity(config, ["SYD-1", "SYD-2", answerKey("SYD-3")])).toBe(
      DEFAULT_MAX_ANSWER_CONCURRENT - 1,
    );
  });

  it("respects a configured maxAnswerConcurrent", () => {
    expect(
      remainingAnswerCapacity({ ...config, maxAnswerConcurrent: 5 }, [answerKey("SYD-1")]),
    ).toBe(4);
  });
});

describe("answerKey", () => {
  it("suffixes the ref so it never collides with a work-dispatch active key", () => {
    expect(answerKey("SYD-7")).toBe("SYD-7#answer");
  });
});

describe("roleRunsCode / roleRunsAnswer", () => {
  it("all runs both halves", () => {
    expect(roleRunsCode("all")).toBe(true);
    expect(roleRunsAnswer("all")).toBe(true);
  });

  it("code runs only the code half", () => {
    expect(roleRunsCode("code")).toBe(true);
    expect(roleRunsAnswer("code")).toBe(false);
  });

  it("answer runs only the answer half", () => {
    expect(roleRunsCode("answer")).toBe(false);
    expect(roleRunsAnswer("answer")).toBe(true);
  });
});

describe("parseRole", () => {
  it("defaults to all when --role is absent", () => {
    expect(parseRole([])).toBe("all");
    expect(parseRole(["--once", "--dry-run"])).toBe("all");
  });

  it("parses --role code / answer / all", () => {
    expect(parseRole(["--role", "code"])).toBe("code");
    expect(parseRole(["--role", "answer"])).toBe("answer");
    expect(parseRole(["--role", "all"])).toBe("all");
  });

  it("throws on an unknown role value", () => {
    expect(() => parseRole(["--role", "bogus"])).toThrow(/--role/);
  });

  it("throws when --role is the last argument with no value", () => {
    expect(() => parseRole(["--role"])).toThrow(/--role/);
  });
});

describe("configPathFromArgs", () => {
  const ROOT = "/repo";
  const DEFAULT = "/repo/switchyard-worker.json";

  it("returns the default path when --config is absent", () => {
    expect(configPathFromArgs([], DEFAULT, ROOT)).toBe(DEFAULT);
    expect(configPathFromArgs(["--role", "code"], DEFAULT, ROOT)).toBe(DEFAULT);
  });

  it("uses an absolute --config path as-is", () => {
    expect(configPathFromArgs(["--config", "/etc/w.json"], DEFAULT, ROOT)).toBe("/etc/w.json");
  });

  it("resolves a relative --config path against repoRoot", () => {
    expect(configPathFromArgs(["--config", "switchyard-worker.codex.json"], DEFAULT, ROOT)).toBe(
      "/repo/switchyard-worker.codex.json",
    );
  });

  it("falls back to the default when --config is the last arg with no value", () => {
    expect(configPathFromArgs(["--config"], DEFAULT, ROOT)).toBe(DEFAULT);
  });
});

describe("workerPidFileName", () => {
  it("uses the bare worker.pid for the all role", () => {
    expect(workerPidFileName("all")).toBe("worker.pid");
  });

  it("suffixes single-role pidfiles so they never collide with each other or with all", () => {
    expect(workerPidFileName("code")).toBe("worker-code.pid");
    expect(workerPidFileName("answer")).toBe("worker-answer.pid");
  });

  // SYD-234: a per-worker label namespaces the pidfile so multiple engine
  // workers (claude/codex/gemini) each get their own role lock instead of
  // fighting over one machine-global worker-<role>.pid.
  it("namespaces the pidfile by label when one is given", () => {
    expect(workerPidFileName("all", "auto-codex")).toBe("worker-auto-codex.pid");
    expect(workerPidFileName("code", "auto-codex")).toBe("worker-auto-codex-code.pid");
    expect(workerPidFileName("answer", "auto-gemini")).toBe("worker-auto-gemini-answer.pid");
  });

  it("gives different-labelled workers of the same role distinct locks", () => {
    expect(workerPidFileName("code", "auto-codex")).not.toBe(workerPidFileName("code", "auto-gemini"));
    expect(workerPidFileName("code", "auto-codex")).not.toBe(workerPidFileName("code", "auto"));
  });

  it("keeps same-label same-role stable so acquirePidLock still self-excludes", () => {
    expect(workerPidFileName("code", "auto-codex")).toBe(workerPidFileName("code", "auto-codex"));
  });

  it("sanitizes filesystem-unsafe characters in the label", () => {
    expect(workerPidFileName("code", "a/b")).toBe("worker-a_b-code.pid");
  });
});

describe("checkRoleLockConflict", () => {
  it("allows all to start when nothing is locked", () => {
    expect(checkRoleLockConflict("all", { all: false, code: false, answer: false })).toBeNull();
  });

  it("refuses all when a single-role worker is already running", () => {
    expect(checkRoleLockConflict("all", { all: false, code: true, answer: false })).toMatch(/code/);
    expect(checkRoleLockConflict("all", { all: false, code: false, answer: true })).toMatch(
      /answer/,
    );
  });

  it("allows a single role to start alongside the other single role", () => {
    expect(checkRoleLockConflict("code", { all: false, code: false, answer: true })).toBeNull();
    expect(checkRoleLockConflict("answer", { all: false, code: true, answer: false })).toBeNull();
  });

  it("refuses a single role when an all worker is already running", () => {
    expect(checkRoleLockConflict("code", { all: true, code: false, answer: false })).toMatch(/all/);
    expect(checkRoleLockConflict("answer", { all: true, code: false, answer: false })).toMatch(
      /all/,
    );
  });
});

describe("buildAnswerPrompt", () => {
  it("names the issue, points at the activity feed, and forbids claiming/transitioning/editing", () => {
    const prompt = buildAnswerPrompt("SYD-7");
    expect(prompt).toContain("SYD-7");
    expect(prompt).toMatch(/@agent/);
    expect(prompt).toMatch(/get_issue|activity/i);
    expect(prompt).toMatch(/comment/i);
    expect(prompt).not.toMatch(/claim_issue|in_review/i);
    expect(prompt).toMatch(/read-only|do not claim|do not.*edit/i);
  });

  it("tells the session to file tracked work with file_issue", () => {
    const prompt = buildAnswerPrompt("SYD-7");
    expect(prompt).toMatch(/file_issue/);
    expect(prompt).toMatch(/triage/i);
  });
});

describe("ANSWER_ALLOWED_TOOLS", () => {
  it("excludes write-capable tools", () => {
    expect(ANSWER_ALLOWED_TOOLS).not.toContain("Edit");
    expect(ANSWER_ALLOWED_TOOLS).not.toContain("Write");
    expect(ANSWER_ALLOWED_TOOLS).not.toContain("Bash");
    expect(ANSWER_ALLOWED_TOOLS).not.toContain("mcp__switchyard__update_issue");
    expect(ANSWER_ALLOWED_TOOLS).not.toContain("mcp__switchyard__claim_issue");
    expect(ANSWER_ALLOWED_TOOLS).toContain("mcp__switchyard__comment");
  });

  it("allows filing new issues", () => {
    expect(ANSWER_ALLOWED_TOOLS).toContain("mcp__switchyard__file_issue");
  });
});

describe("recordAttempt", () => {
  it("starts a fresh ref at 1 attempt", () => {
    const state = new Map<string, RetryState>();
    recordAttempt(state, "SYD-1", 1000);
    expect(state.get("SYD-1")).toEqual({ attempts: 1, lastUpdatedAt: 1000 });
  });

  it("increments attempts when updatedAt is unchanged from the last attempt", () => {
    const state = new Map<string, RetryState>([["SYD-1", { attempts: 1, lastUpdatedAt: 1000 }]]);
    recordAttempt(state, "SYD-1", 1000);
    expect(state.get("SYD-1")).toEqual({ attempts: 2, lastUpdatedAt: 1000 });
  });

  it("resets attempts to 1 when updatedAt has moved", () => {
    const state = new Map<string, RetryState>([["SYD-1", { attempts: 3, lastUpdatedAt: 1000 }]]);
    recordAttempt(state, "SYD-1", 2000);
    expect(state.get("SYD-1")).toEqual({ attempts: 1, lastUpdatedAt: 2000 });
  });
});

describe("egress config (SYD-110)", () => {
  it("egressMode defaults to proxy and honors an explicit open", () => {
    expect(egressMode(config)).toBe("proxy");
    expect(egressMode({ ...config, egress: "open" })).toBe("open");
    expect(egressMode({ ...config, egress: "proxy" })).toBe("proxy");
  });

  it("egressAllowlist covers the Anthropic API, npm registry, and the tracker host", () => {
    expect(egressAllowlist(config)).toEqual(["api.anthropic.com", "localhost", "registry.npmjs.org"]);
  });

  it("egressAllowlist merges config extras, deduped and sorted", () => {
    expect(
      egressAllowlist({
        ...config,
        url: "http://nas.local:3300",
        egressAllow: ["github.com", "api.anthropic.com"],
      }),
    ).toEqual(["api.anthropic.com", "github.com", "nas.local", "registry.npmjs.org"]);
  });
});

describe("ensureEgressGuard (SYD-110)", () => {
  type Call = { cmd: string; args: string[] };

  /** Mock docker exec: `respond` maps "subcommand-ish" keys to stdout or a rejection. */
  function mockExec(respond: (call: Call) => string | Error) {
    const calls: Call[] = [];
    const exec = async (cmd: string, args: string[]) => {
      const call = { cmd, args };
      calls.push(call);
      const out = respond(call);
      if (out instanceof Error) throw out;
      return { stdout: out };
    };
    return { calls, exec };
  }

  const domainsCsv = "api.anthropic.com,localhost,registry.npmjs.org";
  // SYD-186: the sidecar now also injects provider creds; env supplies them and
  // seeds the INJECT_KEYS freshness sentinel (CLAUDE_CODE_OAUTH_TOKEN here).
  const egressEnv = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-REAL" } as NodeJS.ProcessEnv;

  it("creates the internal network and starts+connects the proxy when both are missing", async () => {
    const { calls, exec } = mockExec(({ args }) => {
      if (args[0] === "network" && args[1] === "inspect") return new Error("no such network");
      if (args[0] === "inspect") return new Error("no such container");
      return "";
    });
    await ensureEgressGuard(config, exec, egressEnv);

    const flat = calls.map((c) => c.args.join(" "));
    expect(flat).toContainEqual(expect.stringContaining("network create --internal syd-workers"));
    const runCall = calls.find((c) => c.args[0] === "run");
    expect(runCall).toBeDefined();
    expect(runCall!.args.join(" ")).toContain(`ALLOWED_DOMAINS=${domainsCsv}`);
    expect(runCall!.args).toContain("switchyard-egress-proxy");
    expect(runCall!.args).toContain("--restart");
    expect(flat).toContainEqual(expect.stringContaining("network connect syd-workers syd-egress"));
  });

  it("is a no-op when the network exists and the proxy runs with the same allowlist", async () => {
    const { calls, exec } = mockExec(({ args }) => {
      if (args[0] === "network") return "[]";
      if (args[0] === "inspect")
        return `true ALLOWED_DOMAINS=${domainsCsv} INJECT_KEYS=CLAUDE_CODE_OAUTH_TOKEN`;
      return "";
    });
    await ensureEgressGuard(config, exec, egressEnv);
    expect(calls.some((c) => c.args[0] === "run")).toBe(false);
    expect(calls.some((c) => c.args.includes("create"))).toBe(false);
  });

  it("recreates the proxy when the allowlist changed", async () => {
    const { calls, exec } = mockExec(({ args }) => {
      if (args[0] === "network") return "[]";
      if (args[0] === "inspect") return "true ALLOWED_DOMAINS=api.anthropic.com,old.host";
      return "";
    });
    await ensureEgressGuard(config, exec, egressEnv);

    const flat = calls.map((c) => c.args.join(" "));
    expect(flat).toContainEqual(expect.stringContaining("rm -f syd-egress"));
    const runCall = calls.find((c) => c.args[0] === "run");
    expect(runCall!.args.join(" ")).toContain(`ALLOWED_DOMAINS=${domainsCsv}`);
  });

  it("survives losing the network-create race to a concurrently starting worker", async () => {
    // Observed live (2026-07-11): deliver and worker-answer kickstarted
    // together; both saw the network missing, the loser's `network create`
    // got "already exists" and the whole worker died on it.
    let networkInspects = 0;
    const { calls, exec } = mockExec(({ args }) => {
      if (args[0] === "network" && args[1] === "inspect") {
        networkInspects++;
        return networkInspects === 1 ? new Error("no such network") : "[]";
      }
      if (args[0] === "network" && args[1] === "create") {
        return new Error("network with name syd-workers already exists");
      }
      if (args[0] === "inspect") return new Error("no such container");
      return "";
    });
    await ensureEgressGuard(config, exec, egressEnv);
    expect(calls.some((c) => c.args[0] === "run")).toBe(true);
  });

  it("still throws when network create fails and the network is genuinely absent", async () => {
    const { exec } = mockExec(({ args }) => {
      if (args[0] === "network") {
        return args[1] === "create" ? new Error("permission denied") : new Error("no such network");
      }
      return "";
    });
    await expect(ensureEgressGuard(config, exec, egressEnv)).rejects.toThrow(/permission denied/);
  });

  it("survives losing the proxy-run race: winner's healthy proxy is accepted, no duplicate connect", async () => {
    let proxyInspects = 0;
    const { calls, exec } = mockExec(({ args }) => {
      if (args[0] === "network") return "[]";
      if (args[0] === "inspect") {
        proxyInspects++;
        return proxyInspects === 1
          ? new Error("no such container")
          : `true ALLOWED_DOMAINS=${domainsCsv} INJECT_KEYS=CLAUDE_CODE_OAUTH_TOKEN`;
      }
      if (args[0] === "run") return new Error("Conflict. The container name is already in use");
      return "";
    });
    await ensureEgressGuard(config, exec, egressEnv);
    expect(calls.some((c) => c.args[0] === "network" && c.args[1] === "connect")).toBe(false);
  });

  it("tolerates an already-connected proxy on network connect", async () => {
    const { exec } = mockExec(({ args }) => {
      if (args[0] === "network" && args[1] === "inspect") return new Error("no such network");
      if (args[0] === "network" && args[1] === "connect") {
        return new Error("endpoint with name syd-egress already exists in network syd-workers");
      }
      if (args[0] === "inspect") return new Error("no such container");
      return "";
    });
    await expect(ensureEgressGuard(config, exec, egressEnv)).resolves.toBeUndefined();
  });

  it("recreates the proxy when it exists but is not running", async () => {
    const { calls, exec } = mockExec(({ args }) => {
      if (args[0] === "network") return "[]";
      if (args[0] === "inspect") return `false ALLOWED_DOMAINS=${domainsCsv}`;
      return "";
    });
    await ensureEgressGuard(config, exec, egressEnv);
    expect(calls.some((c) => c.args[0] === "run")).toBe(true);
  });
});

describe("buildDockerArgs", () => {
  const project: WorkerProject = { repo: "/repo/syd" };
  const oauthEnv = { CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret" };

  it("joins the internal egress network and routes sessions through the proxy (SYD-110)", () => {
    const args = buildDockerArgs(issue({ ref: "SYD-1" }), project, config, oauthEnv);
    const netIndex = args.indexOf("--network");
    expect(args[netIndex + 1]).toBe("syd-workers");
    for (const v of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
      expect(args).toContain(`${v}=http://syd-egress:8888`);
    }
    expect(args).toContain("NO_PROXY=localhost,127.0.0.1");
    expect(args).toContain("no_proxy=localhost,127.0.0.1");
  });

  it("omits the egress network and proxy env when egress is open (SYD-110)", () => {
    const args = buildDockerArgs(issue({ ref: "SYD-1" }), project, { ...config, egress: "open" }, oauthEnv);
    expect(args).not.toContain("--network");
    expect(args.some((a) => a.includes("_PROXY") || a.includes("_proxy"))).toBe(false);
  });

  it("mounts the right repo", () => {
    const args = buildDockerArgs(issue({ ref: "SYD-1" }), project, config, oauthEnv);
    const vIndex = args.indexOf("-v");
    expect(args[vIndex + 1]).toBe("/repo/syd:/origin");
  });

  it("passes the issue ref through as ISSUE_REF and the container name", () => {
    const args = buildDockerArgs(issue({ ref: "SYD-42" }), project, config, oauthEnv);
    expect(args).toContain("-e");
    expect(args).toContain("ISSUE_REF=SYD-42");
    const nameIndex = args.indexOf("--name");
    expect(args[nameIndex + 1]).toBe("syd-SYD-42");
  });

  it("passes SWITCHYARD_TOKEN using the bare -e form, never embedding its value", () => {
    const args = buildDockerArgs(issue({ ref: "SYD-1" }), project, config, oauthEnv);
    // The scoped session token stays a bare env passthrough in every mode.
    expect(args).toContain("SWITCHYARD_TOKEN");
    expect(args.some((a) => a.startsWith("SWITCHYARD_TOKEN="))).toBe(false);
    // No provider secret value ever lands in argv.
    expect(args.join(" ")).not.toContain("oauth-secret");
  });

  it("passes SWITCHYARD_LEASE bare (value from spawn env, never argv) only when a lease is present (SYD-210)", () => {
    const withLease = buildDockerArgs(issue({ ref: "SYD-1" }), project, config, oauthEnv, {
      leaseToken: "lease_abc",
    });
    expect(withLease).toContain("SWITCHYARD_LEASE"); // bare -e name
    expect(withLease.some((a) => a.startsWith("SWITCHYARD_LEASE="))).toBe(false); // value never in argv
    expect(withLease.join(" ")).not.toContain("lease_abc");
    // Absent when there is no lease.
    const noLease = buildDockerArgs(issue({ ref: "SYD-1" }), project, config, oauthEnv);
    expect(noLease).not.toContain("SWITCHYARD_LEASE");
  });

  it("injects SWITCHYARD_LEASE bare for the codex engine when leased (env_http_headers reads it — SYD-220)", () => {
    const args = buildDockerArgs(
      issue({ ref: "SYD-1" }),
      project,
      { ...config, engine: "codex" },
      { CODEX_OAUTH_TOKEN: "x", CODEX_ACCOUNT_ID: "acct" } as NodeJS.ProcessEnv,
      { leaseToken: "lease_abc" },
    );
    expect(args).toContain("SWITCHYARD_LEASE"); // bare -e name, value from spawn env
    expect(args.some((a) => a.startsWith("SWITCHYARD_LEASE="))).toBe(false); // value never in argv
    expect(args.join(" ")).not.toContain("lease_abc");
    // Absent when there is no lease.
    const noLease = buildDockerArgs(
      issue({ ref: "SYD-1" }),
      project,
      { ...config, engine: "codex" },
      { CODEX_OAUTH_TOKEN: "x", CODEX_ACCOUNT_ID: "acct" } as NodeJS.ProcessEnv,
    );
    expect(noLease).not.toContain("SWITCHYARD_LEASE");
  });

  it("proxy mode: agent container gets a placeholder + CA mount and no real credential (SYD-186)", () => {
    const args = buildDockerArgs(
      issue({ ref: "SYD-1" }),
      project,
      config,
      { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-REAL" } as NodeJS.ProcessEnv,
    );
    const joined = args.join(" ");
    expect(joined).toContain("CLAUDE_CODE_OAUTH_TOKEN=placeholder");
    expect(joined).not.toContain("sk-ant-oat-REAL"); // real value never crosses in
    expect(joined).toMatch(/-v [^ ]*egress-ca[^ ]*:\/ca:ro/); // CA mounted read-only
    // No bare passthrough of the real provider vars.
    const passesRealCred = args.some(
      (a, i) => a === "-e" && (args[i + 1] === "CLAUDE_CODE_OAUTH_TOKEN" || args[i + 1] === "ANTHROPIC_API_KEY"),
    );
    expect(passesRealCred).toBe(false);
  });

  it("open mode: the real credential is passed bare (no injecting sidecar) and no CA is mounted", () => {
    const args = buildDockerArgs(
      issue({ ref: "SYD-1" }),
      project,
      { ...config, egress: "open" },
      { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-REAL" } as NodeJS.ProcessEnv,
    );
    // Without a sidecar the container needs the real key — bare, value from env.
    const passesRealCred = args.some((a, i) => a === "-e" && args[i + 1] === "CLAUDE_CODE_OAUTH_TOKEN");
    expect(passesRealCred).toBe(true);
    const joined = args.join(" ");
    expect(joined).not.toContain("CLAUDE_CODE_OAUTH_TOKEN=placeholder");
    expect(joined).not.toContain(":/ca:ro");
    expect(joined).not.toContain("sk-ant-oat-REAL"); // still bare, never a value in argv
  });

  it("respects a custom image", () => {
    const args = buildDockerArgs(
      issue({ ref: "SYD-1" }),
      project,
      { ...config, image: "custom/worker-image" },
      oauthEnv,
    );
    expect(args[args.length - 1]).toBe("custom/worker-image");
  });

  it("defaults to the switchyard-worker image when none is configured", () => {
    const args = buildDockerArgs(issue({ ref: "SYD-1" }), project, config, oauthEnv);
    expect(args[args.length - 1]).toBe("switchyard-worker");
  });

  it("throws when neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is present", () => {
    expect(() => buildDockerArgs(issue({ ref: "SYD-1" }), project, config, {})).toThrow(
      /CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY/,
    );
  });

  it("accepts ANTHROPIC_API_KEY as an alternative to the OAuth token", () => {
    expect(() =>
      buildDockerArgs(issue({ ref: "SYD-1" }), project, config, {
        ANTHROPIC_API_KEY: "sk-ant-secret",
      }),
    ).not.toThrow();
  });

  it("omits STACK_CHECKS when the project has no stack.cli declared (SYD-76)", () => {
    const args = buildDockerArgs(issue({ ref: "SYD-1" }), project, config, oauthEnv);
    expect(args.some((a) => a.startsWith("STACK_CHECKS="))).toBe(false);
  });

  it("passes STACK_CHECKS derived from the project's declared stack.cli (SYD-76)", () => {
    const stacked: WorkerProject = {
      repo: "/repo/syd",
      stack: { cli: [{ name: "gh", check: "gh --version", install: "brew install gh" }] },
    };
    const args = buildDockerArgs(issue({ ref: "SYD-1" }), stacked, config, oauthEnv);
    const entry = args.find((a) => a.startsWith("STACK_CHECKS="));
    expect(entry).toBeDefined();
    expect(JSON.parse(entry!.slice("STACK_CHECKS=".length))).toEqual([
      { name: "gh", check: "gh --version", install: "brew install gh" },
    ]);
  });

  it("defaults BASE_BRANCH to main when the project has no override (SYD-69)", () => {
    const args = buildDockerArgs(issue({ ref: "SYD-1" }), project, config, oauthEnv);
    expect(args).toContain("BASE_BRANCH=main");
    const promptArg = args.find((a) => a.startsWith("WORKER_PROMPT="));
    expect(promptArg).toContain("origin/main");
  });

  it("threads a per-project baseBranch override into BASE_BRANCH and the prompt", () => {
    const devProject: WorkerProject = { repo: "/repo/syd", baseBranch: "develop" };
    const args = buildDockerArgs(issue({ ref: "SYD-1" }), devProject, config, oauthEnv);
    expect(args).toContain("BASE_BRANCH=develop");
    const promptArg = args.find((a) => a.startsWith("WORKER_PROMPT="));
    expect(promptArg).toContain("origin/develop");
  });

  it("caps memory, cpus, and pids so a runaway session can't exhaust the host (SYD-116)", () => {
    const args = buildDockerArgs(issue({ ref: "SYD-1" }), project, config, oauthEnv);
    const memIndex = args.indexOf("--memory");
    expect(memIndex).toBeGreaterThan(-1);
    expect(args[memIndex + 1]).toBe("4g");
    const cpusIndex = args.indexOf("--cpus");
    expect(cpusIndex).toBeGreaterThan(-1);
    expect(args[cpusIndex + 1]).toBe("2");
    const pidsIndex = args.indexOf("--pids-limit");
    expect(pidsIndex).toBeGreaterThan(-1);
    expect(args[pidsIndex + 1]).toBe("512");
  });

  it("disables privilege escalation inside the container (SYD-117)", () => {
    const args = buildDockerArgs(issue({ ref: "SYD-1" }), project, config, oauthEnv);
    const optIndex = args.indexOf("--security-opt");
    expect(optIndex).toBeGreaterThan(-1);
    expect(args[optIndex + 1]).toBe("no-new-privileges");
  });

  it("codex engine: image + CA mount, no real credential and no Claude placeholder (SYD-187)", () => {
    const args = buildDockerArgs(
      issue({ ref: "SYD-1" }),
      project,
      { ...config, engine: "codex" },
      { CODEX_OAUTH_TOKEN: "cxo-REAL" } as NodeJS.ProcessEnv,
    );
    const joined = args.join(" ");
    expect(args[args.length - 1]).toBe("switchyard-worker-codex");
    expect(joined).toMatch(/-v [^ ]*egress-ca[^ ]*:\/ca:ro/);
    expect(joined).not.toContain("cxo-REAL");
    expect(joined).not.toContain("CLAUDE_CODE_OAUTH_TOKEN"); // no Claude cred/placeholder on the codex path
    const passesToken = args.some((a, i) => a === "-e" && args[i + 1] === "CODEX_OAUTH_TOKEN");
    expect(passesToken).toBe(false); // real token stays in the sidecar, not the container
    const passesAcct = args.some((a, i) => a === "-e" && args[i + 1] === "CODEX_ACCOUNT_ID");
    expect(passesAcct).toBe(true); // non-secret account UUID goes to the container (for auth.json)
    expect(args).toContain("SWITCHYARD_TOKEN"); // scoped token still bare-passed
  });

  it("gemini engine: image + placeholder key + CA mount, no real key, non-interactive auth type (SYD-225)", () => {
    const args = buildDockerArgs(
      issue({ ref: "SYD-1" }),
      project,
      { ...config, engine: "gemini" },
      { GEMINI_API_KEY: "gk-REAL" } as NodeJS.ProcessEnv,
    );
    const joined = args.join(" ");
    expect(args[args.length - 1]).toBe("switchyard-worker-gemini");
    expect(joined).toMatch(/-v [^ ]*egress-ca[^ ]*:\/ca:ro/); // CA mounted (proxy)
    expect(joined).toContain("GEMINI_API_KEY=placeholder"); // placeholder; real key stays in the sidecar
    expect(joined).not.toContain("gk-REAL"); // real value never crosses in
    const passesRealKey = args.some((a, i) => a === "-e" && args[i + 1] === "GEMINI_API_KEY");
    expect(passesRealKey).toBe(false); // no bare real-key passthrough in proxy mode
    expect(joined).toContain("GEMINI_DEFAULT_AUTH_TYPE=gemini-api-key"); // non-interactive auth select
    expect(joined).not.toContain("CLAUDE_CODE_OAUTH_TOKEN"); // no Claude cred/placeholder on the gemini path
    expect(args).toContain("SWITCHYARD_TOKEN"); // scoped token still bare-passed
  });

  it("gemini open mode: the real GEMINI_API_KEY is passed bare, no placeholder, no CA (SYD-225)", () => {
    const args = buildDockerArgs(
      issue({ ref: "SYD-1" }),
      project,
      { ...config, engine: "gemini", egress: "open" },
      { GEMINI_API_KEY: "gk-REAL" } as NodeJS.ProcessEnv,
    );
    const joined = args.join(" ");
    const passesRealKey = args.some((a, i) => a === "-e" && args[i + 1] === "GEMINI_API_KEY");
    expect(passesRealKey).toBe(true); // without a sidecar the container needs the real key, bare
    expect(joined).not.toContain("GEMINI_API_KEY=placeholder");
    expect(joined).not.toContain(":/ca:ro");
    expect(joined).not.toContain("gk-REAL"); // still bare, never a value in argv
  });
});

describe("stackChecksEnv", () => {
  it("returns undefined when there is no stack or no cli entries", () => {
    expect(stackChecksEnv(undefined)).toBeUndefined();
    expect(stackChecksEnv({})).toBeUndefined();
    expect(stackChecksEnv({ cli: [] })).toBeUndefined();
  });

  it("serializes cli entries to a JSON array, dropping unset install", () => {
    const json = stackChecksEnv({ cli: [{ name: "gh", check: "gh --version" }] });
    expect(JSON.parse(json!)).toEqual([{ name: "gh", check: "gh --version" }]);
  });
});

describe("containerNameFor", () => {
  it("prefixes the ref with syd- to match buildDockerArgs's --name", () => {
    expect(containerNameFor("SYD-121")).toBe("syd-SYD-121");
  });
});

describe("partitionContainerSessions (SYD-121)", () => {
  const session = (overrides: Partial<RunningContainerSessionRow>): RunningContainerSessionRow => ({
    id: 1,
    ref: "SYD-1",
    mode: "container",
    issueTitle: "Some issue",
    ...overrides,
  });

  it("puts a container session with a still-running container in `live`", () => {
    const sessions = [session({ id: 1, ref: "SYD-1" })];
    const { live, orphaned } = partitionContainerSessions(sessions, new Set(["syd-SYD-1"]));
    expect(live).toEqual(sessions);
    expect(orphaned).toEqual([]);
  });

  it("puts a container session with no matching running container in `orphaned`", () => {
    const sessions = [session({ id: 1, ref: "SYD-1" })];
    const { live, orphaned } = partitionContainerSessions(sessions, new Set(["syd-SYD-2"]));
    expect(orphaned).toEqual(sessions);
    expect(live).toEqual([]);
  });

  it("ignores non-container sessions entirely — nothing to reconcile for a bare cli/sdk session", () => {
    const sessions = [session({ id: 1, ref: "SYD-1", mode: "cli" })];
    const { live, orphaned } = partitionContainerSessions(sessions, new Set());
    expect(live).toEqual([]);
    expect(orphaned).toEqual([]);
  });

  it("partitions a mix correctly", () => {
    const sessions = [
      session({ id: 1, ref: "SYD-1" }), // live
      session({ id: 2, ref: "SYD-2" }), // orphaned
      session({ id: 3, ref: "SYD-3", mode: "sdk" }), // ignored
    ];
    const { live, orphaned } = partitionContainerSessions(sessions, new Set(["syd-SYD-1"]));
    expect(live).toEqual([sessions[0]]);
    expect(orphaned).toEqual([sessions[1]]);
  });
});

describe("dispatchPolicy all-todo", () => {
  const base = {
    url: "http://x",
    label: "auto",
    intervalSeconds: 300,
    maxConcurrent: 5,
    projects: { SYD: { repo: "/tmp/syd" } },
  };
  const issue = (ref: string, labels: string[] = []) =>
    ({ ref, labels, assigneeId: null, needsInput: false, updatedAt: 1 }) as never;

  it("dispatches unlabeled todos and respects hold", () => {
    const cfg = { ...base, dispatchPolicy: "all-todo" as const };
    const out = selectDispatchable(
      [issue("SYD-1"), issue("SYD-2", ["hold"]), issue("SYD-3", ["auto"])],
      cfg,
      [].values(),
    );
    expect(out.map((i: { ref: string }) => i.ref)).toEqual(["SYD-1", "SYD-3"]);
  });

  it("labeled policy still requires the label", () => {
    const out = selectDispatchable([issue("SYD-1"), issue("SYD-2", ["auto"])], base, [].values());
    expect(out.map((i: { ref: string }) => i.ref)).toEqual(["SYD-2"]);
  });
});

describe("selectDispatchable worker preference (SYD-201)", () => {
  const base = {
    url: "http://x",
    label: "auto",
    intervalSeconds: 300,
    maxConcurrent: 5,
    projects: { SYD: { repo: "/tmp/syd" } },
    dispatchPolicy: "all-todo" as const,
  };
  const codexCfg = { ...base, engine: "codex" as const };
  const claudeCfg = { ...base, engine: "claude" as const };
  const iss = (ref: string, workerPreference: string | null, priority?: string) =>
    ({ ref, labels: [], assigneeId: null, needsInput: false, updatedAt: 1, workerPreference, priority }) as never;
  const refs = (out: unknown[]) => (out as { ref: string }[]).map((i) => i.ref);

  it("a codex worker orders match > neutral > foreign", () => {
    const out = selectDispatchable(
      [iss("SYD-1", null), iss("SYD-2", "codex"), iss("SYD-3", "claude")],
      codexCfg,
      [].values(),
    );
    expect(refs(out)).toEqual(["SYD-2", "SYD-1", "SYD-3"]);
  });

  it("a claude worker sorts codex-preferred issues last", () => {
    const out = selectDispatchable([iss("SYD-2", "codex"), iss("SYD-1", null)], claudeCfg, [].values());
    expect(refs(out)).toEqual(["SYD-1", "SYD-2"]);
  });

  it("affinity outranks priority — a matching low-priority beats a foreign urgent", () => {
    const out = selectDispatchable(
      [iss("SYD-3", "claude", "urgent"), iss("SYD-2", "codex", "low")],
      codexCfg,
      [].values(),
    );
    expect(refs(out)).toEqual(["SYD-2", "SYD-3"]);
  });

  it("still falls back to a foreign-preferred issue when it is the only work (no starvation)", () => {
    const out = selectDispatchable([iss("SYD-2", "codex")], claudeCfg, [].values());
    expect(refs(out)).toEqual(["SYD-2"]);
  });

  it("no engine set (default claude) treats codex-preferred as foreign, neutral unchanged", () => {
    const out = selectDispatchable([iss("SYD-2", "codex"), iss("SYD-1", null)], base, [].values());
    expect(refs(out)).toEqual(["SYD-1", "SYD-2"]);
  });
});

describe("buildContainerizedPrompt", () => {
  it("builds the standard containerized prompt", () => {
    const prompt = buildContainerizedPrompt("SYD-7");
    expect(prompt).toContain("SYD-7");
    // SYD-210: host pre-claims + holds the lease — assert the no-reclaim
    // instruction, not the substring that survives its inversion.
    expect(prompt).toMatch(/do not call claim_issue/i);
    expect(prompt).toMatch(/already claimed for your session/i);
    expect(prompt).toContain("agent/SYD-7");
    expect(prompt).not.toMatch(/escalat/i);
  });

  it("tells a blocked session to escalate a permission prompt instead of exiting silently (SYD-80)", () => {
    const prompt = buildContainerizedPrompt("SYD-7");
    expect(prompt).toMatch(/permission prompt/i);
    expect(prompt).toMatch(/request_human_input/);
    expect(prompt).toMatch(/never exit silently/i);
  });

  it("primes a resumed session to read the human's answer in the activity feed", () => {
    const prompt = buildContainerizedPrompt("SYD-7", { resumed: true });
    expect(prompt).toContain("SYD-7");
    expect(prompt).toMatch(/escalat/i);
    expect(prompt).toMatch(/answer/i);
    expect(prompt).toMatch(/get_issue|activity/i);
  });

  it("defaults to noting the base branch as main (SYD-69)", () => {
    const prompt = buildContainerizedPrompt("SYD-7");
    expect(prompt).toContain("origin/main");
    expect(prompt).toMatch(/human decision/i);
  });

  it("names a custom base branch when given one", () => {
    const prompt = buildContainerizedPrompt("SYD-7", { baseBranch: "develop" });
    expect(prompt).toContain("origin/develop");
    expect(prompt).not.toContain("origin/main");
  });
});

describe("buildDockerArgs resumed threading", () => {
  const project: WorkerProject = { repo: "/repo/syd" };
  const oauthEnv = { CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret" };

  it("threads opts.resumed into the containerized WORKER_PROMPT", () => {
    const args = buildDockerArgs(issue({ ref: "SYD-1" }), project, config, oauthEnv, {
      resumed: true,
    });
    const promptArg = args.find((a) => a.startsWith("WORKER_PROMPT="));
    expect(promptArg).toMatch(/escalat/i);
    expect(promptArg).toMatch(/answer/i);
  });

  it("omits the resumed preamble when opts.resumed is not set", () => {
    const args = buildDockerArgs(issue({ ref: "SYD-1" }), project, config, oauthEnv);
    const promptArg = args.find((a) => a.startsWith("WORKER_PROMPT="));
    expect(promptArg).not.toMatch(/escalat/i);
  });
});

describe("runGated / newTickGate", () => {
  it("runs fn immediately when nothing is in flight", async () => {
    const gate = newTickGate();
    let calls = 0;
    await runGated(gate, async () => {
      calls++;
    });
    expect(calls).toBe(1);
  });

  it("queues a call that arrives while fn is in flight and re-runs fn once the in-flight call finishes", async () => {
    const gate = newTickGate();
    let calls = 0;
    const first = deferred<void>();
    const firstRun = runGated(gate, async () => {
      calls++;
      await first.promise;
    });

    // A second call arrives mid-flight: it must not run fn again right away.
    const secondRun = runGated(gate, async () => {
      calls++;
      await first.promise;
    });
    await Promise.resolve(); // let both promise chains start
    expect(calls).toBe(1);

    first.resolve();
    await firstRun;
    await secondRun;
    // The queued call re-armed and ran fn exactly once more.
    expect(calls).toBe(2);
  });

  it("coalesces multiple calls that arrive during the same in-flight run into a single re-run", async () => {
    const gate = newTickGate();
    let calls = 0;
    const first = deferred<void>();
    const firstRun = runGated(gate, async () => {
      calls++;
      await first.promise;
    });

    await runGated(gate, async () => {
      calls++;
    });
    await runGated(gate, async () => {
      calls++;
    });
    await runGated(gate, async () => {
      calls++;
    });
    expect(calls).toBe(1);

    first.resolve();
    await firstRun;
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
  });

  it("propagates an error from the initial (non-queued) call", async () => {
    const gate = newTickGate();
    await expect(
      runGated(gate, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("does not deadlock the gate after an error — a later call still runs", async () => {
    const gate = newTickGate();
    await expect(
      runGated(gate, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    let ran = false;
    await runGated(gate, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

describe("isRetryableError", () => {
  it("treats a 5xx HttpStatusError as retryable", () => {
    expect(isRetryableError(new HttpStatusError(500, "boom"))).toBe(true);
    expect(isRetryableError(new HttpStatusError(503, "boom"))).toBe(true);
  });

  it("treats a 4xx HttpStatusError as non-retryable", () => {
    expect(isRetryableError(new HttpStatusError(400, "boom"))).toBe(false);
    expect(isRetryableError(new HttpStatusError(404, "boom"))).toBe(false);
  });

  it("treats a bare TypeError (fetch's own network-failure shape) as retryable", () => {
    expect(isRetryableError(new TypeError("fetch failed"))).toBe(true);
  });

  it("treats any other error as non-retryable", () => {
    expect(isRetryableError(new Error("boom"))).toBe(false);
    expect(isRetryableError("boom")).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns the result on first success without sleeping", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(fn, { sleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a retryable failure using the default backoff schedule, then succeeds", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) throw new TypeError("fetch failed");
      return "ok";
    });

    await expect(withRetry(fn, { sleep, onRetry })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual(RETRY_BACKOFFS_MS.slice(0, 2));
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0]).toBe(1);
    expect(onRetry.mock.calls[0][2]).toBe(RETRY_BACKOFFS_MS[0]);
    expect(onRetry.mock.calls[1][0]).toBe(2);
    expect(onRetry.mock.calls[1][2]).toBe(RETRY_BACKOFFS_MS[1]);
  });

  it("throws a non-retryable error immediately without sleeping", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValue(new HttpStatusError(400, "bad request"));
    await expect(withRetry(fn, { sleep })).rejects.toThrow("bad request");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("exhausts every backoff and rethrows the last error", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const err = new HttpStatusError(503, "still down");
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { sleep, backoffsMs: [10, 20] })).rejects.toThrow("still down");
    // 1 initial attempt + 2 retries = 3 calls total, sleeping between each.
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([10, 20]);
  });

  it("uses a custom backoff schedule when given one", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 2) throw new TypeError("fetch failed");
      return "ok";
    });

    await expect(withRetry(fn, { sleep, backoffsMs: [100] })).resolves.toBe("ok");
    expect(sleep).toHaveBeenCalledWith(100);
  });
});
