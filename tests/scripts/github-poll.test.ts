// pollRepo sequencing (SYD-177): the tick loop's state file is what stops a
// PR from being re-announced, so it must only advance after the events for
// that repo actually landed on the tracker. The original code assigned
// state[fullName] before POSTing — one failed POST and the opened/closed
// event was lost forever (exactly how PR #61's gh_pr_opened went missing and
// SYD-108 got double-worked).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WorkerConfig } from "../../scripts/worker-select.js";
import type { GhPr, PollStateFile } from "../../scripts/github-poll-lib.js";

vi.mock("../../scripts/github-poll-exec.js", () => ({
  listPullRequests: vi.fn(),
  latestRun: vi.fn(async () => null),
}));

import { pollRepo } from "../../scripts/github-poll.js";
import { listPullRequests } from "../../scripts/github-poll-exec.js";

const config = { url: "http://tracker.test" } as WorkerConfig;

function openPr(number: number): GhPr {
  return {
    number,
    headRefName: `agent/SYD-${number}`,
    title: "t",
    body: null,
    url: `http://github.test/pull/${number}`,
    state: "OPEN",
    mergeCommit: null,
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pollRepo", () => {
  it("does not persist repo state when posting an event fails", async () => {
    vi.mocked(listPullRequests).mockResolvedValue([openPr(7)]);
    fetchMock.mockRejectedValue(new Error("tracker down"));

    const state: PollStateFile = {};
    await expect(pollRepo("acme/widgets", config, "tok", state, false)).rejects.toThrow(
      "tracker down",
    );
    // PR 7 must still look brand-new next tick so its opened event re-emits.
    expect(state).toEqual({});
  });

  it("persists repo state after events post successfully", async () => {
    vi.mocked(listPullRequests).mockResolvedValue([openPr(7)]);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, handled: true, ref: "SYD-7", type: "gh_pr_opened" }),
    });

    const state: PollStateFile = {};
    await pollRepo("acme/widgets", config, "tok", state, false);
    expect(state["acme/widgets"]).toEqual({ 7: { state: "OPEN", lastRunConclusion: null } });
  });

  it("re-POSTs opened for an already-tracked open PR (reconciliation reaches the wire)", async () => {
    vi.mocked(listPullRequests).mockResolvedValue([openPr(7)]);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, handled: true, duplicate: true }),
    });

    const state: PollStateFile = {
      "acme/widgets": { 7: { state: "OPEN", lastRunConclusion: null } },
    };
    await pollRepo("acme/widgets", config, "tok", state, false);
    const eventCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/api/github-events"),
    );
    expect(eventCalls).toHaveLength(1);
    expect(JSON.parse(eventCalls[0][1].body as string)).toMatchObject({
      event: "pull_request",
      payload: { action: "opened" },
    });
  });
});
