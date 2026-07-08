import { describe, it, expect, vi, afterEach } from "vitest";
import {
  selectDispatchable,
  filterRetryCapped,
  recordAttempt,
  buildDockerArgs,
  type WorkerConfig,
  type WorkerIssue,
  type WorkerProject,
  type RetryState,
} from "../../scripts/worker-select.js";

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
