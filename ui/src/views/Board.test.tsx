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
import { listIssues } from "../api";
import type { Issue } from "../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../api", () => ({
  listIssues: vi.fn(() => Promise.resolve([])),
  updateIssue: vi.fn(() => Promise.resolve({})),
}));

function issue(o: Partial<Issue> = {}): Issue {
  return {
    id: 1, ref: "SYD-1", title: "Ship it", description: "", summary: null,
    status: "done", priority: "none",
    assigneeId: null, creatorId: 1, labels: [],
    sourceType: null, sourceDetail: null, sourceUrl: null,
    needsInput: false, snoozedUntil: null,
    createdAt: 0, updatedAt: 0, attention: null, openPr: null,
    ...o,
  };
}

async function render(i: Issue, onMove?: (ref: string, status: Issue["status"]) => void): Promise<HTMLElement> {
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
      issue({ status: "in_review", attention: { reason: "delivery_failed", message: "merge conflict" } })
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
      card.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(location.pathname).toBe("/issue/SYD-7");
  });

  it("opens the issue on Space", async () => {
    const container = await render(issue({ ref: "SYD-8" }));
    const card = container.querySelector(".card")!;
    await act(async () => {
      card.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    });
    expect(location.pathname).toBe("/issue/SYD-8");
  });

  it("ignores Enter/Space originating from the ref link or move select", async () => {
    const container = await render(issue({ ref: "SYD-9" }), () => {});
    const link = container.querySelector("a.ref")!;
    await act(async () => {
      link.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(location.pathname).not.toBe("/issue/SYD-9");
  });

  it("renders no move select when the board doesn't supply onMove", async () => {
    const container = await render(issue());
    expect(container.querySelector(".card-move")).toBeNull();
  });

  it("offers a keyboard-reachable select to move the card without dragging", async () => {
    const moves: Array<[string, string]> = [];
    const container = await render(
      issue({ ref: "SYD-10", status: "todo" }),
      (ref, status) => moves.push([ref, status]),
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
// be one glance (a toggle), not opening every card.
describe("Board done-column filter chips", () => {
  const DONE_ISSUES: Issue[] = [
    issue({ ref: "SYD-1", title: "Clean ship" }),
    issue({ ref: "SYD-2", title: "Bounced", attention: { reason: "delivery_failed", message: "merge conflict" } }),
    issue({ ref: "SYD-3", title: "Not merged yet", openPr: { prNumber: 41, url: "https://github.com/acme/widgets/pull/41" } }),
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

  beforeEach(() => {
    vi.mocked(listIssues).mockClear();
    vi.mocked(listIssues).mockResolvedValue(DONE_ISSUES);
  });

  it("shows every done card with both filter chips off", async () => {
    const container = await renderBoard();
    const doneColumn = [...container.querySelectorAll(".column")].find((c) => c.querySelector("h3")?.textContent?.includes("Done"))!;
    expect(doneColumn.querySelectorAll(".card")).toHaveLength(3);
  });

  it("narrows to delivery_failed cards when the errors chip is toggled on", async () => {
    const container = await renderBoard();
    const doneColumn = [...container.querySelectorAll(".column")].find((c) => c.querySelector("h3")?.textContent?.includes("Done"))!;
    const errorsChip = [...doneColumn.querySelectorAll("button")].find((b) => b.textContent === "⛔ errors")!;

    await act(async () => errorsChip.click());

    const refs = [...doneColumn.querySelectorAll(".card .ref")].map((el) => el.textContent);
    expect(refs).toEqual(["SYD-2"]);
    expect(errorsChip.getAttribute("aria-pressed")).toBe("true");
  });

  it("narrows to open-PR cards when the not-merged chip is toggled on", async () => {
    const container = await renderBoard();
    const doneColumn = [...container.querySelectorAll(".column")].find((c) => c.querySelector("h3")?.textContent?.includes("Done"))!;
    const notMergedChip = [...doneColumn.querySelectorAll("button")].find((b) => b.textContent === "🔀 not merged")!;

    await act(async () => notMergedChip.click());

    const refs = [...doneColumn.querySelectorAll(".card .ref")].map((el) => el.textContent);
    expect(refs).toEqual(["SYD-3"]);
  });

  it("combines both chips with OR semantics", async () => {
    const container = await renderBoard();
    const doneColumn = [...container.querySelectorAll(".column")].find((c) => c.querySelector("h3")?.textContent?.includes("Done"))!;
    const errorsChip = [...doneColumn.querySelectorAll("button")].find((b) => b.textContent === "⛔ errors")!;
    const notMergedChip = [...doneColumn.querySelectorAll("button")].find((b) => b.textContent === "🔀 not merged")!;

    await act(async () => errorsChip.click());
    await act(async () => notMergedChip.click());

    const refs = [...doneColumn.querySelectorAll(".card .ref")].map((el) => el.textContent);
    expect(refs.sort()).toEqual(["SYD-2", "SYD-3"]);
  });

  it("does not add filter chips to other columns", async () => {
    const container = await renderBoard();
    const todoColumn = [...container.querySelectorAll(".column")].find((c) => c.querySelector("h3")?.textContent?.includes("Todo"))!;
    expect(todoColumn.querySelector(".done-filters")).toBeNull();
  });
});
