import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

const { buildPrompt, dispatch, dispatchAnswer, active, answerState, reportSessionStart, reportSessionEnd, runTick } =
  await import("../../scripts/agent-worker.js");

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
 * is exactly what dispatchAnswer's CLI branch touches. `kill` just records
 * calls — exitCode/signalCode stay whatever the test sets, so a test can
 * simulate either an unresponsive process (killSession's grace-period check,
 * SYD-115, should then escalate to SIGKILL) or one that dies on SIGTERM. */
class FakeChildProcess extends EventEmitter {
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn((_signal?: NodeJS.Signals) => true);
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

describe("session watchdog (SYD-115)", () => {
  const ref = "SYD-115";
  const issue = { ref, title: "Bundle", labels: ["auto"], assigneeId: null, needsInput: false, updatedAt: 0 };
  const config: WorkerConfig = {
    url: "http://localhost:3300",
    label: "auto",
    intervalSeconds: 300,
    maxConcurrent: 2,
    projects: { SYD: { repo: "/repo/syd" } },
    sessionTimeoutSeconds: 30,
  };

  beforeEach(() => {
    active.clear();
    answerState.clear();
    spawnMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("SIGTERMs a bare-host work session once it exceeds sessionTimeoutSeconds", () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    dispatch(issue, config, "tok", "code");
    child.pid = 111;
    child.emit("spawn");

    vi.advanceTimersByTime(30_000);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("exceeded 30s watchdog timeout"));
    // No docker kill for a bare-host (non-containerized) dispatch.
    expect(spawnMock).not.toHaveBeenCalledWith("docker", expect.anything(), expect.anything());

    errorSpy.mockRestore();
  });

  it("escalates to SIGKILL after the grace period if the process is still alive", () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    dispatch(issue, config, "tok", "code");
    child.pid = 111;
    child.emit("spawn");

    vi.advanceTimersByTime(30_000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    // Process ignores SIGTERM — exitCode/signalCode stay null.
    vi.advanceTimersByTime(10_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    errorSpy.mockRestore();
  });

  it("does not escalate to SIGKILL once the process has already exited", () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}), text: async () => "" }));
    vi.stubGlobal("fetch", fetchMock);

    dispatch(issue, config, "tok", "code");
    child.pid = 111;
    child.emit("spawn");

    vi.advanceTimersByTime(30_000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.exitCode = 143; // process actually exited in response to SIGTERM
    child.emit("exit", 143);

    vi.advanceTimersByTime(10_000);
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");

    errorSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("also docker-kills the named container for a containerized dispatch", () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const containerizedConfig: WorkerConfig = {
      ...config,
      containerized: true,
      projects: { SYD: { repo: "/repo/syd" } },
    };
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");

    dispatch(issue, containerizedConfig, "tok", "code");
    child.pid = 111;
    child.emit("spawn");

    vi.advanceTimersByTime(30_000);

    expect(spawnMock).toHaveBeenCalledWith("docker", ["kill", `syd-${ref}`], expect.anything());
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    errorSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("clears the watchdog on a normal exit so a slow-but-finished session is never killed", () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}), text: async () => "" }));
    vi.stubGlobal("fetch", fetchMock);

    dispatch(issue, config, "tok", "code");
    child.pid = 111;
    child.emit("spawn");
    child.emit("exit", 0);

    vi.advanceTimersByTime(60_000);
    expect(child.kill).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("also watchdogs an answer session", () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    dispatchAnswer(ref, config, "tok", { dryRun: false });
    child.pid = 111;
    child.emit("spawn");

    vi.advanceTimersByTime(30_000);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`answer session for ${ref} exceeded 30s watchdog timeout`)
    );

    errorSpy.mockRestore();
  });
});

describe("buildPrompt progress-note convention (SYD-43)", () => {
  it("tells the session to record progress notes as it works", () => {
    expect(buildPrompt("SYD-7")).toContain("progress_note");
  });
});

describe("session lifecycle reporting (SYD-43)", () => {
  const config: WorkerConfig = {
    url: "http://localhost:3300",
    label: "auto",
    intervalSeconds: 300,
    maxConcurrent: 2,
    projects: { SYD: { repo: "/repo/syd" } },
  };

  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the session start and resolves the new id", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ id: 12 }), text: async () => "" }));
    vi.stubGlobal("fetch", fetchMock);
    const id = await reportSessionStart(config, "tok", { ref: "SYD-7", mode: "cli", pid: 4242 });
    expect(id).toBe(12);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3300/api/agent-sessions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("resolves null instead of throwing when the server rejects the report", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}), text: async () => "no" }));
    vi.stubGlobal("fetch", fetchMock);
    const id = await reportSessionStart(config, "tok", { ref: "SYD-7", mode: "cli", pid: null });
    expect(id).toBeNull();
    errorSpy.mockRestore();
  });

  it("PATCHes the exit code once the session id resolves", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}), text: async () => "" }));
    vi.stubGlobal("fetch", fetchMock);
    await reportSessionEnd(config, "tok", Promise.resolve(12), 0);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3300/api/agent-sessions/12",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ exitCode: 0 }) }),
    );
  });

  it("skips the PATCH entirely when the start was never recorded", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await reportSessionEnd(config, "tok", Promise.resolve(null), 0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mirrors a session-report failure to the onError callback (SYD-105)", async () => {
    // 400 (not 5xx/network) so withRetry's isRetryableError treats it as
    // terminal and this resolves on the first attempt, no real backoff delay.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}), text: async () => "bad" }));
    vi.stubGlobal("fetch", fetchMock);
    const onError = vi.fn();
    const id = await reportSessionStart(config, "tok", { ref: "SYD-7", mode: "cli", pid: null }, onError);
    expect(id).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("could not report session start for SYD-7"));
    errorSpy.mockRestore();
  });
});

describe("dispatch session-reporting wiring (SYD-105)", () => {
  const ref = "SYD-105";
  const issue = { ref, title: "Bundle", labels: ["auto"], assigneeId: null, needsInput: false, updatedAt: 0 };
  const config: WorkerConfig = {
    url: "http://localhost:3300",
    label: "auto",
    intervalSeconds: 300,
    maxConcurrent: 2,
    projects: { SYD: { repo: "/repo/syd" } },
  };

  beforeEach(() => {
    active.clear();
    spawnMock.mockReset();
  });

  it("reports session start on spawn and session end with the exit code on exit", async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => ({
      ok: true,
      json: async () => (init.method === "POST" ? { id: 77 } : {}),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    dispatch(issue, config, "tok", "code");
    child.pid = 555;
    child.emit("spawn");

    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:3300/api/agent-sessions",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ ref, mode: "cli", pid: 555 }) }),
      )
    );

    child.emit("exit", 0);

    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:3300/api/agent-sessions/77",
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ exitCode: 0 }) }),
      )
    );

    logSpy.mockRestore();
    errorSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe("host-side pre-claim before dispatch (SYD-122)", () => {
  const config: WorkerConfig = {
    url: "http://localhost:3300",
    label: "auto",
    intervalSeconds: 300,
    maxConcurrent: 2,
    projects: { SYD: { repo: "/repo/syd" } },
  };

  /** Routes fetch by URL suffix so a single mock can stand in for both the
   * ready-issues poll and the claim POST. */
  function fetchRouter(routes: Record<string, { ok: boolean; status?: number; body?: unknown; text?: string }>) {
    return vi.fn(async (url: string) => {
      for (const [suffix, resp] of Object.entries(routes)) {
        if (url.endsWith(suffix)) {
          return { ok: resp.ok, status: resp.status ?? 200, json: async () => resp.body ?? {}, text: async () => resp.text ?? "" };
        }
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
  }

  beforeEach(() => {
    active.clear();
    spawnMock.mockReset();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("claims the issue host-side and dispatches once the claim succeeds", async () => {
    const ref = "SYD-122a";
    const issue = { ref, title: "pre-claim", labels: ["auto"], assigneeId: null, needsInput: false, updatedAt: 1 };
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    const fetchMock = fetchRouter({
      "/api/issues?status=todo": { ok: true, body: [issue] },
      [`/api/issues/${ref}/claim`]: { ok: true, body: {} },
    });
    vi.stubGlobal("fetch", fetchMock);

    await runTick(config, "tok", "code", { dryRun: false });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3300/api/issues/SYD-122a/claim",
      expect.objectContaining({ method: "POST", headers: expect.objectContaining({ authorization: "Bearer tok" }) }),
    );
    expect(spawnMock).toHaveBeenCalled();
  });

  it("skips dispatch when another actor already claimed the issue", async () => {
    const ref = "SYD-122b";
    const issue = { ref, title: "lost the race", labels: ["auto"], assigneeId: null, needsInput: false, updatedAt: 1 };
    const fetchMock = fetchRouter({
      "/api/issues?status=todo": { ok: true, body: [issue] },
      [`/api/issues/${ref}/claim`]: { ok: false, status: 400, text: `${ref} is already claimed by someone-else` },
    });
    vi.stubGlobal("fetch", fetchMock);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runTick(config, "tok", "code", { dryRun: false });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`skipping ${ref}: lost the claim race`));
    logSpy.mockRestore();
  });

  it("dry-run never calls the claim endpoint", async () => {
    const ref = "SYD-122c";
    const issue = { ref, title: "dry run", labels: ["auto"], assigneeId: null, needsInput: false, updatedAt: 1 };
    const fetchMock = fetchRouter({ "/api/issues?status=todo": { ok: true, body: [issue] } });
    vi.stubGlobal("fetch", fetchMock);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runTick(config, "tok", "code", { dryRun: true });

    expect(spawnMock).not.toHaveBeenCalled();
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain("/claim");
    }
    logSpy.mockRestore();
  });
});
