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

// The `live` flag closed over by each effect run is usePoll's guard against
// a response landing after that run is no longer current — either because
// the component unmounted or because a fresher poll (via reload()) already
// started. Without it, a slow response racing a faster one could clobber
// newer data with stale data, or update state after unmount.
describe("usePoll stale-response guard", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function DataPoller({
    fn,
    expose,
  }: {
    fn: () => Promise<number>;
    expose: (s: { data: number | null; error: string | null; reload: () => void }) => void;
  }) {
    const { data, error, reload } = usePoll(fn, [], 15000);
    expose({ data, error, reload });
    return <div>{data === null ? "null" : data}</div>;
  }

  it("ignores a resolution that arrives after unmount", async () => {
    let resolve: ((v: number) => void) | null = null;
    const fn = vi.fn(
      () =>
        new Promise<number>((res) => {
          resolve = res;
        }),
    );
    const root = createRoot(container);
    await act(async () => {
      root.render(<DataPoller fn={fn} expose={() => {}} />);
    });
    expect(fn).toHaveBeenCalledTimes(1);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      root.unmount();
    });
    // Resolving after unmount must not trigger a React "state update on an
    // unmounted component" warning — the live guard should short-circuit it.
    await act(async () => {
      resolve?.(42);
    });
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("ignores a stale in-flight response once reload() starts a fresher poll", async () => {
    const resolvers: Array<(v: number) => void> = [];
    const fn = vi.fn(() => new Promise<number>((res) => resolvers.push(res)));
    let state: { data: number | null; error: string | null; reload: () => void } | null = null;
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <DataPoller
          fn={fn}
          expose={(s) => {
            state = s;
          }}
        />,
      );
    });
    expect(fn).toHaveBeenCalledTimes(1);

    await act(async () => {
      state!.reload();
    });
    expect(fn).toHaveBeenCalledTimes(2);

    // The first (stale) call resolves after reload kicked off a fresh one —
    // its result must not land.
    await act(async () => {
      resolvers[0](1);
    });
    expect(container.textContent).toBe("null");

    // The fresh call's result does land.
    await act(async () => {
      resolvers[1](2);
    });
    expect(container.textContent).toBe("2");
  });

  it("sets an error message on rejection, then clears it once a later poll succeeds", async () => {
    let fail = true;
    const fn = vi.fn(() => (fail ? Promise.reject(new Error("boom")) : Promise.resolve(7)));
    let state: { data: number | null; error: string | null; reload: () => void } | null = null;
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <DataPoller
          fn={fn}
          expose={(s) => {
            state = s;
          }}
        />,
      );
    });
    expect(state!.error).toBe("boom");
    expect(state!.data).toBeNull();

    fail = false;
    await act(async () => {
      state!.reload();
    });
    expect(state!.error).toBeNull();
    expect(state!.data).toBe(7);
  });
});
