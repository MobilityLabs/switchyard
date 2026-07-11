// @vitest-environment jsdom
//
// SYD-130: useActorNames used to `.map()` a fresh array on every render, so
// an unrelated 60s poll tick (or any parent re-render) handed consumers a
// new array reference even when the actor names hadn't changed. That fed
// straight into Markdown's useMemo deps, forcing every comment/description
// to re-parse through marked + DOMPurify on every 15s issue poll tick too.
// The hook should return the *same* reference across renders as long as the
// underlying names are unchanged.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

vi.mock("./api", () => ({
  listActors: vi.fn(),
}));

import { listActors } from "./api";
import { useActorNames } from "./useActorNames";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Reader({ onRender }: { onRender: (names: string[]) => void }) {
  const names = useActorNames();
  onRender(names);
  return null;
}

// Mounting resolves the poll's initial fetch in a microtask, after the
// synchronous render act() has already returned — flush it before asserting.
async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe("useActorNames", () => {
  let container: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
    vi.mocked(listActors).mockReset();
  });

  it("returns a stable reference across polls when the names haven't changed", async () => {
    vi.mocked(listActors).mockImplementation(() =>
      Promise.resolve([
        { id: 1, name: "sean", type: "human" },
        { id: 2, name: "claude/dev", type: "agent" },
      ]),
    );
    const seen: string[][] = [];
    const root = createRoot(container);
    await act(async () => { root.render(<Reader onRender={(n) => seen.push(n)} />); });
    await flush();
    expect(seen.at(-1)).toEqual(["sean", "claude/dev"]);
    const first = seen.at(-1);

    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    await flush();
    // A second poll resolved with equal (but distinct) array/objects; the
    // hook must hand back the exact same array reference.
    expect(seen.at(-1)).toBe(first);
  });

  it("returns a new reference once the names actually change", async () => {
    vi.mocked(listActors).mockImplementation(() =>
      Promise.resolve([{ id: 1, name: "sean", type: "human" }]),
    );
    const seen: string[][] = [];
    const root = createRoot(container);
    await act(async () => { root.render(<Reader onRender={(n) => seen.push(n)} />); });
    await flush();
    expect(seen.at(-1)).toEqual(["sean"]);
    const first = seen.at(-1);

    vi.mocked(listActors).mockImplementation(() =>
      Promise.resolve([
        { id: 1, name: "sean", type: "human" },
        { id: 2, name: "claude/dev", type: "agent" },
      ]),
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    await flush();
    expect(seen.at(-1)).toEqual(["sean", "claude/dev"]);
    expect(seen.at(-1)).not.toBe(first);
  });
});
