// @vitest-environment jsdom
//
// useActorNames wraps listActors in a slow (60s) usePoll and projects it down
// to a plain array of names for the @mention highlighter (SYD-57).
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
import type { Actor, ActorWithStatus } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Reader({ onRender }: { onRender: (names: string[]) => void }) {
  const names = useActorNames();
  onRender(names);
  return null;
}

// Mounting resolves the poll's initial fetch in a microtask, after the
// synchronous render act() has already returned — flush it before asserting.
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useActorNames reference stability (SYD-130)", () => {
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
        { id: 1, name: "sean", type: "human", createdAt: 1, hasToken: false },
        { id: 2, name: "claude/dev", type: "agent", createdAt: 1, hasToken: true },
      ]),
    );
    const seen: string[][] = [];
    const root = createRoot(container);
    await act(async () => {
      root.render(<Reader onRender={(n) => seen.push(n)} />);
    });
    await flush();
    expect(seen.at(-1)).toEqual(["sean", "claude/dev"]);
    const first = seen.at(-1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    await flush();
    // A second poll resolved with equal (but distinct) array/objects; the
    // hook must hand back the exact same array reference.
    expect(seen.at(-1)).toBe(first);
  });

  it("returns a new reference once the names actually change", async () => {
    vi.mocked(listActors).mockImplementation(() =>
      Promise.resolve([{ id: 1, name: "sean", type: "human", createdAt: 1, hasToken: false }]),
    );
    const seen: string[][] = [];
    const root = createRoot(container);
    await act(async () => {
      root.render(<Reader onRender={(n) => seen.push(n)} />);
    });
    await flush();
    expect(seen.at(-1)).toEqual(["sean"]);
    const first = seen.at(-1);

    vi.mocked(listActors).mockImplementation(() =>
      Promise.resolve([
        { id: 1, name: "sean", type: "human", createdAt: 1, hasToken: false },
        { id: 2, name: "claude/dev", type: "agent", createdAt: 1, hasToken: true },
      ]),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    await flush();
    expect(seen.at(-1)).toEqual(["sean", "claude/dev"]);
    expect(seen.at(-1)).not.toBe(first);
  });
});

function Probe({ expose }: { expose: (names: string[]) => void }) {
  expose(useActorNames());
  return null;
}

async function render(expose: (names: string[]) => void): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Probe expose={expose} />);
  });
}

describe("useActorNames (SYD-134)", () => {
  afterEach(() => {
    vi.mocked(listActors).mockReset();
  });

  it("returns an empty array before the poll resolves", async () => {
    vi.mocked(listActors).mockImplementationOnce(() => new Promise(() => {}));
    let names: string[] = ["unset"];
    await render((n) => {
      names = n;
    });
    expect(names).toEqual([]);
  });

  it("returns the actor names once listActors resolves", async () => {
    const actors: ActorWithStatus[] = [
      { id: 1, name: "sean", type: "human", createdAt: 1, hasToken: false },
      { id: 2, name: "claude/worker", type: "agent", createdAt: 1, hasToken: true },
    ];
    vi.mocked(listActors).mockResolvedValueOnce(actors);
    let names: string[] = [];
    await render((n) => {
      names = n;
    });
    expect(names).toEqual(["sean", "claude/worker"]);
  });
});
