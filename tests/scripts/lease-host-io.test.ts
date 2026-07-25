import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  writeCliMcpConfig,
  persistLeaseToken,
  readPersistedLeaseToken,
  startLeaseHeartbeat,
} from "../../scripts/agent-worker.js";
import type { WorkerConfig } from "../../scripts/worker-select.js";

// Real-fs coverage for the SYD-210 lease host I/O (opus review: these were
// mocked away in agent-worker.test.ts, so nothing asserted the header is
// actually emitted or the lease round-trips).

describe("writeCliMcpConfig", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("emits an MCP config carrying the bearer AND the X-Switchyard-Lease header, 0600, outside the repo tree", () => {
    const { configPath, tmpDir } = writeCliMcpConfig("SYD-1", "http://x/", "tok-abc", "lease-xyz");
    dirs.push(tmpDir);
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    const headers = cfg.mcpServers.switchyard.headers;
    expect(headers.Authorization).toBe("Bearer tok-abc");
    expect(headers["X-Switchyard-Lease"]).toBe("lease-xyz");
    expect(cfg.mcpServers.switchyard.url).toBe("http://x/mcp");
    // 0600, and under the OS temp dir (not the repo working tree)
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(configPath.startsWith(tmpdir())).toBe(true);
  });
});

describe("persistLeaseToken / readPersistedLeaseToken", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "syd-repo-"));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("round-trips a lease token through a 0600 file the restart reconciler can read back", () => {
    // mkdir the worker-logs dir the helper writes into (dispatch does this).
    mkdirSync(path.join(repo, ".superpowers", "worker-logs"), { recursive: true });
    expect(readPersistedLeaseToken(repo, "SYD-1")).toBeNull(); // none yet
    persistLeaseToken(repo, "SYD-1", "lease-abc");
    expect(readPersistedLeaseToken(repo, "SYD-1")).toBe("lease-abc");
    const p = path.join(repo, ".superpowers", "worker-logs", "SYD-1.lease");
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});

describe("startLeaseHeartbeat orchestration", () => {
  const cfg = {
    url: "http://x",
    intervalSeconds: 300,
    maxConcurrent: 1,
    projects: {},
  } as WorkerConfig;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("fires an immediate first beat, cancels once after 2 definitive 4xx, and stops beating", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return { ok: false, status: 403 } as Response;
      }),
    );
    const onExhausted = vi.fn();
    const stop = startLeaseHeartbeat(cfg, "tok", "lease", "SYD-1", onExhausted, () => {});

    await vi.advanceTimersByTimeAsync(0); // immediate first beat resolves
    expect(calls).toBe(1);
    expect(onExhausted).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000); // 2nd beat -> 2nd 4xx -> cancel (INVALID_LIMIT=2)
    expect(calls).toBe(2);
    expect(onExhausted).toHaveBeenCalledTimes(1);

    // cancelled: no further beats regardless of how much time passes
    await vi.advanceTimersByTimeAsync(300_000);
    expect(calls).toBe(2);
    expect(onExhausted).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stop() halts the loop with no further beats", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return { ok: true, status: 200 } as Response;
      }),
    );
    const stop = startLeaseHeartbeat(cfg, "tok", "lease", "SYD-1", vi.fn(), () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(calls).toBe(1); // no beats after stop
  });
});
