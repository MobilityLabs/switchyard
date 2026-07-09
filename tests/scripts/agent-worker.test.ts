import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { answerKey, type WorkerConfig } from "../../scripts/worker-select.js";

const spawnMock = vi.fn();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    openSync: vi.fn(() => 1),
    closeSync: vi.fn(),
  };
});

const { buildPrompt, dispatchAnswer, active, answerState } = await import("../../scripts/agent-worker.js");

describe("buildPrompt", () => {
  it("builds the standard work prompt", () => {
    const prompt = buildPrompt("SYD-7");
    expect(prompt).toContain("SYD-7");
    expect(prompt).toContain("claim_issue");
    expect(prompt).toContain("in_review");
    expect(prompt).not.toMatch(/escalat/i);
  });

  it("primes a resumed session to read the human's answer in the activity feed", () => {
    const prompt = buildPrompt("SYD-7", { resumed: true });
    expect(prompt).toContain("SYD-7");
    expect(prompt).toMatch(/escalat/i);
    expect(prompt).toMatch(/answer/i);
    expect(prompt).toMatch(/get_issue|activity/i);
  });
});

/** Minimal stand-in for a Node ChildProcess: an EventEmitter with a `pid`, which
 * is exactly what dispatchAnswer's CLI branch touches. */
class FakeChildProcess extends EventEmitter {
  pid: number | undefined;
}

describe("dispatchAnswer (SYD-74: PATH pinning fallout)", () => {
  const ref = "SYD-74";
  const config: WorkerConfig = {
    url: "http://localhost:3300",
    label: "auto",
    intervalSeconds: 300,
    maxConcurrent: 2,
    projects: { SYD: { repo: "/repo/syd" } },
  };

  beforeEach(() => {
    active.clear();
    answerState.clear();
    spawnMock.mockReset();
  });

  it("logs the real pid and records the attempt only once the process actually spawns", () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    dispatchAnswer(ref, config, "token", { dryRun: false });
    // Node doesn't set `pid` or fire 'spawn' until the OS confirms the
    // process actually launched — simulate that ordering here.
    child.pid = 4242;
    child.emit("spawn");

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("pid 4242"));
    expect(answerState.get(ref)).toBe(1);

    logSpy.mockRestore();
  });

  it("does not log 'pid undefined' or count a failed spawn against the per-issue answer cap", () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    dispatchAnswer(ref, config, "token", { dryRun: false });
    // ENOENT: `claude` isn't on launchd's PATH (the exact bug this issue fixes) —
    // spawn() never reaches 'spawn', only 'error', and pid stays undefined.
    const err = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    child.emit("error", err);

    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("pid undefined"));
    expect(answerState.get(ref)).toBeUndefined();
    expect(active.has(answerKey(ref))).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("failed to spawn answer session"));

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
