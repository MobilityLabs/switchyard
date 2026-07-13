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
  viewPullRequest: vi.fn(),
}));

import { pollRepo } from "../../scripts/github-poll.js";
import { listPullRequests, viewPullRequest } from "../../scripts/github-poll-exec.js";

const config = { url: "http://tracker.test" } as WorkerConfig;

function openPr(number: number): GhPr {
  return {
    number,
    headRefName: `agent/SYD-${number}`,
    headRefOid: "f".repeat(40),
    updatedAt: "2026-07-12T10:00:00Z",
    title: "t",
    body: null,
    url: `http://github.test/pull/${number}`,
    state: "OPEN",
    mergeCommit: null,
  };
}

const fetchMock = vi.fn();

/** Routes GET /api/pr-state to `openRows` and every other call (the
 * /api/github-events POSTs) to a generic ok outcome. */
function routeFetch(openRows: { prNumber: number }[]) {
  fetchMock.mockImplementation(async (url: unknown) => {
    if (String(url).includes("/api/pr-state")) {
      return { ok: true, json: async () => openRows };
    }
    return { ok: true, json: async () => ({ ok: true, handled: true, duplicate: true }) };
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.mocked(viewPullRequest).mockReset();
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

  it("posts a closed observation for a PR first observed already merged (upsert-observed-state, SYD-206)", async () => {
    vi.mocked(listPullRequests).mockResolvedValue([
      { ...openPr(7), state: "MERGED", mergeCommit: { oid: "abc" } },
    ]);
    routeFetch([]);

    await pollRepo("acme/widgets", config, "tok", {}, false);
    const eventCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/api/github-events"),
    );
    expect(eventCalls).toHaveLength(1);
    expect(JSON.parse(eventCalls[0][1].body as string)).toMatchObject({
      event: "pull_request",
      repo: "acme/widgets",
      payload: { action: "closed", pull_request: { merged: true } },
    });
  });

  it("gives an open pr_state row beyond the poll window a targeted gh pr view refresh (SYD-206)", async () => {
    vi.mocked(listPullRequests).mockResolvedValue([]); // window slid past it
    vi.mocked(viewPullRequest).mockResolvedValue(openPr(9));
    routeFetch([{ prNumber: 9 }]);

    const state: PollStateFile = {};
    await pollRepo("acme/widgets", config, "tok", state, false);

    expect(viewPullRequest).toHaveBeenCalledWith("acme/widgets", 9);
    const eventCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/api/github-events"),
    );
    expect(eventCalls).toHaveLength(1);
    expect(JSON.parse(eventCalls[0][1].body as string)).toMatchObject({
      event: "pull_request",
      payload: { action: "opened", pull_request: { number: 9 } },
    });
    expect(state["acme/widgets"][9].lastRefreshAt).toBeTypeOf("number");
  });

  it("skips a refresh candidate attempted more recently than the cadence interval", async () => {
    vi.mocked(listPullRequests).mockResolvedValue([]);
    routeFetch([{ prNumber: 9 }]);

    const state: PollStateFile = {
      "acme/widgets": {
        9: { state: "OPEN", lastRunConclusion: null, lastRefreshAt: Date.now() - 1000 },
      },
    };
    await pollRepo("acme/widgets", config, "tok", state, false);
    expect(viewPullRequest).not.toHaveBeenCalled();
  });

  it("raises the staleness alarm past consecutive refresh failures, and never transitions on error", async () => {
    vi.mocked(listPullRequests).mockResolvedValue([]);
    vi.mocked(viewPullRequest).mockRejectedValue(new Error("PR transferred"));
    routeFetch([{ prNumber: 9 }]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const state: PollStateFile = {
      "acme/widgets": {
        9: {
          state: "OPEN",
          lastRunConclusion: null,
          lastRefreshAt: Date.now() - 3_600_000,
          refreshFailures: 2,
        },
      },
    };
    await pollRepo("acme/widgets", config, "tok", state, false);

    expect(state["acme/widgets"][9].refreshFailures).toBe(3);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("STALE"));
    // No observation was posted for the unrefreshable PR.
    const eventCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/api/github-events"),
    );
    expect(eventCalls).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it("proceeds without targeted refresh when the server predates /api/pr-state (deploy skew)", async () => {
    vi.mocked(listPullRequests).mockResolvedValue([openPr(7)]);
    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url).includes("/api/pr-state")) {
        return { ok: false, status: 404, json: async () => ({}), text: async () => "nope" };
      }
      return { ok: true, json: async () => ({ ok: true, handled: true }) };
    });

    await pollRepo("acme/widgets", config, "tok", {}, false);
    expect(viewPullRequest).not.toHaveBeenCalled();
    const eventCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/api/github-events"),
    );
    expect(eventCalls).toHaveLength(1); // the window observation still posts
  });

  it("names the polled repo on every POST so the server never has to infer it (SYD-205)", async () => {
    vi.mocked(listPullRequests).mockResolvedValue([openPr(7)]);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, handled: true, ref: "SYD-7", type: "gh_pr_opened" }),
    });

    await pollRepo("acme/widgets", config, "tok", {}, false);
    const eventCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/api/github-events"),
    );
    expect(eventCalls).toHaveLength(1);
    const posted = JSON.parse(eventCalls[0][1].body as string);
    expect(posted.repo).toBe("acme/widgets");
    expect(posted.payload.pull_request).toMatchObject({
      head: { ref: "agent/SYD-7", sha: "f".repeat(40) },
      updated_at: "2026-07-12T10:00:00Z",
    });
  });
});
