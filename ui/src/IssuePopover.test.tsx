// @vitest-environment jsdom
//
// Hover popover for rich internal refs (SYD-223): the Markdown autolinker
// marks issue-ref anchors with data-issue-ref, and Markdown wires up a single
// delegated hover listener (useIssueRefHover) that lazily fetches the issue
// (cached per ref) and shows an at-a-glance card.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

vi.mock("./api", () => ({
  getIssue: vi.fn(),
  listActors: vi.fn(),
}));

import { getIssue, listActors } from "./api";
import { Markdown } from "./Markdown";
import { resetIssuePopoverCaches } from "./IssuePopover";
import type { IssueDetail } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ISSUE: IssueDetail = {
  id: 1,
  ref: "SYD-83",
  title: "Rich internal refs",
  description: "",
  summary: null,
  status: "in_progress",
  priority: "high",
  assigneeId: 2,
  creatorId: 1,
  labels: [],
  sourceType: null,
  sourceDetail: null,
  sourceUrl: null,
  needsInput: false,
  snoozedUntil: null,
  // Added to Issue after this branch was written: workerPreference (SYD-159)
  // and parentId (issue hierarchy).
  workerPreference: null,
  parentId: null,
  createdAt: 1,
  updatedAt: 1,
  attention: null,
  openPr: null,
  activity: [],
  dependencies: { blockedBy: [], blocks: [] },
  children: [],
  parentRef: null,
  attachments: [],
  deliveryPin: null,
};

async function renderMarkdown(text: string): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Markdown text={text} projectKey="SYD" />);
  });
  return container;
}

// Markdown re-renders (e.g. when `hover` state changes) replace the
// dangerouslySetInnerHTML subtree wholesale — even when the generated HTML
// string is byte-identical — so a DOM reference captured before a render can
// go stale. A real browser doesn't have this problem (hit-testing always
// targets whatever's live at the cursor), so tests re-query by ref right
// before dispatching each event rather than reusing an earlier reference.
function anchorFor(container: HTMLElement, ref: string): Element {
  return [...container.querySelectorAll("[data-issue-ref]")].find(
    (el) => el.getAttribute("data-issue-ref") === ref,
  )!;
}

function anchorAt(container: HTMLElement, index: number): Element {
  return container.querySelectorAll("[data-issue-ref]")[index];
}

function hoverOn(el: Element): void {
  el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
}

function unhoverFrom(el: Element): void {
  el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
}

describe("issue-ref hover popover", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetIssuePopoverCaches();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(getIssue).mockReset();
    vi.mocked(listActors).mockReset();
    document.body.innerHTML = "";
  });

  it("does not show a popover before the hover delay elapses", async () => {
    vi.mocked(getIssue).mockResolvedValue(ISSUE);
    vi.mocked(listActors).mockResolvedValue([]);
    const container = await renderMarkdown("see SYD-83");
    const anchor = container.querySelector("[data-issue-ref]")!;

    await act(async () => {
      hoverOn(anchor);
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(document.querySelector(".ref-popover")).toBeNull();
    expect(getIssue).not.toHaveBeenCalled();
  });

  it("fetches and shows title/status/priority/assignee after the hover delay", async () => {
    vi.mocked(getIssue).mockResolvedValue(ISSUE);
    vi.mocked(listActors).mockResolvedValue([
      { id: 2, name: "sean", type: "human", createdAt: 1, hasToken: false },
    ]);
    const container = await renderMarkdown("see SYD-83");
    const anchor = container.querySelector("[data-issue-ref]")!;

    await act(async () => {
      hoverOn(anchor);
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(getIssue).toHaveBeenCalledWith("SYD-83");
    const popover = document.querySelector(".ref-popover")!;
    expect(popover).not.toBeNull();
    expect(popover.querySelector(".ref-popover-title")?.textContent).toBe("Rich internal refs");
    expect(popover.querySelector(".status-chip")?.textContent).toBe("in progress");
    expect(popover.querySelector(".prio")?.textContent).toBe("high");

    // Assignee name resolves asynchronously via a second (cached) fetch.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.querySelector(".ref-popover-assignee")?.textContent).toBe("sean");
  });

  it("cancels the pending popover if the mouse leaves before the delay elapses", async () => {
    vi.mocked(getIssue).mockResolvedValue(ISSUE);
    vi.mocked(listActors).mockResolvedValue([]);
    const container = await renderMarkdown("see SYD-83");
    const anchor = container.querySelector("[data-issue-ref]")!;

    await act(async () => {
      hoverOn(anchor);
      await vi.advanceTimersByTimeAsync(100);
      unhoverFrom(anchor);
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(document.querySelector(".ref-popover")).toBeNull();
    expect(getIssue).not.toHaveBeenCalled();
  });

  it("hides an already-shown popover once the mouse leaves", async () => {
    vi.mocked(getIssue).mockResolvedValue(ISSUE);
    vi.mocked(listActors).mockResolvedValue([]);
    const container = await renderMarkdown("see SYD-83");

    await act(async () => {
      hoverOn(anchorFor(container, "SYD-83"));
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(document.querySelector(".ref-popover")).not.toBeNull();

    await act(async () => {
      unhoverFrom(anchorFor(container, "SYD-83"));
    });
    expect(document.querySelector(".ref-popover")).toBeNull();
  });

  it("degrades gracefully for an unknown/cross-project ref", async () => {
    vi.mocked(getIssue).mockRejectedValue(new Error("not found"));
    vi.mocked(listActors).mockResolvedValue([]);
    const container = await renderMarkdown("see NOPE-9");
    const anchor = container.querySelector("[data-issue-ref]")!;

    await act(async () => {
      hoverOn(anchor);
      await vi.advanceTimersByTimeAsync(300);
    });
    const popover = document.querySelector(".ref-popover")!;
    expect(popover).not.toBeNull();
    expect(popover.querySelector(".ref-popover-status")?.textContent).toBe("NOPE-9 not found");
  });

  it("caches the fetch — hovering the same ref twice only calls getIssue once", async () => {
    vi.mocked(getIssue).mockResolvedValue(ISSUE);
    vi.mocked(listActors).mockResolvedValue([]);
    const container = await renderMarkdown("SYD-83 and again SYD-83");
    expect(container.querySelectorAll("[data-issue-ref]").length).toBe(2);

    await act(async () => {
      hoverOn(anchorAt(container, 0));
      await vi.advanceTimersByTimeAsync(300);
    });
    await act(async () => {
      unhoverFrom(anchorAt(container, 0));
    });
    await act(async () => {
      hoverOn(anchorAt(container, 1));
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(getIssue).toHaveBeenCalledTimes(1);
  });
});
