import { describe, it, expect } from "vitest";
import {
  refFromBranch,
  refFromCommits,
  nudgeReminder,
  decideNudge,
} from "../../scripts/board-nudge-lib.js";

describe("refFromBranch (SYD-189)", () => {
  it("derives the ref from a feat/<key>-<n>-topic branch (case-insensitive key)", () => {
    expect(refFromBranch("feat/syd-189-board-guardrails")).toBe("SYD-189");
  });
  it("derives the ref from an agent/<KEY>-<n> branch", () => {
    expect(refFromBranch("agent/SYD-189")).toBe("SYD-189");
  });
  it("derives the ref from a fix/<KEY>-<n>-topic branch", () => {
    expect(refFromBranch("fix/SYD-42-flaky")).toBe("SYD-42");
  });
  it("handles a multi-letter project key of any length", () => {
    expect(refFromBranch("feat/noct-7-thing")).toBe("NOCT-7");
  });
  it("returns null when the branch carries no ref", () => {
    expect(refFromBranch("main")).toBeNull();
    expect(refFromBranch("feat/no-ref-here")).toBeNull();
  });
  it("returns null for an empty branch", () => {
    expect(refFromBranch("")).toBeNull();
  });
});

describe("refFromCommits (SYD-189)", () => {
  it("returns the first ref found scanning subjects newest-first", () => {
    expect(refFromCommits(["feat: add the thing (SYD-42)", "chore: noise"])).toBe("SYD-42");
  });
  it("skips subjects with no ref until it finds one", () => {
    expect(refFromCommits(["chore: noise", "fix: y (SYD-7)"])).toBe("SYD-7");
  });
  it("returns null when no subject carries a ref", () => {
    expect(refFromCommits(["chore: a", "docs: b"])).toBeNull();
    expect(refFromCommits([])).toBeNull();
  });
});

describe("nudgeReminder (SYD-189)", () => {
  it("names the ref, the PR number, and the in_review transition", () => {
    const msg = nudgeReminder("SYD-189", 173);
    expect(msg).toContain("SYD-189");
    expect(msg).toContain("#173");
    expect(msg).toContain("in_review");
  });
});

describe("decideNudge (SYD-189)", () => {
  const openPr = { number: 173 };

  it("nudges when a branch ref has an open PR and the hook is not already active", () => {
    const d = decideNudge({
      stopHookActive: false,
      branch: "agent/SYD-189",
      commitSubjects: [],
      openPr,
    });
    expect(d).toEqual({
      nudge: true,
      ref: "SYD-189",
      prNumber: 173,
      message: nudgeReminder("SYD-189", 173),
    });
  });

  it("falls back to the commit-subject ref when the branch has none", () => {
    const d = decideNudge({
      stopHookActive: false,
      branch: "scratch",
      commitSubjects: ["feat: x (SYD-189)"],
      openPr,
    });
    expect(d).toMatchObject({ nudge: true, ref: "SYD-189", prNumber: 173 });
  });

  it("does NOT nudge when the stop hook is already active (avoids trapping)", () => {
    expect(
      decideNudge({ stopHookActive: true, branch: "agent/SYD-189", commitSubjects: [], openPr }),
    ).toEqual({ nudge: false });
  });

  it("does NOT nudge when there is no open PR for the branch", () => {
    expect(
      decideNudge({
        stopHookActive: false,
        branch: "agent/SYD-189",
        commitSubjects: [],
        openPr: null,
      }),
    ).toEqual({ nudge: false });
  });

  it("does NOT nudge when no ref can be derived", () => {
    expect(
      decideNudge({ stopHookActive: false, branch: "main", commitSubjects: [], openPr }),
    ).toEqual({ nudge: false });
  });
});
