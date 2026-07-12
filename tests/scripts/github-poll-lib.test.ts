import { describe, it, expect } from "vitest";
import {
  diffRepoState,
  parsePollStateText,
  type GhPr,
  type GhRun,
  type RepoPollState,
} from "../../scripts/github-poll-lib.js";

function pr(o: Partial<GhPr>): GhPr {
  return {
    number: 1,
    headRefName: "agent/SYD-1",
    title: "unrelated title",
    body: null,
    url: "https://github.com/acme/widgets/pull/1",
    state: "OPEN",
    mergeCommit: null,
    ...o,
  };
}

function run(o: Partial<GhRun>): GhRun {
  return {
    headSha: "deadbeef",
    status: "completed",
    conclusion: "success",
    url: "https://github.com/acme/widgets/actions/runs/1",
    ...o,
  };
}

describe("diffRepoState / pull requests", () => {
  it("emits opened for a PR seen for the first time while open", () => {
    const { events, next } = diffRepoState([pr({})], new Map(), {});
    expect(events).toEqual([
      {
        event: "pull_request",
        payload: {
          action: "opened",
          pull_request: {
            number: 1,
            html_url: "https://github.com/acme/widgets/pull/1",
            head: { ref: "agent/SYD-1" },
            title: "unrelated title",
            body: null,
            merged: false,
            merge_commit_sha: null,
          },
        },
      },
    ]);
    expect(next).toEqual({ 1: { state: "OPEN", lastRunConclusion: null } });
  });

  it("re-emits opened for an already-tracked open PR (SYD-177: server dedupes, heals lost events)", () => {
    const prior: RepoPollState = { 1: { state: "OPEN", lastRunConclusion: null } };
    const { events } = diffRepoState([pr({})], new Map(), prior);
    expect(events).toEqual([
      { event: "pull_request", payload: expect.objectContaining({ action: "opened" }) },
    ]);
  });

  it("emits closed (merged:false) when a tracked-open PR is later closed unmerged", () => {
    const prior: RepoPollState = { 1: { state: "OPEN", lastRunConclusion: null } };
    const { events, next } = diffRepoState([pr({ state: "CLOSED" })], new Map(), prior);
    expect(events).toEqual([
      {
        event: "pull_request",
        payload: expect.objectContaining({
          action: "closed",
          pull_request: expect.objectContaining({ merged: false }),
        }),
      },
    ]);
    expect(next[1].state).toBe("CLOSED");
  });

  it("emits closed (merged:true, mergeSha) when a tracked-open PR is later merged", () => {
    const prior: RepoPollState = { 1: { state: "OPEN", lastRunConclusion: null } };
    const { events } = diffRepoState(
      [pr({ state: "MERGED", mergeCommit: { oid: "abc123" } })],
      new Map(),
      prior,
    );
    expect(events).toEqual([
      {
        event: "pull_request",
        payload: expect.objectContaining({
          action: "closed",
          pull_request: expect.objectContaining({ merged: true, merge_commit_sha: "abc123" }),
        }),
      },
    ]);
  });

  it("does not emit anything for a PR first observed already closed/merged", () => {
    const { events, next } = diffRepoState([pr({ state: "MERGED" })], new Map(), {});
    expect(events).toEqual([]);
    expect(next[1].state).toBe("MERGED");
  });

  it("leaves PRs missing from the current list untouched in the returned state", () => {
    const prior: RepoPollState = {
      1: { state: "OPEN", lastRunConclusion: null },
      2: { state: "OPEN", lastRunConclusion: "success" },
    };
    const { next } = diffRepoState([pr({ number: 1 })], new Map(), prior);
    expect(next[2]).toEqual({ state: "OPEN", lastRunConclusion: "success" });
  });
});

describe("diffRepoState / checks", () => {
  it("emits check_suite for a completed run with a new conclusion on an open PR", () => {
    const runs = new Map([[1, run({ conclusion: "success" })]]);
    const { events, next } = diffRepoState([pr({})], runs, {});
    expect(events).toEqual([
      {
        event: "pull_request",
        payload: expect.objectContaining({ action: "opened" }),
      },
      {
        event: "check_suite",
        payload: {
          action: "completed",
          check_suite: {
            head_branch: "agent/SYD-1",
            head_sha: "deadbeef",
            conclusion: "success",
            pull_requests: [{ head: { ref: "agent/SYD-1" } }],
          },
        },
      },
    ]);
    expect(next[1]).toEqual({ state: "OPEN", lastRunConclusion: "success" });
  });

  it("does not re-emit check_suite when the conclusion is unchanged", () => {
    const prior: RepoPollState = { 1: { state: "OPEN", lastRunConclusion: "success" } };
    const runs = new Map([[1, run({ conclusion: "success" })]]);
    const { events } = diffRepoState([pr({})], runs, prior);
    expect(events.filter((e) => e.event === "check_suite")).toEqual([]);
  });

  it("emits check_suite again when the conclusion flips from failure to success (a re-run)", () => {
    const prior: RepoPollState = { 1: { state: "OPEN", lastRunConclusion: "failure" } };
    const runs = new Map([[1, run({ conclusion: "success" })]]);
    const { events } = diffRepoState([pr({})], runs, prior);
    const checkEvents = events.filter((e) => e.event === "check_suite");
    expect(checkEvents).toHaveLength(1);
    expect(checkEvents[0]).toMatchObject({
      event: "check_suite",
      payload: { check_suite: { conclusion: "success" } },
    });
  });

  it("ignores a run that is still queued/in_progress (no conclusion yet)", () => {
    const runs = new Map([[1, run({ status: "in_progress", conclusion: null })]]);
    const { events } = diffRepoState([pr({})], runs, {
      1: { state: "OPEN", lastRunConclusion: null },
    });
    expect(events.filter((e) => e.event === "check_suite")).toEqual([]);
  });

  it("ignores checks entirely once the PR is no longer open", () => {
    const prior: RepoPollState = { 1: { state: "OPEN", lastRunConclusion: "success" } };
    const runs = new Map([[1, run({ conclusion: "failure" })]]);
    const { events, next } = diffRepoState([pr({ state: "MERGED" })], runs, prior);
    // Only the pull_request "closed" event, no check_suite for the now-closed PR.
    expect(events).toEqual([
      { event: "pull_request", payload: expect.objectContaining({ action: "closed" }) },
    ]);
    expect(next[1].lastRunConclusion).toBe("success");
  });

  it("handles a repo with no run known for a PR", () => {
    const { events } = diffRepoState([pr({})], new Map(), {
      1: { state: "OPEN", lastRunConclusion: null },
    });
    expect(events.filter((e) => e.event === "check_suite")).toEqual([]);
  });
});

describe("parsePollStateText", () => {
  it("parses a valid state object", () => {
    expect(
      parsePollStateText('{"acme/widgets":{"1":{"state":"OPEN","lastRunConclusion":null}}}'),
    ).toEqual({
      "acme/widgets": { "1": { state: "OPEN", lastRunConclusion: null } },
    });
  });

  it("rejects non-object JSON", () => {
    expect(() => parsePollStateText("[]")).toThrow();
    expect(() => parsePollStateText("42")).toThrow();
  });
});
