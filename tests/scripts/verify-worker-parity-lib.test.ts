import { describe, it, expect, vi } from "vitest";
import {
  ciMirrorSteps,
  nodeVersionMismatchMessage,
  readEnginesNode,
  runVerifySteps,
  WORKER_TZ,
} from "../../scripts/verify-worker-parity-lib.js";

// SYD-166: `npm run verify` is the "verify like the delivery worker" preflight
// an agent runs before done-stamping, so environment-sensitive failures (node
// major drift — SYD-97; a session's local TZ leaking into date-dependent
// tests — SYD-162) surface inside the session instead of as a post-delivery
// bounce. These test the pure decision logic; the process-spawning wrapper
// (verify-worker-parity.ts) is deliberately thin and untested, same split as
// delivery-lib.ts / delivery-exec.ts.

describe("ciMirrorSteps", () => {
  it("mirrors ci.yml's typecheck / build:ui / test steps in order", () => {
    expect(ciMirrorSteps()).toEqual([
      { label: "typecheck", cmd: "npm", args: ["run", "typecheck"] },
      { label: "build:ui", cmd: "npm", args: ["run", "build:ui"] },
      { label: "test", cmd: "npm", args: ["test"] },
    ]);
  });
});

describe("readEnginesNode", () => {
  it("reads a declared engines.node range", () => {
    expect(readEnginesNode(JSON.stringify({ engines: { node: ">=22 <25" } }))).toBe(">=22 <25");
  });

  it("returns null when engines.node is absent", () => {
    expect(readEnginesNode(JSON.stringify({ name: "x" }))).toBeNull();
  });

  it("returns null for unparseable JSON instead of throwing", () => {
    expect(readEnginesNode("not json")).toBeNull();
  });
});

describe("nodeVersionMismatchMessage", () => {
  it("returns null when there is no declared engines.node band", () => {
    expect(nodeVersionMismatchMessage(null, "v25.0.0")).toBeNull();
  });

  it("returns null when the actual version satisfies the band", () => {
    expect(nodeVersionMismatchMessage(">=22 <25", "v24.1.0")).toBeNull();
  });

  it("names the mismatch when the actual version is outside the band", () => {
    const msg = nodeVersionMismatchMessage(">=22 <25", "v25.0.0");
    expect(msg).toContain("FATAL");
    expect(msg).toContain("v25.0.0");
    expect(msg).toContain(">=22 <25");
    expect(msg).toContain(".nvmrc");
  });
});

describe("runVerifySteps", () => {
  const cwd = "/repo";
  const env = { PATH: "/usr/bin" };

  it("runs every step and reports ok when all succeed", () => {
    const spawn = vi.fn().mockReturnValue({ status: 0 });
    const steps = ciMirrorSteps();

    const outcome = runVerifySteps(steps, spawn, { cwd, env });

    expect(outcome).toEqual({ ok: true });
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it("pins TZ to UTC for every step regardless of the ambient env", () => {
    const spawn = vi.fn().mockReturnValue({ status: 0 });

    runVerifySteps(ciMirrorSteps(), spawn, { cwd, env: { ...env, TZ: "America/New_York" } });

    for (const call of spawn.mock.calls) {
      expect(call[2]).toEqual({ cwd, env: { ...env, TZ: WORKER_TZ } });
    }
  });

  it("stops at the first failing step and reports it (fail-fast, like CI)", () => {
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ status: 0 }) // typecheck passes
      .mockReturnValueOnce({ status: 1 }); // build:ui fails

    const outcome = runVerifySteps(ciMirrorSteps(), spawn, { cwd, env });

    expect(outcome).toEqual({ ok: false, failedStep: "build:ui", exitCode: 1 });
    expect(spawn).toHaveBeenCalledTimes(2); // test never runs
  });

  it("falls back to exit code 1 when a step is killed by a signal (status null)", () => {
    const spawn = vi.fn().mockReturnValue({ status: null });

    const outcome = runVerifySteps(ciMirrorSteps(), spawn, { cwd, env });

    expect(outcome).toEqual({ ok: false, failedStep: "typecheck", exitCode: 1 });
  });
});
