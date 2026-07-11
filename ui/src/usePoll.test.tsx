// @vitest-environment jsdom
//
// SYD-129: usePoll used to keep polling on setInterval regardless of
// document.visibilityState, so every backgrounded tab hammered the server
// forever. It should pause while hidden and refetch immediately on return.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { usePoll } from "./usePoll";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

function Poller({ fn }: { fn: () => Promise<number> }) {
  usePoll(fn, [], 15000);
  return null;
}

describe("usePoll visibility handling", () => {
  let container: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
  });

  it("polls on the interval while the tab is visible", async () => {
    const fn = vi.fn(() => Promise.resolve(1));
    const root = createRoot(container);
    await act(async () => {
      root.render(<Poller fn={fn} />);
    });
    expect(fn).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(fn).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("stops polling once the tab is hidden", async () => {
    const fn = vi.fn(() => Promise.resolve(1));
    const root = createRoot(container);
    await act(async () => {
      root.render(<Poller fn={fn} />);
    });
    expect(fn).toHaveBeenCalledTimes(1);

    await act(async () => {
      setVisibility("hidden");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("refetches immediately and resumes polling once the tab becomes visible again", async () => {
    const fn = vi.fn(() => Promise.resolve(1));
    const root = createRoot(container);
    await act(async () => {
      root.render(<Poller fn={fn} />);
    });
    expect(fn).toHaveBeenCalledTimes(1);

    await act(async () => {
      setVisibility("hidden");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(fn).toHaveBeenCalledTimes(1);

    await act(async () => {
      setVisibility("visible");
    });
    expect(fn).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not start an interval when mounted while already hidden", async () => {
    setVisibility("hidden");
    const fn = vi.fn(() => Promise.resolve(1));
    const root = createRoot(container);
    await act(async () => {
      root.render(<Poller fn={fn} />);
    });
    expect(fn).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
