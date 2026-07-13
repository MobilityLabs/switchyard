import { describe, it, expect } from "vitest";
import {
  heartbeatTick,
  heartbeatMissLimit,
  HEARTBEAT_MISS_LIMIT,
  HEARTBEAT_INVALID_LIMIT,
  HEARTBEAT_INTERVAL_MS,
  type WorkerConfig,
} from "../../scripts/worker-select.js";

const cfg = (over: Partial<WorkerConfig> = {}): WorkerConfig =>
  ({ url: "http://x", intervalSeconds: 300, maxConcurrent: 1, projects: {}, ...over }) as WorkerConfig;

const zero = { misses: 0, invalids: 0 };

describe("heartbeatTick (SYD-210 Layer B, tri-state)", () => {
  it("a success resets both counters and never cancels", () => {
    expect(heartbeatTick({ misses: 5, invalids: 1 }, "ok")).toEqual({
      misses: 0,
      invalids: 0,
      cancel: false,
    });
  });

  it("cancels FAST on a definitive 4xx (lease gone via takeover/expiry)", () => {
    // one 'invalid' short of the limit does not cancel...
    let s = zero;
    for (let i = 0; i < HEARTBEAT_INVALID_LIMIT - 1; i++) {
      const r = heartbeatTick(s, "invalid");
      s = { misses: r.misses, invalids: r.invalids };
      expect(r.cancel).toBe(false);
    }
    // ...the limit-th does. Cancels in far fewer than the transient miss limit.
    const last = heartbeatTick(s, "invalid");
    expect(last.cancel).toBe(true);
    expect(HEARTBEAT_INVALID_LIMIT).toBeLessThan(HEARTBEAT_MISS_LIMIT);
  });

  it("is patient on transient unreachable errors — cancels only after the full miss limit", () => {
    let s = zero;
    for (let i = 0; i < HEARTBEAT_MISS_LIMIT - 1; i++) {
      const r = heartbeatTick(s, "unreachable");
      s = { misses: r.misses, invalids: r.invalids };
      expect(r.cancel).toBe(false);
    }
    expect(heartbeatTick(s, "unreachable").cancel).toBe(true);
  });

  it("a recovery (ok) between transient blips prevents cancellation", () => {
    let s = zero;
    for (let i = 0; i < HEARTBEAT_MISS_LIMIT - 1; i++) s = heartbeatTick(s, "unreachable");
    s = heartbeatTick(s, "ok"); // recovered
    expect(s).toEqual({ misses: 0, invalids: 0, cancel: false });
    expect(heartbeatTick(s, "unreachable").cancel).toBe(false);
  });

  it("60s interval, 10 transient misses (~10 min), 2 definitive 4xx", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(60_000);
    expect(HEARTBEAT_MISS_LIMIT).toBe(10);
    expect(HEARTBEAT_INVALID_LIMIT).toBe(2);
  });
});

describe("heartbeatMissLimit (host cadence derived from server window, with cancel margin)", () => {
  // Worst-case miss cycle = interval (60s) + fetch timeout (10s) = 70s, so the
  // limit is floor(window / 70) — the host cancels strictly before the server
  // expires the lease at `window` (SYD-210 review, codex HIGH).
  it("falls back to the default 600s window when the tracker advertised none", () => {
    expect(heartbeatMissLimit(cfg())).toBe(8); // floor(600 / 70)
  });

  it("derives misses with margin so the host cancels before the server expires", () => {
    expect(heartbeatMissLimit(cfg({ heartbeatWindowSeconds: 600 }))).toBe(8); // floor(600/70)
    expect(heartbeatMissLimit(cfg({ heartbeatWindowSeconds: 300 }))).toBe(4); // floor(300/70)
    expect(heartbeatMissLimit(cfg({ heartbeatWindowSeconds: 30 }))).toBe(1); // floored at 1
  });

  it("the effective window (misses × 70s cycle) is STRICTLY under the server window, incl. evenly-divisible retunes", () => {
    for (const w of [600, 300, 210, 140]) {
      expect(heartbeatMissLimit(cfg({ heartbeatWindowSeconds: w })) * 70).toBeLessThan(w);
    }
    // 140 divides evenly by the 70s cycle: ceil-1 gives 1 miss (70s < 140s), not
    // 2 (140s = expiry) — the regression codex flagged.
    expect(heartbeatMissLimit(cfg({ heartbeatWindowSeconds: 140 }))).toBe(1);
  });
});
