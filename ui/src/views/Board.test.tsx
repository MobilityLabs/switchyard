// @vitest-environment jsdom
//
// SYD-84: a delivery_failed with no later delivery clear must be glanceable
// on the board without opening the issue — the Card renders a red badge from
// the server-derived `attention` field (Board never fetches full activity).
//
// SYD-131: the card is the primary click target for opening an issue, and
// (when a move handler is supplied) also carries the only non-drag way to
// change an issue's status — both need to work from the keyboard.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import Board, { Card } from "./Board";
import { listIssues, updateIssue } from "../api";
import type { Issue } from "../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../api", () => ({
  listIssues: vi.fn(() => Promise.resolve([])),
  updateIssue: vi.fn(() => Promise.resolve({})),
}));

function issue(o: Partial<Issue> = {}): Issue {
  return {
    id: 1,
    ref: "SYD-1",
    title: "Ship it",
    description: "",
    summary: null,
    status: "done",
    priority: "none",
    assigneeId: null,
    creatorId: 1,
    labels: [],
    sourceType: null,
    sourceDetail: null,
    sourceUrl: null,
    needsInput: false,
    workerPreference: null,
    parentId: null,
    snoozedUntil: null,
    createdAt: 0,
    updatedAt: 0,
    attention: null,
    openPr: null,
    ...o,
  };
}

async function render(
  i: Issue,
  onMove?: (ref: string, status: Issue["status"]) => void,
): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Card issue={i} onMove={onMove} />);
  });
  return container;
}

describe("Board Card attention badge", () => {
  it("renders no attention badge when the issue is clean", async () => {
    const container = await render(issue());
    expect(container.querySelector(".badge.danger")).toBeNull();
  });

  it("renders an icon-only badge for an unresolved delivery_failed, with the message as a hover title", async () => {
    const container = await render(
      issue({
        status: "in_review",
        attention: { reason: "delivery_failed", message: "merge conflict" },
      }),
    );
    const badge = container.querySelector(".badge.danger");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).not.toContain("merge conflict");
    expect(badge?.textContent).toBe("⛔ delivery failed");
    expect(badge?.getAttribute("title")).toBe("merge conflict");
  });
});

describe("Board Card keyboard accessibility", () => {
  beforeEach(() => history.replaceState(null, "", "/"));

  it("is a focusable button target", async () => {
    const container = await render(issue());
    const card = container.querySelector(".card")!;
    expect(card.getAttribute("role")).toBe("button");
    expect(card.getAttribute("tabIndex")).toBe("0");
  });

  it("opens the issue on Enter", async () => {
    const container = await render(issue({ ref: "SYD-7" }));
    const card = container.querySelector(".card")!;
    await act(async () => {
      card.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    expect(location.pathname).toBe("/SYD/issue/SYD-7");
  });

  it("opens the issue on Space", async () => {
    const container = await render(issue({ ref: "SYD-8" }));
    const card = container.querySelector(".card")!;
    await act(async () => {
      card.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }),
      );
    });
    expect(location.pathname).toBe("/SYD/issue/SYD-8");
  });

  it("ignores Enter/Space originating from the ref link or move select", async () => {
    const container = await render(issue({ ref: "SYD-9" }), () => {});
    const link = container.querySelector("a.ref")!;
    await act(async () => {
      link.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    expect(location.pathname).not.toBe("/issue/SYD-9");
  });

  it("renders no move select when the board doesn't supply onMove", async () => {
    const container = await render(issue());
    expect(container.querySelector(".card-move")).toBeNull();
  });

  it("offers a keyboard-reachable select to move the card without dragging", async () => {
    const moves: Array<[string, string]> = [];
    const container = await render(issue({ ref: "SYD-10", status: "todo" }), (ref, status) =>
      moves.push([ref, status]),
    );
    const select = container.querySelector<HTMLSelectElement>(".card-move")!;
    expect(select.getAttribute("aria-label")).toContain("SYD-10");

    await act(async () => {
      select.value = "in_review";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(moves).toEqual([["SYD-10", "in_review"]]);
    // Choosing from the select must not also open the card.
    expect(location.pathname).not.toBe("/issue/SYD-10");
  });
});

// SYD-171: with the queue flow bouncing instead of repairing, spotting a
// delivery_failed or not-yet-merged card in a crowded done column needs to
// be one glance. SYD-175: the actionable view IS the default — the chips
// start ON and the full history sits behind an explicit "all" pill, with the
// user's explicit choice persisted per browser.
describe("Board done-column filter chips", () => {
  const DONE_ISSUES: Issue[] = [
    issue({ ref: "SYD-1", title: "Clean ship" }),
    issue({
      ref: "SYD-2",
      title: "Bounced",
      attention: { reason: "delivery_failed", message: "merge conflict" },
    }),
    issue({
      ref: "SYD-3",
      title: "Not merged yet",
      openPr: {
        prNumber: 41,
        url: "https://github.com/acme/widgets/pull/41",
        repo: "acme/widgets",
        headSha: "deadbeef",
      },
    }),
  ];

  async function renderBoard(): Promise<HTMLElement> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Board project="SYD" />);
    });
    await act(async () => {}); // flush the usePoll effect
    return container;
  }

  function doneColumn(container: HTMLElement): Element {
    return [...container.querySelectorAll(".column")].find((c) =>
      c.querySelector("h3")?.textContent?.includes("Done"),
    )!;
  }

  function chip(column: Element, label: string): HTMLButtonElement {
    return [...column.querySelectorAll("button")].find(
      (b) => b.textContent === label,
    )! as HTMLButtonElement;
  }

  function refs(column: Element): (string | null)[] {
    return [...column.querySelectorAll(".card .ref")].map((el) => el.textContent);
  }

  function columnBadge(column: Element): string | null {
    return column.querySelector("h3 > .badge")?.textContent ?? null;
  }

  beforeEach(() => {
    localStorage.clear();
    vi.mocked(listIssues).mockClear();
    vi.mocked(listIssues).mockResolvedValue(DONE_ISSUES);
  });

  it("defaults to the actionable view: errors + not-merged chips ON (SYD-175)", async () => {
    const container = await renderBoard();
    const done = doneColumn(container);
    expect(refs(done).sort()).toEqual(["SYD-2", "SYD-3"]);
    expect(chip(done, "⛔ errors").getAttribute("aria-pressed")).toBe("true");
    expect(chip(done, "🔀 not merged").getAttribute("aria-pressed")).toBe("true");
    expect(chip(done, "all").getAttribute("aria-pressed")).toBe("false");
  });

  it("the all pill shows the full done history (SYD-175)", async () => {
    const container = await renderBoard();
    const done = doneColumn(container);
    await act(async () => chip(done, "all").click());
    expect(done.querySelectorAll(".card")).toHaveLength(3);
    expect(chip(done, "all").getAttribute("aria-pressed")).toBe("true");
  });

  it("persists the explicit choice per browser: all sticks across renders (SYD-175)", async () => {
    const container = await renderBoard();
    await act(async () => chip(doneColumn(container), "all").click());

    const container2 = await renderBoard();
    expect(doneColumn(container2).querySelectorAll(".card")).toHaveLength(3);
  });

  it("toggling a default chip off narrows to the other filter and persists", async () => {
    const container = await renderBoard();
    const done = doneColumn(container);
    await act(async () => chip(done, "⛔ errors").click());
    expect(refs(done)).toEqual(["SYD-3"]);

    const container2 = await renderBoard();
    expect(refs(doneColumn(container2))).toEqual(["SYD-3"]);
  });

  it("combines both chips with OR semantics", async () => {
    const container = await renderBoard();
    const done = doneColumn(container);
    expect(refs(done).sort()).toEqual(["SYD-2", "SYD-3"]);
  });

  it("does not add filter chips to other columns", async () => {
    const container = await renderBoard();
    const todoColumn = [...container.querySelectorAll(".column")].find((c) =>
      c.querySelector("h3")?.textContent?.includes("Todo"),
    )!;
    expect(todoColumn.querySelector(".done-filters")).toBeNull();
  });
});

// SYD-197: with the default done filters ON, the column badge previously
// showed cards.length — the filtered subset — making completed history look
// smaller (or empty) than it really is. The badge must reflect the true
// total, with the filtered count shown alongside it when a filter narrows
// the view.
describe("Board done-column badge reflects total, not just filtered, count (SYD-197)", () => {
  const DONE_ISSUES: Issue[] = [
    issue({ ref: "SYD-1", title: "Clean ship" }),
    issue({
      ref: "SYD-2",
      title: "Bounced",
      attention: { reason: "delivery_failed", message: "merge conflict" },
    }),
    issue({
      ref: "SYD-3",
      title: "Not merged yet",
      openPr: {
        prNumber: 41,
        url: "https://github.com/acme/widgets/pull/41",
        repo: "acme/widgets",
        headSha: "deadbeef",
      },
    }),
  ];

  async function renderBoard(): Promise<HTMLElement> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Board project="SYD" />);
    });
    await act(async () => {}); // flush the usePoll effect
    return container;
  }

  function doneColumn(container: HTMLElement): Element {
    return [...container.querySelectorAll(".column")].find((c) =>
      c.querySelector("h3")?.textContent?.includes("Done"),
    )!;
  }

  function chip(column: Element, label: string): HTMLButtonElement {
    return [...column.querySelectorAll("button")].find(
      (b) => b.textContent === label,
    )! as HTMLButtonElement;
  }

  function columnBadge(column: Element): string | null {
    return column.querySelector("h3 > .badge")?.textContent ?? null;
  }

  beforeEach(() => {
    localStorage.clear();
    vi.mocked(listIssues).mockClear();
    vi.mocked(listIssues).mockResolvedValue(DONE_ISSUES);
  });

  it("shows visible/total when the default filters hide bounced/not-merged cards from the rest", async () => {
    const container = await renderBoard();
    const done = doneColumn(container);
    // Default filters show SYD-2 and SYD-3 (2 of 3 total done cards).
    expect(columnBadge(done)).toBe("2/3");
  });

  it("shows the plain total once the all pill clears every filter", async () => {
    const container = await renderBoard();
    const done = doneColumn(container);
    await act(async () => chip(done, "all").click());
    expect(columnBadge(done)).toBe("3");
  });

  it("shows the plain total in other columns, which have no filters", async () => {
    vi.mocked(listIssues).mockResolvedValue([issue({ ref: "SYD-9", status: "todo" })]);
    const container = await renderBoard();
    const todoColumn = [...container.querySelectorAll(".column")].find((c) =>
      c.querySelector("h3")?.textContent?.includes("Todo"),
    )!;
    expect(columnBadge(todoColumn)).toBe("1");
  });
});

// SYD-208: a done-stamp over an open agent PR must carry the head sha the
// human actually saw rendered on the card, so the server can refuse the
// stamp if the PR moved underneath them between page-load and click.
describe("Board move sends the rendered PR head sha on done-stamp (SYD-208)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(listIssues).mockClear();
    vi.mocked(updateIssue).mockClear();
  });

  async function renderBoardWith(cards: Issue[]): Promise<HTMLElement> {
    vi.mocked(listIssues).mockResolvedValue(cards);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Board project="SYD" />);
    });
    await act(async () => {}); // flush the usePoll effect
    return container;
  }

  function moveSelect(container: HTMLElement, ref: string): HTMLSelectElement {
    return [...container.querySelectorAll<HTMLSelectElement>(".card-move")].find(
      (s) => s.getAttribute("aria-label") === `Move ${ref} to a different status`,
    )!;
  }

  it("sends the openPr headSha as expectedHeadSha when moving a card to done", async () => {
    const container = await renderBoardWith([
      issue({
        ref: "SYD-5",
        status: "in_review",
        openPr: {
          prNumber: 12,
          url: "https://github.com/acme/widgets/pull/12",
          repo: "acme/widgets",
          headSha: "abc123",
        },
      }),
    ]);
    const select = moveSelect(container, "SYD-5");
    await act(async () => {
      select.value = "done";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(updateIssue).toHaveBeenCalledWith("SYD-5", {
      status: "done",
      expectedHeadSha: "abc123",
    });
  });

  it("omits expectedHeadSha when moving a card to a non-done status", async () => {
    const container = await renderBoardWith([
      issue({
        ref: "SYD-6",
        status: "todo",
        openPr: {
          prNumber: 12,
          url: "https://github.com/acme/widgets/pull/12",
          repo: "acme/widgets",
          headSha: "abc123",
        },
      }),
    ]);
    const select = moveSelect(container, "SYD-6");
    await act(async () => {
      select.value = "in_progress";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(updateIssue).toHaveBeenCalledWith("SYD-6", {
      status: "in_progress",
      expectedHeadSha: undefined,
    });
  });

  it("omits expectedHeadSha when stamping done with no open PR", async () => {
    const container = await renderBoardWith([issue({ ref: "SYD-7", status: "in_review" })]);
    const select = moveSelect(container, "SYD-7");
    await act(async () => {
      select.value = "done";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(updateIssue).toHaveBeenCalledWith("SYD-7", {
      status: "done",
      expectedHeadSha: undefined,
    });
  });
});
