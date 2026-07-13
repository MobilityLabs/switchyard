import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WorkerConfig, WorkerProject } from "../../scripts/worker-select.js";
import { newTickGate } from "../../scripts/worker-select.js";
import type { DeliveryWork } from "../../scripts/delivery-lib.js";

const attemptAutoRebase = vi.fn();
const mergeAgentPr = vi.fn();
const pollUntilMergeable = vi.fn();
const waitForChecks = vi.fn();
const ensureCleanClone = vi.fn();
const runDeploy = vi.fn();
const findOpenAgentPr = vi.fn();
const findMergedAgentPr = vi.fn();
const originOwnerRepo = vi.fn();
const prFreshness = vi.fn();
const prLiveState = vi.fn();
const checkBranchProtection = vi.fn();
const closeDeadAgentPr = vi.fn();

vi.mock("../../scripts/delivery-exec.js", () => ({
  attemptAutoRebase: (...args: unknown[]) => attemptAutoRebase(...args),
  mergeAgentPr: (...args: unknown[]) => mergeAgentPr(...args),
  pollUntilMergeable: (...args: unknown[]) => pollUntilMergeable(...args),
  waitForChecks: (...args: unknown[]) => waitForChecks(...args),
  ensureCleanClone: (...args: unknown[]) => ensureCleanClone(...args),
  runDeploy: (...args: unknown[]) => runDeploy(...args),
  findOpenAgentPr: (...args: unknown[]) => findOpenAgentPr(...args),
  findMergedAgentPr: (...args: unknown[]) => findMergedAgentPr(...args),
  originOwnerRepo: (...args: unknown[]) => originOwnerRepo(...args),
  prFreshness: (...args: unknown[]) => prFreshness(...args),
  prLiveState: (...args: unknown[]) => prLiveState(...args),
  checkBranchProtection: (...args: unknown[]) => checkBranchProtection(...args),
  closeDeadAgentPr: (...args: unknown[]) => closeDeadAgentPr(...args),
}));

const { deliverQueue, tick, warnOnRelaxedBranchProtection } = await import("../../scripts/deliver.js");

const token = "test-token";
const project: WorkerProject = { repo: "/repo/syd" };

// A fetch mock that answers GET /api/delivery-work with `work`, returns a
// fresh attempt id for each POST .../delivery-attempts, and 200s everything
// else (comments, delivery-events, PATCH finishes, derived-head PATCH).
function installFetch(work: DeliveryWork): ReturnType<typeof vi.fn> {
  let nextAttemptId = 100;
  const mock = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u.endsWith("/api/delivery-work")) {
      return new Response(JSON.stringify(work), { status: 200 });
    }
    if (u.endsWith("/delivery-attempts") && method === "POST") {
      return new Response(JSON.stringify({ id: nextAttemptId++ }), { status: 200 });
    }
    return new Response(null, { status: 200 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function fetchMock(): ReturnType<typeof vi.fn> {
  return fetch as unknown as ReturnType<typeof vi.fn>;
}

function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[1] as RequestInit).body as string);
}

function startCalls(ref: string): unknown[][] {
  return fetchMock().mock.calls.filter(
    ([u, init]) =>
      String(u).endsWith(`/api/issues/${ref}/delivery-attempts`) &&
      (init as RequestInit | undefined)?.method === "POST",
  );
}

/** Terminal finishes: PATCH /api/delivery-attempts/:id (never the /derived-head sub-path). */
function patchCalls(): unknown[][] {
  return fetchMock().mock.calls.filter(
    ([u, init]) =>
      /\/api\/delivery-attempts\/\d+$/.test(String(u)) &&
      (init as RequestInit | undefined)?.method === "PATCH",
  );
}

/** Interim S1 persists: PATCH /api/delivery-attempts/:id/derived-head. */
function derivedHeadCalls(): unknown[][] {
  return fetchMock().mock.calls.filter(
    ([u, init]) =>
      String(u).includes("/derived-head") &&
      (init as RequestInit | undefined)?.method === "PATCH",
  );
}

function deliveryEventCalls(ref: string): unknown[][] {
  return fetchMock().mock.calls.filter(([u]) =>
    String(u).endsWith(`/api/issues/${ref}/delivery-events`),
  );
}

function resetExecMocks(): void {
  for (const m of [
    attemptAutoRebase,
    mergeAgentPr,
    pollUntilMergeable,
    waitForChecks,
    ensureCleanClone,
    runDeploy,
    findMergedAgentPr,
    originOwnerRepo,
    prFreshness,
    prLiveState,
    checkBranchProtection,
    closeDeadAgentPr,
  ]) {
    m.mockReset();
  }
  pollUntilMergeable.mockResolvedValue("MERGEABLE");
  waitForChecks.mockResolvedValue("passing");
  ensureCleanClone.mockResolvedValue(undefined);
  runDeploy.mockResolvedValue({ ran: true, ok: true, tail: "" });
  findMergedAgentPr.mockResolvedValue(null);
  originOwnerRepo.mockResolvedValue("acme/widgets");
  prFreshness.mockRejectedValue(new Error("gh unavailable in tests"));
  closeDeadAgentPr.mockResolvedValue(undefined);
}

describe("delivery worker trigger (SYD-208/209)", () => {
  const config: WorkerConfig = {
    url: "http://localhost:3300",
    label: "auto",
    intervalSeconds: 300,
    maxConcurrent: 1,
    projects: { SYD: { repo: "/repo/syd" } },
    delivery: { deploy: false },
  };
  const deployConfig: WorkerConfig = { ...config, delivery: {} };

  beforeEach(() => resetExecMocks());
  afterEach(() => vi.unstubAllGlobals());

  const pendingWork = (pin: DeliveryWork["pending"][number]["pin"]): DeliveryWork => ({
    pending: [{ authorizationId: 5, ref: "SYD-9", kind: "done_stamp", pin }],
    unfinished: [],
    deployRetries: [],
  });

  it("an OPEN pin rebases, persists S1, waits for green, merges with the head pinned, finishes merged_deployed", async () => {
    installFetch(pendingWork({ repo: "acme/widgets", prNumber: 42, headSha: "s0abc" }));
    prLiveState.mockResolvedValue({ state: "OPEN", headRefOid: "s0abc", mergeCommit: null });
    attemptAutoRebase.mockResolvedValue({ status: "rebased", sha: "s1def" });
    waitForChecks.mockResolvedValue("passing");
    mergeAgentPr.mockResolvedValue("merged-sha");

    await tick(config, token, newTickGate(), false);

    // Anchored on S0 (the pinned head).
    expect(attemptAutoRebase).toHaveBeenCalledWith("/repo/syd", expect.any(String), "SYD-9", ["s0abc"]);
    // S1 persisted mid-attempt before the merge.
    const dh = derivedHeadCalls();
    expect(dh).toHaveLength(1);
    expect(bodyOf(dh[0])).toEqual({ derivedHeadSha: "s1def" });
    // Waited for checks on S1, then merged with S1 pinned.
    expect(waitForChecks).toHaveBeenCalledWith("/repo/syd", 42, "s1def");
    expect(mergeAgentPr).toHaveBeenCalledWith("/repo/syd", 42, "s1def");

    const patches = patchCalls();
    expect(patches).toHaveLength(1);
    expect(bodyOf(patches[0])).toMatchObject({ outcome: "merged_deployed", derivedHeadSha: "s1def" });
  });

  it("a third-party push after the stamp (S0 anchor fails) disarms — sha_chain_disarmed, never merges", async () => {
    installFetch(pendingWork({ repo: "acme/widgets", prNumber: 42, headSha: "s0abc" }));
    prLiveState.mockResolvedValue({ state: "OPEN", headRefOid: "s0abc", mergeCommit: null });
    attemptAutoRebase.mockResolvedValue({ status: "head-moved", observed: "intruder-sha" });

    await tick(config, token, newTickGate(), false);

    expect(mergeAgentPr).not.toHaveBeenCalled();
    expect(bodyOf(patchCalls()[0])).toMatchObject({ outcome: "sha_chain_disarmed" });
    const events = deliveryEventCalls("SYD-9");
    expect(events).toHaveLength(1);
    expect(bodyOf(events[0])).toMatchObject({ type: "delivery_failed" });
  });

  it("seeds the anchor with the worker's prior derived heads so its own rebase isn't disarmed (SYD-231)", async () => {
    // A re-stamp still pinned to S0, but a prior attempt already force-pushed
    // its rebase "s1prev" — so the branch sits at s1prev, not S0.
    installFetch({
      pending: [
        {
          authorizationId: 5,
          ref: "SYD-9",
          kind: "redeliver",
          pin: { repo: "acme/widgets", prNumber: 42, headSha: "s0abc" },
          priorHeads: ["s1prev"],
        },
      ],
      unfinished: [],
      deployRetries: [],
    });
    prLiveState.mockResolvedValue({ state: "OPEN", headRefOid: "s1prev", mergeCommit: null });
    attemptAutoRebase.mockResolvedValue({ status: "rebased", sha: "s2new" });
    waitForChecks.mockResolvedValue("passing");
    mergeAgentPr.mockResolvedValue("merged-sha");

    await tick(config, token, newTickGate(), false);

    // Anchor carries S0 AND the prior derived head, so attemptAutoRebase accepts
    // the branch's current head (s1prev) as the worker's own rather than disarming.
    expect(attemptAutoRebase).toHaveBeenCalledWith("/repo/syd", expect.any(String), "SYD-9", [
      "s0abc",
      "s1prev",
    ]);
    expect(mergeAgentPr).toHaveBeenCalledWith("/repo/syd", 42, "s2new");
    expect(bodyOf(patchCalls()[0])).toMatchObject({ outcome: "merged_deployed" });
  });

  it("a pin with no headSha (no S0 to anchor) disarms without touching the branch", async () => {
    installFetch(pendingWork({ repo: "acme/widgets", prNumber: 42, headSha: null }));
    prLiveState.mockResolvedValue({ state: "OPEN", headRefOid: "whatever", mergeCommit: null });

    await tick(config, token, newTickGate(), false);

    expect(attemptAutoRebase).not.toHaveBeenCalled();
    expect(mergeAgentPr).not.toHaveBeenCalled();
    expect(bodyOf(patchCalls()[0])).toMatchObject({ outcome: "sha_chain_disarmed" });
  });

  it("a red required check on S1 finishes verify_failed with a delivery_failed event (Retry keeps working)", async () => {
    installFetch(pendingWork({ repo: "acme/widgets", prNumber: 42, headSha: "s0abc" }));
    prLiveState.mockResolvedValue({ state: "OPEN", headRefOid: "s0abc", mergeCommit: null });
    attemptAutoRebase.mockResolvedValue({ status: "rebased", sha: "s1def" });
    waitForChecks.mockResolvedValue("failing");

    await tick(config, token, newTickGate(), false);

    expect(mergeAgentPr).not.toHaveBeenCalled();
    expect(bodyOf(patchCalls()[0])).toMatchObject({ outcome: "verify_failed", derivedHeadSha: "s1def" });
    expect(bodyOf(deliveryEventCalls("SYD-9")[0])).toMatchObject({ type: "delivery_failed" });
  });

  it("a checks wait that never concludes finishes checks_timeout, never merging", async () => {
    installFetch(pendingWork({ repo: "acme/widgets", prNumber: 42, headSha: "s0abc" }));
    prLiveState.mockResolvedValue({ state: "OPEN", headRefOid: "s0abc", mergeCommit: null });
    attemptAutoRebase.mockResolvedValue({ status: "rebased", sha: "s1def" });
    waitForChecks.mockResolvedValue("pending"); // wait budget elapsed while pending

    await tick(config, token, newTickGate(), false);

    expect(mergeAgentPr).not.toHaveBeenCalled();
    expect(bodyOf(patchCalls()[0])).toMatchObject({ outcome: "checks_timeout", derivedHeadSha: "s1def" });
    expect(bodyOf(deliveryEventCalls("SYD-9")[0])).toMatchObject({ type: "delivery_failed" });
  });

  it("a pending PR already MERGED live never re-merges — deploy tail only, outcome merged_deployed", async () => {
    installFetch(pendingWork({ repo: "acme/widgets", prNumber: 42, headSha: "s0abc" }));
    prLiveState.mockResolvedValue({ state: "MERGED", headRefOid: "s0abc", mergeCommit: "m-sha" });

    await tick(deployConfig, token, newTickGate(), false);

    expect(mergeAgentPr).not.toHaveBeenCalled();
    expect(attemptAutoRebase).not.toHaveBeenCalled();
    expect(ensureCleanClone).toHaveBeenCalledTimes(1); // deploy tail ran
    expect(runDeploy).toHaveBeenCalledTimes(1);
    expect(bodyOf(patchCalls()[0])).toMatchObject({ outcome: "merged_deployed" });
  });

  it("a pending CLOSED-unmerged pin with no replacement PR finishes merge_failed with an actionable delivery_failed event, never merging (SYD-232)", async () => {
    installFetch(pendingWork({ repo: "acme/widgets", prNumber: 42, headSha: "s0abc" }));
    prLiveState.mockResolvedValue({ state: "CLOSED", headRefOid: "s0abc", mergeCommit: null });
    findMergedAgentPr.mockResolvedValue(null);

    await tick(config, token, newTickGate(), false);

    expect(findMergedAgentPr).toHaveBeenCalledWith("/repo/syd", "SYD-9");
    expect(mergeAgentPr).not.toHaveBeenCalled();
    expect(bodyOf(patchCalls()[0])).toMatchObject({ outcome: "merge_failed" });
    const event = bodyOf(deliveryEventCalls("SYD-9")[0]);
    expect(event).toMatchObject({ type: "delivery_failed" });
    expect(String(event.message)).toContain("no later merged PR");
    const comments = fetchMock().mock.calls.filter(([u]) => String(u).endsWith("/comments"));
    const commentBody = bodyOf(comments[0]).body as string;
    expect(commentBody).toContain("Re-open PR #42");
    expect(commentBody).toContain("re-run the agent");
  });

  it("a pending CLOSED-unmerged pin whose branch already delivered via a replacement PR reconciles to merged_deployed instead of failing (SYD-232)", async () => {
    installFetch(pendingWork({ repo: "acme/widgets", prNumber: 61, headSha: "s0abc" }));
    prLiveState.mockResolvedValue({ state: "CLOSED", headRefOid: "s0abc", mergeCommit: null });
    findMergedAgentPr.mockResolvedValue({ prNumber: 124, mergeSha: "replacement-sha" });

    await tick(config, token, newTickGate(), false);

    expect(findMergedAgentPr).toHaveBeenCalledWith("/repo/syd", "SYD-9");
    expect(mergeAgentPr).not.toHaveBeenCalled();
    expect(attemptAutoRebase).not.toHaveBeenCalled();
    expect(bodyOf(patchCalls()[0])).toMatchObject({ outcome: "merged_deployed" });
    const event = bodyOf(deliveryEventCalls("SYD-9")[0]);
    expect(event).toMatchObject({
      type: "delivered",
      prNumber: 124,
      mergeSha: "replacement-sha",
    });
    const comments = fetchMock().mock.calls.filter(([u]) => String(u).endsWith("/comments"));
    const commentBody = bodyOf(comments[0]).body as string;
    expect(commentBody).toContain("PR #61");
    expect(commentBody).toContain("PR #124");
    expect(commentBody).toContain("replacement-sha");
  });

  it("a pending authorization with no pin is a quiet no-op skip (interactive work, defensive only)", async () => {
    installFetch(pendingWork(null));

    await tick(config, token, newTickGate(), false);

    expect(prLiveState).not.toHaveBeenCalled();
    expect(mergeAgentPr).not.toHaveBeenCalled();
    expect(startCalls("SYD-9")).toHaveLength(0);
    expect(patchCalls()).toHaveLength(0);
    expect(deliveryEventCalls("SYD-9")).toHaveLength(0);
    const comments = fetchMock().mock.calls.filter(([u]) => String(u).endsWith("/comments"));
    expect(comments).toHaveLength(0);
  });

  it("resumes a crashed attempt whose PR is now MERGED — deploy tail, finished merged_deployed, never re-merged", async () => {
    const work: DeliveryWork = {
      pending: [],
      unfinished: [
        {
          id: 200,
          issueRef: "SYD-9",
          prNumber: 42,
          headSha: "s0abc",
          derivedHeadSha: "s1def",
          authorizationId: 5,
          startedAt: 0,
        },
      ],
      deployRetries: [],
    };
    installFetch(work);
    prLiveState.mockResolvedValue({ state: "MERGED", headRefOid: "s1def", mergeCommit: "m-sha" });

    await tick(deployConfig, token, newTickGate(), false);

    expect(mergeAgentPr).not.toHaveBeenCalled();
    expect(ensureCleanClone).toHaveBeenCalledTimes(1);
    const patches = patchCalls();
    expect(patches).toHaveLength(1);
    expect(String(patches[0][0])).toContain("/api/delivery-attempts/200");
    expect(bodyOf(patches[0])).toMatchObject({ outcome: "merged_deployed" });
    expect(startCalls("SYD-9")).toHaveLength(0);
  });

  it("resumes a crashed OPEN attempt — re-anchors on S0 and the persisted S1 and re-drives to merge", async () => {
    const work: DeliveryWork = {
      pending: [],
      unfinished: [
        {
          id: 200,
          issueRef: "SYD-9",
          prNumber: 42,
          headSha: "s0abc",
          derivedHeadSha: "s1def",
          authorizationId: 5,
          startedAt: 0,
        },
      ],
      deployRetries: [],
    };
    installFetch(work);
    prLiveState.mockResolvedValue({ state: "OPEN", headRefOid: "s1def", mergeCommit: null });
    attemptAutoRebase.mockResolvedValue({ status: "rebased", sha: "s1new" });
    waitForChecks.mockResolvedValue("passing");
    mergeAgentPr.mockResolvedValue("merged-sha");

    await tick(deployConfig, token, newTickGate(), false);

    // Re-anchor accepts BOTH the stamped S0 and the persisted S1.
    expect(attemptAutoRebase).toHaveBeenCalledWith("/repo/syd", expect.any(String), "SYD-9", [
      "s0abc",
      "s1def",
    ]);
    expect(mergeAgentPr).toHaveBeenCalledWith("/repo/syd", 42, "s1new");
    const patches = patchCalls();
    expect(String(patches.at(-1)![0])).toContain("/api/delivery-attempts/200");
    expect(bodyOf(patches.at(-1)!)).toMatchObject({ outcome: "merged_deployed" });
    // Never opened a NEW attempt row — finished the crashed one.
    expect(startCalls("SYD-9")).toHaveLength(0);
  });

  it("resumes a crashed OPEN attempt with no authorized head recorded — finishes merge_failed", async () => {
    const work: DeliveryWork = {
      pending: [],
      unfinished: [
        {
          id: 200,
          issueRef: "SYD-9",
          prNumber: 42,
          headSha: null,
          derivedHeadSha: null,
          authorizationId: 5,
          startedAt: 0,
        },
      ],
      deployRetries: [],
    };
    installFetch(work);
    prLiveState.mockResolvedValue({ state: "OPEN", headRefOid: "x", mergeCommit: null });

    await tick(config, token, newTickGate(), false);

    expect(attemptAutoRebase).not.toHaveBeenCalled();
    expect(mergeAgentPr).not.toHaveBeenCalled();
    expect(bodyOf(patchCalls()[0])).toMatchObject({ outcome: "merge_failed" });
  });

  it("a deploy retry runs the deploy tail only — never rebase/merge — and starts with deployRetry:true", async () => {
    const work: DeliveryWork = {
      pending: [],
      unfinished: [],
      deployRetries: [
        { authorizationId: 5, ref: "SYD-9", prNumber: 42, headSha: "s0abc", retryNumber: 1 },
      ],
    };
    installFetch(work);
    prLiveState.mockResolvedValue({ state: "MERGED", headRefOid: "s0abc", mergeCommit: "m-sha" });

    await tick(deployConfig, token, newTickGate(), false);

    expect(attemptAutoRebase).not.toHaveBeenCalled();
    expect(mergeAgentPr).not.toHaveBeenCalled();
    expect(ensureCleanClone).toHaveBeenCalledTimes(1);
    expect(runDeploy).toHaveBeenCalledTimes(1);
    const started = startCalls("SYD-9");
    expect(started).toHaveLength(1);
    expect(bodyOf(started[0])).toMatchObject({ authorizationId: 5, deployRetry: true });
    expect(bodyOf(patchCalls()[0])).toMatchObject({ outcome: "merged_deployed" });
  });

  it("--dry-run performs zero POST/PATCH mutations", async () => {
    const work: DeliveryWork = {
      pending: [
        {
          authorizationId: 5,
          ref: "SYD-9",
          kind: "done_stamp",
          pin: { repo: "acme/widgets", prNumber: 42, headSha: "s0abc" },
        },
      ],
      unfinished: [
        {
          id: 200,
          issueRef: "SYD-9",
          prNumber: 42,
          headSha: "s0abc",
          derivedHeadSha: null,
          authorizationId: 4,
          startedAt: 0,
        },
      ],
      deployRetries: [
        { authorizationId: 6, ref: "SYD-9", prNumber: 43, headSha: "def456", retryNumber: 1 },
      ],
    };
    const mock = installFetch(work);

    await tick(config, token, newTickGate(), true);

    const mutating = mock.mock.calls.filter(([, init]) => {
      const method = (init as RequestInit | undefined)?.method ?? "GET";
      return method !== "GET";
    });
    expect(mutating).toHaveLength(0);
    expect(prLiveState).not.toHaveBeenCalled();
    expect(mergeAgentPr).not.toHaveBeenCalled();
  });

  it("skips refs outside the configured projects", async () => {
    const work: DeliveryWork = {
      pending: [
        { authorizationId: 5, ref: "OTHER-1", kind: "done_stamp", pin: { repo: "x/y", prNumber: 1, headSha: null } },
      ],
      unfinished: [
        { id: 9, issueRef: "OTHER-2", prNumber: 2, headSha: null, derivedHeadSha: null, authorizationId: 6, startedAt: 0 },
      ],
      deployRetries: [{ authorizationId: 7, ref: "OTHER-3", prNumber: 3, headSha: null, retryNumber: 1 }],
    };
    installFetch(work);

    await tick(config, token, newTickGate(), false);

    expect(prLiveState).not.toHaveBeenCalled();
    expect(startCalls("OTHER-1")).toHaveLength(0);
    expect(patchCalls()).toHaveLength(0);
  });
});

describe("deliverQueue orchestrator (SYD-209)", () => {
  const config: WorkerConfig = {
    url: "http://localhost:3300",
    label: "auto",
    intervalSeconds: 300,
    maxConcurrent: 1,
    projects: { SYD: { repo: "/repo/syd" } },
    // Skip deploy so finishDelivery goes straight to the comment/event POSTs.
    delivery: { deploy: false },
  };
  const ATTEMPT_ID = 100;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    resetExecMocks();
  });
  afterEach(() => vi.unstubAllGlobals());

  function call(): Promise<{ outcome: string; derivedHeadSha?: string }> {
    return deliverQueue("SYD-174", project, config, token, "/clone/syd", 42, ["s0abc"], ATTEMPT_ID);
  }

  it("rebases, persists S1, waits for green, merges with S1 pinned", async () => {
    attemptAutoRebase.mockResolvedValue({ status: "rebased", sha: "s1def" });
    waitForChecks.mockResolvedValue("passing");
    mergeAgentPr.mockResolvedValue("merged-sha");

    const result = await call();

    expect(result.outcome).toBe("merged_deployed");
    expect(result.derivedHeadSha).toBe("s1def");
    expect(mergeAgentPr).toHaveBeenCalledWith("/repo/syd", 42, "s1def");
    const dh = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([u]) =>
      String(u).endsWith(`/api/delivery-attempts/${ATTEMPT_ID}/derived-head`),
    );
    expect(dh).toHaveLength(1);
  });

  it("a broken SHA chain (attemptAutoRebase head-moved) bounces sha_chain_disarmed, never merging", async () => {
    attemptAutoRebase.mockResolvedValue({ status: "head-moved", observed: "intruder" });

    const result = await call();

    expect(result.outcome).toBe("sha_chain_disarmed");
    expect(waitForChecks).not.toHaveBeenCalled();
    expect(mergeAgentPr).not.toHaveBeenCalled();
  });

  it("a rebase conflict bounces conflict_bounced, never merging, and closes the dead PR (SYD-165)", async () => {
    attemptAutoRebase.mockResolvedValue({ status: "conflict", files: ["src/a.ts"] });

    const result = await call();

    expect(result.outcome).toBe("conflict_bounced");
    expect(mergeAgentPr).not.toHaveBeenCalled();
    expect(closeDeadAgentPr).toHaveBeenCalledWith("/repo/syd", 42, { deleteBranch: true });
  });

  it("a conflict bounce still returns conflict_bounced even if closing the dead PR fails (SYD-165)", async () => {
    attemptAutoRebase.mockResolvedValue({ status: "conflict", files: ["src/a.ts"] });
    closeDeadAgentPr.mockRejectedValue(new Error("gh: PR already closed"));

    const result = await call();

    expect(result.outcome).toBe("conflict_bounced");
  });

  it("a no-branch rebase bounces merge_failed, never merging, and closes the dead PR without deleting a branch (SYD-165)", async () => {
    attemptAutoRebase.mockResolvedValue({ status: "no-branch" });

    const result = await call();

    expect(result.outcome).toBe("merge_failed");
    expect(waitForChecks).not.toHaveBeenCalled();
    expect(mergeAgentPr).not.toHaveBeenCalled();
    expect(closeDeadAgentPr).toHaveBeenCalledWith("/repo/syd", 42, { deleteBranch: false });
    const eventCalls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) =>
      String(url).endsWith("/api/issues/SYD-174/delivery-events"),
    );
    expect(eventCalls).toHaveLength(1);
    expect(JSON.parse((eventCalls[0][1] as RequestInit).body as string)).toMatchObject({
      type: "delivery_failed",
    });
  });

  it("a no-branch bounce still returns merge_failed even if closing the dead PR fails (SYD-165)", async () => {
    attemptAutoRebase.mockResolvedValue({ status: "no-branch" });
    closeDeadAgentPr.mockRejectedValue(new Error("gh: PR already closed"));

    const result = await call();

    expect(result.outcome).toBe("merge_failed");
  });

  it("a red check bounces verify_failed with S1 recorded", async () => {
    attemptAutoRebase.mockResolvedValue({ status: "rebased", sha: "s1def" });
    waitForChecks.mockResolvedValue("failing");

    const result = await call();

    expect(result.outcome).toBe("verify_failed");
    expect(result.derivedHeadSha).toBe("s1def");
    expect(mergeAgentPr).not.toHaveBeenCalled();
  });

  it("a checks timeout (still pending) bounces checks_timeout with S1 recorded", async () => {
    attemptAutoRebase.mockResolvedValue({ status: "rebased", sha: "s1def" });
    waitForChecks.mockResolvedValue("pending");

    const result = await call();

    expect(result.outcome).toBe("checks_timeout");
    expect(result.derivedHeadSha).toBe("s1def");
    expect(mergeAgentPr).not.toHaveBeenCalled();
  });

  it("a push during the green→merge window (waitForChecks head-moved) disarms", async () => {
    attemptAutoRebase.mockResolvedValue({ status: "rebased", sha: "s1def" });
    waitForChecks.mockResolvedValue("head-moved");
    prLiveState.mockResolvedValue({ state: "OPEN", headRefOid: "intruder", mergeCommit: null });

    const result = await call();

    expect(result.outcome).toBe("sha_chain_disarmed");
    expect(result.derivedHeadSha).toBe("s1def");
    expect(mergeAgentPr).not.toHaveBeenCalled();
  });

  it("maps a post-merge finishDelivery failure to merged_deploy_failed without re-rebasing (SYD-208)", async () => {
    attemptAutoRebase.mockResolvedValue({ status: "rebased", sha: "s1def" });
    waitForChecks.mockResolvedValue("passing");
    mergeAgentPr.mockResolvedValue("merged-sha");
    // The merge landed (mergeAgentPr resolved); the tracker then goes down for
    // the post-merge tail. A non-TypeError is treated as non-retryable so
    // postWithRetry throws immediately (no real backoff). The S1-persist PATCH
    // rejecting is .catch-swallowed; the post-merge comment POST throwing is
    // what runDeliveryTail maps to merged_deploy_failed (never a re-rebase).
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("tracker down"));

    const result = await call();

    expect(result.outcome).toBe("merged_deploy_failed");
    expect(attemptAutoRebase).toHaveBeenCalledTimes(1);
    expect(mergeAgentPr).toHaveBeenCalledTimes(1);
  });

  it("retries the whole cycle when the merge itself fails (main moved again)", async () => {
    attemptAutoRebase
      .mockResolvedValueOnce({ status: "rebased", sha: "s1a" })
      .mockResolvedValueOnce({ status: "rebased", sha: "s1b" });
    waitForChecks.mockResolvedValue("passing");
    mergeAgentPr
      .mockRejectedValueOnce(new Error("not mergeable"))
      .mockResolvedValueOnce("merged-sha");

    const result = await call();

    expect(result.outcome).toBe("merged_deployed");
    expect(result.derivedHeadSha).toBe("s1b");
    expect(attemptAutoRebase).toHaveBeenCalledTimes(2);
    expect(mergeAgentPr).toHaveBeenCalledTimes(2);
  });

  it("gives up once the merge-retry budget is exhausted", async () => {
    attemptAutoRebase.mockResolvedValue({ status: "rebased", sha: "s1def" });
    waitForChecks.mockResolvedValue("passing");
    mergeAgentPr.mockRejectedValue(new Error("not mergeable"));

    await expect(call()).rejects.toThrow("not mergeable");
    expect(mergeAgentPr).toHaveBeenCalledTimes(3); // MAX_QUEUE_MERGE_ATTEMPTS
  });

  it("names the origin repo on the delivered event (SYD-205)", async () => {
    attemptAutoRebase.mockResolvedValue({ status: "rebased", sha: "s1def" });
    waitForChecks.mockResolvedValue("passing");
    mergeAgentPr.mockResolvedValue("merged-sha");
    originOwnerRepo.mockResolvedValue("acme/widgets");

    await call();

    const eventCalls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) =>
      String(url).endsWith("/api/issues/SYD-174/delivery-events"),
    );
    expect(eventCalls).toHaveLength(1);
    expect(JSON.parse((eventCalls[0][1] as RequestInit).body as string)).toMatchObject({
      type: "delivered",
      prNumber: 42,
      mergeSha: "merged-sha",
      repo: "acme/widgets",
    });
  });

  it("posts the delivery event without a repo when the origin lookup fails (never drops the event)", async () => {
    attemptAutoRebase.mockResolvedValue({ status: "rebased", sha: "s1def" });
    waitForChecks.mockResolvedValue("passing");
    mergeAgentPr.mockResolvedValue("merged-sha");
    originOwnerRepo.mockRejectedValue(new Error("no origin remote"));

    await call();

    const eventCalls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) =>
      String(url).endsWith("/api/issues/SYD-174/delivery-events"),
    );
    expect(eventCalls).toHaveLength(1);
    const posted = JSON.parse((eventCalls[0][1] as RequestInit).body as string);
    expect(posted).toMatchObject({ type: "delivered", prNumber: 42 });
    expect(posted.repo).toBeUndefined();
  });

  it("attaches GitHub's own head/timestamp to the delivered event when the lookup succeeds (SYD-206)", async () => {
    attemptAutoRebase.mockResolvedValue({ status: "rebased", sha: "s1def" });
    waitForChecks.mockResolvedValue("passing");
    mergeAgentPr.mockResolvedValue("merged-sha");
    originOwnerRepo.mockResolvedValue("acme/widgets");
    prFreshness.mockResolvedValue({ headSha: "f".repeat(40), ghUpdatedAt: "2026-07-12T11:00:00Z" });

    await call();

    const eventCalls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) =>
      String(url).endsWith("/api/issues/SYD-174/delivery-events"),
    );
    expect(eventCalls).toHaveLength(1);
    expect(JSON.parse((eventCalls[0][1] as RequestInit).body as string)).toMatchObject({
      type: "delivered",
      headSha: "f".repeat(40),
      ghUpdatedAt: "2026-07-12T11:00:00Z",
    });
  });
});

describe("warnOnRelaxedBranchProtection (SYD-209/SYD-222)", () => {
  const config: WorkerConfig = {
    url: "http://localhost:3300",
    label: "auto",
    intervalSeconds: 300,
    maxConcurrent: 1,
    projects: { SYD: { repo: "/repo/syd" }, NOC: { repo: "/repo/noc" } },
  };

  beforeEach(() => resetExecMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("returns no failing keys when every linked repo's protection checks out", async () => {
    checkBranchProtection.mockResolvedValue({ ok: true, problems: [] });

    const failing = await warnOnRelaxedBranchProtection(config);

    expect(failing).toEqual([]);
    expect(checkBranchProtection).toHaveBeenCalledWith("/repo/syd");
    expect(checkBranchProtection).toHaveBeenCalledWith("/repo/noc");
  });

  it("returns the key of a repo whose protection is relaxed", async () => {
    checkBranchProtection.mockImplementation(async (repo: string) =>
      repo === "/repo/syd"
        ? { ok: false, problems: ["main has no required status checks (CI is not enforced)"] }
        : { ok: true, problems: [] },
    );

    const failing = await warnOnRelaxedBranchProtection(config);

    expect(failing).toEqual(["SYD"]);
  });

  it("treats a thrown check (e.g. no origin remote) as failing too — unverifiable is not verified", async () => {
    checkBranchProtection.mockRejectedValue(new Error("no origin remote"));

    const failing = await warnOnRelaxedBranchProtection(config);

    expect(failing).toEqual(["SYD", "NOC"]);
  });
});
