import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WorkerConfig, WorkerProject } from "../../scripts/worker-select.js";

const attemptAutoRebase = vi.fn();
const mergeAgentPr = vi.fn();
const pollUntilMergeable = vi.fn();
const ensureCleanClone = vi.fn();
const runVerification = vi.fn();
const runDeploy = vi.fn();
const findOpenAgentPr = vi.fn();
const findMergedAgentPr = vi.fn();
const dispatchConflictResolution = vi.fn();
const originOwnerRepo = vi.fn();
const prFreshness = vi.fn();

vi.mock("../../scripts/delivery-exec.js", () => ({
  attemptAutoRebase: (...args: unknown[]) => attemptAutoRebase(...args),
  mergeAgentPr: (...args: unknown[]) => mergeAgentPr(...args),
  pollUntilMergeable: (...args: unknown[]) => pollUntilMergeable(...args),
  ensureCleanClone: (...args: unknown[]) => ensureCleanClone(...args),
  runVerification: (...args: unknown[]) => runVerification(...args),
  runDeploy: (...args: unknown[]) => runDeploy(...args),
  findOpenAgentPr: (...args: unknown[]) => findOpenAgentPr(...args),
  findMergedAgentPr: (...args: unknown[]) => findMergedAgentPr(...args),
  dispatchConflictResolution: (...args: unknown[]) => dispatchConflictResolution(...args),
  originOwnerRepo: (...args: unknown[]) => originOwnerRepo(...args),
  prFreshness: (...args: unknown[]) => prFreshness(...args),
}));

const { deliverQueue } = await import("../../scripts/deliver.js");

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
  const project: WorkerProject = { repo: "/repo/syd" };
  const token = "test-token";

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    attemptAutoRebase.mockReset();
    mergeAgentPr.mockReset();
    pollUntilMergeable.mockReset();
    ensureCleanClone.mockReset();
    runVerification.mockReset();
    runDeploy.mockReset();
    originOwnerRepo.mockReset();
    prFreshness.mockReset();
    prFreshness.mockRejectedValue(new Error("gh unavailable in tests"));
    pollUntilMergeable.mockResolvedValue("MERGEABLE");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not re-rebase a post-merge finishDelivery failure (comment POST fails after a successful merge)", async () => {
    attemptAutoRebase.mockResolvedValue({ status: "rebased", sha: "rebased-sha" });
    mergeAgentPr.mockResolvedValue("merged-sha");
    // Non-TypeError so worker-select's isRetryableError treats it as
    // non-retryable and postWithRetry throws immediately instead of running
    // the real ~45s backoff schedule.
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("tracker down"));

    await expect(deliverQueue("SYD-174", project, config, token, "/clone/syd", 42)).rejects.toThrow(
      "tracker down",
    );

    // The merge succeeded — main already has the commit — so the failure must
    // propagate rather than being treated as "main moved again, re-rebase".
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

    await deliverQueue("SYD-174", project, config, token, "/clone/syd", 42);

    expect(attemptAutoRebase).toHaveBeenCalledTimes(2);
    expect(mergeAgentPr).toHaveBeenCalledTimes(2);
  });

  it("names the origin repo on the delivered event (SYD-205)", async () => {
    attemptAutoRebase.mockResolvedValue({ status: "rebased", sha: "rebased-sha" });
    mergeAgentPr.mockResolvedValue("merged-sha");
    originOwnerRepo.mockResolvedValue("acme/widgets");
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    await deliverQueue("SYD-174", project, config, token, "/clone/syd", 42);

    const eventCalls = fetchMock.mock.calls.filter(([url]) =>
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
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    await deliverQueue("SYD-174", project, config, token, "/clone/syd", 42);

    const eventCalls = fetchMock.mock.calls.filter(([url]) =>
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
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    await deliverQueue("SYD-174", project, config, token, "/clone/syd", 42);

    const eventCalls = fetchMock.mock.calls.filter(([url]) =>
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
