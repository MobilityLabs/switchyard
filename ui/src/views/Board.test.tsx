// @vitest-environment jsdom
//
// SYD-84: a delivery_failed with no later delivery clear must be glanceable
// on the board without opening the issue — the Card renders a red badge from
// the server-derived `attention` field (Board never fetches full activity).
//
// SYD-131: the card is the primary click target for opening an issue, and
// (when a move handler is supplied) also carries the only non-drag way to
// change an issue's status — both need to work from the keyboard.
import { describe, it, expect, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Card } from "./Board";
import type { Issue } from "../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    snoozedUntil: null,
    createdAt: 0,
    updatedAt: 0,
    attention: null,
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
    expect(location.pathname).toBe("/issue/SYD-7");
  });

  it("opens the issue on Space", async () => {
    const container = await render(issue({ ref: "SYD-8" }));
    const card = container.querySelector(".card")!;
    await act(async () => {
      card.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }),
      );
    });
    expect(location.pathname).toBe("/issue/SYD-8");
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
