import { describe, it, expect } from "vitest";
import {
  heartbeatTick,
  HEARTBEAT_MISS_LIMIT,
  HEARTBEAT_INTERVAL_MS,
} from "../../scripts/worker-select.js";

describe("heartbeatTick (SYD-210 Layer B)", () => {
  it("cancels only after missLimit consecutive failures", () => {
    let failures = 0;
    for (let i = 0; i < HEARTBEAT_MISS_LIMIT - 1; i++) {
      const r = heartbeatTick(failures, false);
      failures = r.failures;
      expect(r.cancel).toBe(false);
    }
    const last = heartbeatTick(failures, false);
    expect(last.failures).toBe(HEARTBEAT_MISS_LIMIT);
    expect(last.cancel).toBe(true);
  });

  it("a success resets the streak so a single blip never cancels", () => {
    expect(heartbeatTick(HEARTBEAT_MISS_LIMIT - 1, true)).toEqual({ failures: 0, cancel: false });
  });

  it("respects a custom missLimit", () => {
    expect(heartbeatTick(1, false, 2)).toEqual({ failures: 2, cancel: true });
  });

  it("uses a 60s interval and N=10 window (~10 min)", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(60_000);
    expect(HEARTBEAT_MISS_LIMIT).toBe(10);
  });
});
