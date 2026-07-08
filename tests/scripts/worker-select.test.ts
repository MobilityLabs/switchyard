import { describe, it, expect } from "vitest";
import { selectDispatchable, type WorkerConfig, type WorkerIssue } from "../../scripts/worker-select.js";

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
});
