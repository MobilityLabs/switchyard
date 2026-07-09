// @vitest-environment jsdom
//
// SYD-75: the item under review must not silently swap when the polled
// in_review list reorders or grows underneath the reviewer. Selection is
// keyed by ref (from the URL), and new arrivals surface as a non-disruptive
// count instead of reordering the current view.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Issue, IssueDetail } from "../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../api", () => ({
  addComment: vi.fn(() => Promise.resolve()),
  getIssue: vi.fn(() => Promise.resolve(null)),
  listActors: vi.fn(() => Promise.resolve([])),
  listIssues: vi.fn(() => Promise.resolve([])),
  updateIssue: vi.fn(() => Promise.resolve({})),
  uploadAttachment: vi.fn(),
}));

import { listIssues } from "../api";
import Review from "./Review";
import { useRoute } from "../router";

function issue(ref: string, title: string): Issue {
  return {
    id: Number(ref.split("-")[1]), ref, title, description: "",
    status: "in_review", priority: "none",
    assigneeId: null, creatorId: 1, labels: [],
    sourceType: null, sourceDetail: null, sourceUrl: null,
    needsInput: false, snoozedUntil: null,
    createdAt: 0, updatedAt: 0,
  };
}

function detailOf(i: Issue): IssueDetail {
  return { ...i, activity: [], dependencies: { blockedBy: [], blocks: [] }, attachments: [] };
}

// Mirrors how App.tsx wires the route ref into Review, so a redirect the
// component fires (bare /review -> /review/:ref) is observed the same way
// a real page would observe it.
function ReviewRoute() {
  const route = useRoute();
  if (route.view !== "review") return null;
  return <Review currentRef={route.ref} />;
}

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function mountReviewRoute(path: string): Promise<HTMLElement> {
  history.replaceState(null, "", path);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ReviewRoute />);
  });
  await flush();
  return container;
}

function refText(container: HTMLElement): string | null {
  return container.querySelector(".issue-head .ref")?.textContent ?? null;
}

describe("Review selection stability", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(listIssues).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("redirects bare /review to the first in-review issue", async () => {
    vi.mocked(listIssues).mockResolvedValue([issue("SYD-1", "First"), issue("SYD-2", "Second")]);
    const container = await mountReviewRoute("/review");
    expect(location.pathname).toBe("/review/SYD-1");
    expect(refText(container)).toBe("SYD-1");
  });

  it("keeps displaying the same ref when a later poll reorders and grows the list", async () => {
    vi.mocked(listIssues).mockResolvedValue([issue("SYD-1", "First"), issue("SYD-2", "Second")]);
    const container = await mountReviewRoute("/review/SYD-2");
    expect(refText(container)).toBe("SYD-2");

    // Next poll tick: a new issue arrives and the list reorders.
    vi.mocked(listIssues).mockResolvedValue([
      issue("SYD-3", "Third"), issue("SYD-2", "Second"), issue("SYD-1", "First"),
    ]);
    await act(async () => { vi.advanceTimersByTime(15000); });
    await flush();

    expect(refText(container)).toBe("SYD-2");
    expect(container.querySelector(".review-new-arrivals")?.textContent).toBe("1 new");
  });

  it("shows a banner and never auto-jumps when the displayed issue leaves in_review", async () => {
    vi.mocked(listIssues).mockResolvedValue([issue("SYD-1", "First"), issue("SYD-2", "Second")]);
    const container = await mountReviewRoute("/review/SYD-9");

    expect(container.querySelector(".review-left")?.textContent).toContain("SYD-9 is no longer in review");
    expect(refText(container)).toBeNull();
    expect(location.pathname).toBe("/review/SYD-9");

    const jumpButton = [...container.querySelectorAll("button")].find((b) => b.textContent === "Jump to next")!;
    await act(async () => { jumpButton.click(); });
    await flush();

    expect(location.pathname).toBe("/review/SYD-1");
  });
});
