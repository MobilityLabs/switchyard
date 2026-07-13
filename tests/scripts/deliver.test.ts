import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WorkerConfig, WorkerProject } from "../../scripts/worker-select.js";
import { newTickGate } from "../../scripts/worker-select.js";
import type { DeliveryWork } from "../../scripts/delivery-lib.js";

const attemptAutoRebase = vi.fn();
const mergeAgentPr = vi.fn();
const pollUntilMergeable = vi.fn();
const ensureCleanClone = vi.fn();
const runVerification = vi.fn();
const runDeploy = vi.fn();
const findOpenAgentPr = vi.fn();
const dispatchConflictResolution = vi.fn();
const originOwnerRepo = vi.fn();
const prFreshness = vi.fn();
const prLiveState = vi.fn();

vi.mock("../../scripts/delivery-exec.js", () => ({
  attemptAutoRebase: (...args: unknown[]) => attemptAutoRebase(...args),
  mergeAgentPr: (...args: unknown[]) => mergeAgentPr(...args),
  pollUntilMergeable: (...args: unknown[]) => pollUntilMergeable(...args),
  ensureCleanClone: (...args: unknown[]) => ensureCleanClone(...args),
  runVerification: (...args: unknown[]) => runVerification(...args),
  runDeploy: (...args: unknown[]) => runDeploy(...args),
  findOpenAgentPr: (...args: unknown[]) => findOpenAgentPr(...args),
  dispatchConflictResolution: (...args: unknown[]) => dispatchConflictResolution(...args),
  originOwnerRepo: (...args: unknown[]) => originOwnerRepo(...args),
  prFreshness: (...args: unknown[]) => prFreshness(...args),
  prLiveState: (...args: unknown[]) => prLiveState(...args),
}));

const { deliverQueue, tick } = await import("../../scripts/deliver.js");

const token = "test-token";
const project: WorkerProject = { repo: "/repo/syd" };

// A fetch mock that answers GET /api/delivery-work with `work`, returns a
// fresh attempt id for each POST .../delivery-attempts, and 200s everything
// else (comments, delivery-events, PATCH finishes).
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

function patchCalls(): unknown[][] {
  return fetchMock().mock.calls.filter(
    ([u, init]) =>
      String(u).includes("/api/delivery-attempts/") &&
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
    ensureCleanClone,
    runVerification,
    runDeploy,
    originOwnerRepo,
    prFreshness,
    prLiveState,
  ]) {
    m.mockReset();
  }
  pollUntilMergeable.mockResolvedValue("MERGEABLE");
  ensureCleanClone.mockResolvedValue(undefined);
  runVerification.mockResolvedValue({ ok: true, tail: "" });
  runDeploy.mockResolvedValue({ ran: true, ok: true, tail: "" });
  originOwnerRepo.mockResolvedValue("acme/widgets");
  prFreshness.mockRejectedValue(new Error("gh unavailable in tests"));
}

describe("delivery worker trigger (SYD-208)", () => {
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

  it("a pending OPEN pin starts an attempt, merges via the existing flow, and finishes merged_deployed", async () => {
    installFetch(pendingWork({ repo: "acme/widgets", prNumber: 42, headSha: "abc123" }));
    prLiveState.mockResolvedValue({ state: "OPEN", headRefOid: "abc123", mergeCommit: null });
    mergeAgentPr.mockResolvedValue("merged-sha");

    await tick(config, token, newTickGate(), false);

    const started = startCalls("SYD-9");
    expect(started).toHaveLength(1);
    expect(bodyOf(started[0])).toEqual({ authorizationId: 5, prNumber: 42, headSha: "abc123" });

    expect(mergeAgentPr).toHaveBeenCalledTimes(1);

    const patches = patchCalls();
    expect(patches).toHaveLength(1);
    expect(String(patches[0][0])).toContain("/api/delivery-attempts/100");
    expect(bodyOf(patches[0])).toMatchObject({ outcome: "merged_deployed" });
  });

  it("a pending PR already MERGED live never re-merges — deploy tail only, outcome merged_deployed", async () => {
    installFetch(pendingWork({ repo: "acme/widgets", prNumber: 42, headSha: "abc123" }));
    prLiveState.mockResolvedValue({ state: "MERGED", headRefOid: "abc123", mergeCommit: "m-sha" });

    await tick(deployConfig, token, newTickGate(), false);

    expect(mergeAgentPr).not.toHaveBeenCalled();
    expect(attemptAutoRebase).not.toHaveBeenCalled();
    expect(ensureCleanClone).toHaveBeenCalledTimes(1); // deploy tail ran
    expect(runDeploy).toHaveBeenCalledTimes(1);

    const patches = patchCalls();
    expect(patches).toHaveLength(1);
    expect(bodyOf(patches[0])).toMatchObject({ outcome: "merged_deployed" });
  });

  it("a pending CLOSED-unmerged pin finishes merge_failed with a delivery_failed event, never merging", async () => {
    installFetch(pendingWork({ repo: "acme/widgets", prNumber: 42, headSha: "abc123" }));
    prLiveState.mockResolvedValue({ state: "CLOSED", headRefOid: "abc123", mergeCommit: null });

    await tick(config, token, newTickGate(), false);

    expect(mergeAgentPr).not.toHaveBeenCalled();
    expect(bodyOf(patchCalls()[0])).toMatchObject({ outcome: "merge_failed" });
    const events = deliveryEventCalls("SYD-9");
    expect(events).toHaveLength(1);
    expect(bodyOf(events[0])).toMatchObject({ type: "delivery_failed" });
  });

  it("a pending pin with no PR finishes merge_failed and posts a delivery_failed event", async () => {
    installFetch(pendingWork(null));

    await tick(config, token, newTickGate(), false);

    expect(prLiveState).not.toHaveBeenCalled();
    expect(mergeAgentPr).not.toHaveBeenCalled();
    expect(bodyOf(patchCalls()[0])).toMatchObject({ outcome: "merge_failed" });
    const events = deliveryEventCalls("SYD-9");
    expect(events).toHaveLength(1);
    expect(bodyOf(events[0])).toMatchObject({ type: "delivery_failed" });
  });

  it("a failed post-rebase verify finishes verify_failed and posts a delivery_failed event (Retry keeps working)", async () => {
    installFetch(pendingWork({ repo: "acme/widgets", prNumber: 42, headSha: "abc123" }));
    prLiveState.mockResolvedValue({ state: "OPEN", headRefOid: "abc123", mergeCommit: null });
    mergeAgentPr.mockRejectedValue(new Error("not mergeable"));
    attemptAutoRebase.mockResolvedValue({ status: "verify-failed", tail: "TypeError: boom" });

    await tick(config, token, newTickGate(), false);

    expect(bodyOf(patchCalls()[0])).toMatchObject({ outcome: "verify_failed" });
    const events = deliveryEventCalls("SYD-9");
    expect(events).toHaveLength(1);
    expect(bodyOf(events[0])).toMatchObject({ type: "delivery_failed" });
  });

  it("resumes a crashed attempt whose PR is now MERGED — deploy tail, finished merged_deployed, never re-merged", async () => {
    const work: DeliveryWork = {
      pending: [],
      unfinished: [
        {
          id: 200,
          issueRef: "SYD-9",
          prNumber: 42,
          headSha: "abc123",
          authorizationId: 5,
          startedAt: 0,
        },
      ],
      deployRetries: [],
    };
    installFetch(work);
    prLiveState.mockResolvedValue({ state: "MERGED", headRefOid: "abc123", mergeCommit: "m-sha" });

    await tick(deployConfig, token, newTickGate(), false);

    expect(mergeAgentPr).not.toHaveBeenCalled();
    expect(ensureCleanClone).toHaveBeenCalledTimes(1);
    const patches = patchCalls();
    expect(patches).toHaveLength(1);
    expect(String(patches[0][0])).toContain("/api/delivery-attempts/200");
    expect(bodyOf(patches[0])).toMatchObject({ outcome: "merged_deployed" });
    // A crash resumption never opens a new attempt row — it finishes the old one.
    expect(startCalls("SYD-9")).toHaveLength(0);
  });

  it("resumes a crashed attempt whose PR is still OPEN — finishes merge_failed with a delivery_failed event, never merging", async () => {
    const work: DeliveryWork = {
      pending: [],
      unfinished: [
        {
          id: 200,
          issueRef: "SYD-9",
          prNumber: 42,
          headSha: "abc123",
          authorizationId: 5,
          startedAt: 0,
        },
      ],
      deployRetries: [],
    };
    installFetch(work);
    prLiveState.mockResolvedValue({ state: "OPEN", headRefOid: "abc123", mergeCommit: null });

    await tick(config, token, newTickGate(), false);

    expect(mergeAgentPr).not.toHaveBeenCalled();
    expect(bodyOf(patchCalls()[0])).toMatchObject({ outcome: "merge_failed" });
    const events = deliveryEventCalls("SYD-9");
    expect(events).toHaveLength(1);
    expect(bodyOf(events[0])).toMatchObject({ type: "delivery_failed" });
  });

  it("a deploy retry runs the deploy tail only — never rebase/merge — and starts with deployRetry:true", async () => {
    const work: DeliveryWork = {
      pending: [],
      unfinished: [],
      deployRetries: [
        { authorizationId: 5, ref: "SYD-9", prNumber: 42, headSha: "abc123", retryNumber: 1 },
      ],
    };
    installFetch(work);
    prLiveState.mockResolvedValue({ state: "MERGED", headRefOid: "abc123", mergeCommit: "m-sha" });

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
      pending: [{ authorizationId: 5, ref: "SYD-9", kind: "done_stamp", pin: { repo: "acme/widgets", prNumber: 42, headSha: "abc123" } }],
      unfinished: [
        { id: 200, issueRef: "SYD-9", prNumber: 42, headSha: "abc123", authorizationId: 4, startedAt: 0 },
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
      pending: [{ authorizationId: 5, ref: "OTHER-1", kind: "done_stamp", pin: { repo: "x/y", prNumber: 1, headSha: null } }],
      unfinished: [{ id: 9, issueRef: "OTHER-2", prNumber: 2, headSha: null, authorizationId: 6, startedAt: 0 }],
      deployRetries: [{ authorizationId: 7, ref: "OTHER-3", prNumber: 3, headSha: null, retryNumber: 1 }],
    };
    installFetch(work);

    await tick(config, token, newTickGate(), false);

    expect(prLiveState).not.toHaveBeenCalled();
    expect(startCalls("OTHER-1")).toHaveLength(0);
    expect(patchCalls()).toHaveLength(0);
  });
});

describe("deliverQueue (SYD-174)", () => {
  const config: WorkerConfig = {
    url: "http://localhost:3300",
    label: "auto",
    intervalSeconds: 300,
    maxConcurrent: 1,
    projects: { SYD: { repo: "/repo/syd" } },
    // Skip deploy/verify so finishDelivery goes straight to the comment/event
    // POSTs that actually threw in the outage this issue describes.
    delivery: { mode: "queue", deploy: false },
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    resetExecMocks();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("maps a post-merge finishDelivery failure to merged_deploy_failed without re-rebasing (SYD-208)", async () => {
    attemptAutoRebase.mockResolvedValue({ status: "rebased", sha: "rebased-sha" });
    mergeAgentPr.mockResolvedValue("merged-sha");
    // Non-TypeError so worker-select's isRetryableError treats it as
    // non-retryable and postWithRetry throws immediately instead of running
    // the real ~45s backoff schedule.
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("tracker down"));

    const result = await deliverQueue("SYD-174", project, config, token, "/clone/syd", 42);

    // The merge succeeded — main already has the commit — so the failure is a
    // post-merge deploy problem (deploy-retry owns it), never a lost merge that
    // re-rebases or gets stamped merge_failed.
    expect(result.outcome).toBe("merged_deploy_failed");
    expect(attemptAutoRebase).toHaveBeenCalledTimes(1);
    expect(mergeAgentPr).toHaveBeenCalledTimes(1);
  });

  it("still retries the rebase when the merge itself fails (main moved again)", async () => {
    attemptAutoRebase.mockResolvedValue({ status: "rebased", sha: "rebased-sha" });
    mergeAgentPr
      .mockRejectedValueOnce(new Error("not mergeable"))
      .mockResolvedValueOnce("merged-sha");
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(null, { status: 200 }),
    );

    const result = await deliverQueue("SYD-174", project, config, token, "/clone/syd", 42);

    expect(result.outcome).toBe("merged_deployed");
    expect(result.derivedHeadSha).toBe("rebased-sha");
    expect(attemptAutoRebase).toHaveBeenCalledTimes(2);
    expect(mergeAgentPr).toHaveBeenCalledTimes(2);
  });

  it("names the origin repo on the delivered event (SYD-205)", async () => {
    attemptAutoRebase.mockResolvedValue({ status: "rebased", sha: "rebased-sha" });
    mergeAgentPr.mockResolvedValue("merged-sha");
    originOwnerRepo.mockResolvedValue("acme/widgets");
    const fetchM = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchM.mockResolvedValue(new Response(null, { status: 200 }));

    await deliverQueue("SYD-174", project, config, token, "/clone/syd", 42);

    const eventCalls = fetchM.mock.calls.filter(([url]) =>
      String(url).endsWith("/api/issues/SYD-174/delivery-events"),
    );
    expect(eventCalls).toHaveLength(1);
    expect(JSON.parse(eventCalls[0][1].body as string)).toMatchObject({
      type: "delivered",
      prNumber: 42,
      mergeSha: "merged-sha",
      repo: "acme/widgets",
    });
  });

  it("posts the delivery event without a repo when the origin lookup fails (never drops the event)", async () => {
    attemptAutoRebase.mockResolvedValue({ status: "rebased", sha: "rebased-sha" });
    mergeAgentPr.mockResolvedValue("merged-sha");
    originOwnerRepo.mockRejectedValue(new Error("no origin remote"));
    const fetchM = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchM.mockResolvedValue(new Response(null, { status: 200 }));

    await deliverQueue("SYD-174", project, config, token, "/clone/syd", 42);

    const eventCalls = fetchM.mock.calls.filter(([url]) =>
      String(url).endsWith("/api/issues/SYD-174/delivery-events"),
    );
    expect(eventCalls).toHaveLength(1);
    const posted = JSON.parse(eventCalls[0][1].body as string);
    expect(posted).toMatchObject({ type: "delivered", prNumber: 42 });
    expect(posted.repo).toBeUndefined();
  });

  it("attaches GitHub's own head/timestamp to the delivered event when the lookup succeeds (SYD-206)", async () => {
    attemptAutoRebase.mockResolvedValue({ status: "rebased", sha: "rebased-sha" });
    mergeAgentPr.mockResolvedValue("merged-sha");
    originOwnerRepo.mockResolvedValue("acme/widgets");
    prFreshness.mockResolvedValue({
      headSha: "f".repeat(40),
      ghUpdatedAt: "2026-07-12T11:00:00Z",
    });
    const fetchM = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchM.mockResolvedValue(new Response(null, { status: 200 }));

    await deliverQueue("SYD-174", project, config, token, "/clone/syd", 42);

    const eventCalls = fetchM.mock.calls.filter(([url]) =>
      String(url).endsWith("/api/issues/SYD-174/delivery-events"),
    );
    expect(eventCalls).toHaveLength(1);
    expect(JSON.parse(eventCalls[0][1].body as string)).toMatchObject({
      type: "delivered",
      headSha: "f".repeat(40),
      ghUpdatedAt: "2026-07-12T11:00:00Z",
    });
  });

  it("gives up once the queue-mode retry budget is exhausted", async () => {
    attemptAutoRebase.mockResolvedValue({ status: "rebased", sha: "rebased-sha" });
    mergeAgentPr.mockRejectedValue(new Error("not mergeable"));

    await expect(deliverQueue("SYD-174", project, config, token, "/clone/syd", 42)).rejects.toThrow(
      "not mergeable",
    );

    expect(mergeAgentPr).toHaveBeenCalledTimes(3); // MAX_QUEUE_MERGE_ATTEMPTS
  });
});
