import { describe, it, expect, vi, afterEach } from "vitest";
import {
  selectDispatchable,
  filterRetryCapped,
  recordAttempt,
findResumeRefs,
  buildDockerArgs,
  buildContainerizedPrompt,
  newTickGate,
  runGated,
  type WorkerConfig,
  type WorkerIssue,
  type WorkerProject,
  type RetryState,
  type FeedEvent,
} from "../../scripts/worker-select.js";

/** A promise plus its resolve/reject, for controlling when async work settles in tests. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
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
    const issues = [issue({ ref: "SYD-1", labels: ["auto"] }), issue({ ref: "SYD-2", labels: ["manual"] })];
    expect(selectDispatchable(issues, config, [])).toEqual([issues[0]]);
  });

  it("only selects issues in a configured project", () => {
    const issues = [issue({ ref: "SYD-1" }), issue({ ref: "AIPI-1" })];
    expect(selectDispatchable(issues, config, [])).toEqual([issues[0]]);
  });

  it("skips issues that already have an assignee", () => {
    const issues = [issue({ ref: "SYD-1", assigneeId: null }), issue({ ref: "SYD-2", assigneeId: 7 })];
    expect(selectDispatchable(issues, config, [])).toEqual([issues[0]]);
  });

  it("caps selection so active + selected never exceeds maxConcurrent", () => {
    const issues = [issue({ ref: "SYD-1" }), issue({ ref: "SYD-2" }), issue({ ref: "SYD-3" })];
    expect(selectDispatchable(issues, { ...config, maxConcurrent: 2 }, ["SYD-9"])).toEqual([issues[0]]);
    expect(selectDispatchable(issues, { ...config, maxConcurrent: 1 }, [])).toEqual([issues[0]]);
  });

  it("excludes issues that are already active", () => {
    const issues = [issue({ ref: "SYD-1" }), issue({ ref: "SYD-2" })];
    expect(selectDispatchable(issues, config, ["SYD-1"])).toEqual([issues[1]]);
  });

  it("returns nothing when already at capacity", () => {
    const issues = [issue({ ref: "SYD-1" })];
    expect(selectDispatchable(issues, config, ["SYD-9", "SYD-10"])).toEqual([]);
  });

  it("skips issues with needsInput set, even if otherwise eligible", () => {
    const issues = [issue({ ref: "SYD-1", needsInput: true }), issue({ ref: "SYD-2", needsInput: false })];
    expect(selectDispatchable(issues, config, [])).toEqual([issues[1]]);
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

describe("buildDockerArgs", () => {
  const project: WorkerProject = { repo: "/repo/syd" };
  const oauthEnv = { CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret" };

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

  it("passes secret vars using the bare -e form, never embedding their values", () => {
    const args = buildDockerArgs(issue({ ref: "SYD-1" }), project, config, oauthEnv);
    for (const secretVar of ["SWITCHYARD_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
      expect(args).toContain(secretVar);
      // Bare form: the var name appears standalone, never as VAR=value.
      expect(args.some((a) => a.startsWith(`${secretVar}=`))).toBe(false);
    }
    expect(args.join(" ")).not.toContain("oauth-secret");
  });

  it("respects a custom image", () => {
    const args = buildDockerArgs(issue({ ref: "SYD-1" }), project, { ...config, image: "custom/worker-image" }, oauthEnv);
    expect(args[args.length - 1]).toBe("custom/worker-image");
  });

  it("defaults to the switchyard-worker image when none is configured", () => {
    const args = buildDockerArgs(issue({ ref: "SYD-1" }), project, config, oauthEnv);
    expect(args[args.length - 1]).toBe("switchyard-worker");
  });

  it("throws when neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is present", () => {
    expect(() => buildDockerArgs(issue({ ref: "SYD-1" }), project, config, {})).toThrow(
      /CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY/
    );
  });

  it("accepts ANTHROPIC_API_KEY as an alternative to the OAuth token", () => {
    expect(() =>
      buildDockerArgs(issue({ ref: "SYD-1" }), project, config, { ANTHROPIC_API_KEY: "sk-ant-secret" })
    ).not.toThrow();
  });
});

describe("dispatchPolicy all-todo", () => {
  const base = {
    url: "http://x", label: "auto", intervalSeconds: 300, maxConcurrent: 5,
    projects: { SYD: { repo: "/tmp/syd" } },
  };
  const issue = (ref: string, labels: string[] = []) =>
    ({ ref, labels, assigneeId: null, needsInput: false, updatedAt: 1 }) as never;

  it("dispatches unlabeled todos and respects hold", () => {
    const cfg = { ...base, dispatchPolicy: "all-todo" as const };
    const out = selectDispatchable(
      [issue("SYD-1"), issue("SYD-2", ["hold"]), issue("SYD-3", ["auto"])], cfg, [].values(),
    );
    expect(out.map((i: { ref: string }) => i.ref)).toEqual(["SYD-1", "SYD-3"]);
  });

  it("labeled policy still requires the label", () => {
    const out = selectDispatchable([issue("SYD-1"), issue("SYD-2", ["auto"])], base, [].values());
    expect(out.map((i: { ref: string }) => i.ref)).toEqual(["SYD-2"]);
  });
});

describe("buildContainerizedPrompt", () => {
  it("builds the standard containerized prompt", () => {
    const prompt = buildContainerizedPrompt("SYD-7");
    expect(prompt).toContain("SYD-7");
    expect(prompt).toContain("claim_issue");
    expect(prompt).toContain("agent/SYD-7");
    expect(prompt).not.toMatch(/escalat/i);
  });

  it("primes a resumed session to read the human's answer in the activity feed", () => {
    const prompt = buildContainerizedPrompt("SYD-7", { resumed: true });
    expect(prompt).toContain("SYD-7");
    expect(prompt).toMatch(/escalat/i);
    expect(prompt).toMatch(/answer/i);
    expect(prompt).toMatch(/get_issue|activity/i);
  });
});

describe("buildDockerArgs resumed threading", () => {
  const project: WorkerProject = { repo: "/repo/syd" };
  const oauthEnv = { CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret" };

  it("threads opts.resumed into the containerized WORKER_PROMPT", () => {
    const args = buildDockerArgs(issue({ ref: "SYD-1" }), project, config, oauthEnv, { resumed: true });
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

    await runGated(gate, async () => { calls++; });
    await runGated(gate, async () => { calls++; });
    await runGated(gate, async () => { calls++; });
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
      })
    ).rejects.toThrow("boom");
  });

  it("does not deadlock the gate after an error — a later call still runs", async () => {
    const gate = newTickGate();
    await expect(
      runGated(gate, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    let ran = false;
    await runGated(gate, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
