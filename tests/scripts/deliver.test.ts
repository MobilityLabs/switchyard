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

  it("gives up once the queue-mode retry budget is exhausted", async () => {
    attemptAutoRebase.mockResolvedValue({ status: "rebased", sha: "rebased-sha" });
    mergeAgentPr.mockRejectedValue(new Error("not mergeable"));

    await expect(deliverQueue("SYD-174", project, config, token, "/clone/syd", 42)).rejects.toThrow(
      "not mergeable",
    );

    expect(mergeAgentPr).toHaveBeenCalledTimes(3); // MAX_QUEUE_MERGE_ATTEMPTS
  });
});
