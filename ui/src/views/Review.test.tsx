// @vitest-environment jsdom
//
// SYD-75: the item under review must not silently swap when the polled
// in_review list reorders or grows underneath the reviewer. Selection is
// keyed by ref (from the URL), and new arrivals surface as a non-disruptive
// count instead of reordering the current view.
//
// SYD-70: approving/sending back an issue in Review mode reloads the list
// and advances to the next in-review issue, but the scroll container (the
// `.content` div rendered by Shell — see Shell.tsx) kept its old scroll
// position, so reviewers landed mid-page on the next issue. Approve, send
// back, Prev/Next, and their keyboard shortcuts should all snap it back to
// the top instantly (no smooth-scroll). Ported onto the ref-keyed selection
// model from SYD-75/77: the scroll reset now lives in a single effect keyed
// on currentRef (see Review.tsx), so it fires for every navigation path.
// SYD-77: Review is also project-scoped like Board, with a null project
// meaning "All projects" — the in_review queue poll must respect the
// current scope, and switching scope must reset which item is showing.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Issue, IssueDetail } from "../types";

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
import { navigate, useRoute } from "../router";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function issue(ref: string, title = `Title for ${ref}`): Issue {
  return {
    id: Number(ref.split("-")[1]),
    ref,
    title,
    description: "",
    summary: null,
    status: "in_review",
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
    openPr: null,
  };
}

function detailOf(i: Issue): IssueDetail {
  return { ...i, activity: [], dependencies: { blockedBy: [], blocks: [] }, attachments: [] };
}

// Mirrors how App.tsx wires the route's project/ref into Review, so a
// redirect the component fires (bare /review -> /review/:ref) is observed
// the same way a real page would observe it.
function ReviewRoute() {
  const route = useRoute();
  if (route.view !== "review") return null;
  return <Review project={route.project} currentRef={route.ref} />;
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
      issue("SYD-3", "Third"),
      issue("SYD-2", "Second"),
      issue("SYD-1", "First"),
    ]);
    await act(async () => {
      vi.advanceTimersByTime(15000);
    });
    await flush();

    expect(refText(container)).toBe("SYD-2");
    expect(container.querySelector(".review-new-arrivals")?.textContent).toBe("1 new");
  });

  it("shows a banner and never auto-jumps when the displayed issue leaves in_review", async () => {
    vi.mocked(listIssues).mockResolvedValue([issue("SYD-1", "First"), issue("SYD-2", "Second")]);
    const container = await mountReviewRoute("/review/SYD-9");

    expect(container.querySelector(".review-left")?.textContent).toContain(
      "SYD-9 is no longer in review",
    );
    expect(refText(container)).toBeNull();
    expect(location.pathname).toBe("/review/SYD-9");

    const jumpButton = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Jump to next",
    )!;
    await act(async () => {
      jumpButton.click();
    });
    await flush();

    expect(location.pathname).toBe("/review/SYD-1");
  });
});

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(label),
  );
  if (!button) throw new Error(`no button labeled "${label}"`);
  return button as HTMLButtonElement;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

describe("Review scroll-to-top (SYD-70)", () => {
  let contentDiv: HTMLDivElement;
  let container: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(listIssues).mockReset();
    vi.mocked(listIssues).mockResolvedValue([issue("SYD-1", "First"), issue("SYD-2", "Second")]);

    // Mirrors Shell.tsx's <div className="content">{children}</div>, which
    // is the actual scrolling element (overflow-y: auto; see styles.css).
    contentDiv = document.createElement("div");
    contentDiv.className = "content";
    contentDiv.scrollTo = vi.fn();
    document.body.appendChild(contentDiv);
    container = document.createElement("div");
    contentDiv.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    contentDiv.remove();
  });

  async function mount(path: string): Promise<void> {
    history.replaceState(null, "", path);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ReviewRoute />);
    });
    await flush();
  }

  it("scrolls .content to the top when Next is clicked", async () => {
    await mount("/review/SYD-1");
    (contentDiv.scrollTo as ReturnType<typeof vi.fn>).mockClear();
    await click(findButton(container, "Next"));
    expect(contentDiv.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("scrolls .content to the top when Prev is clicked", async () => {
    await mount("/review/SYD-2");
    (contentDiv.scrollTo as ReturnType<typeof vi.fn>).mockClear();
    await click(findButton(container, "Prev"));
    expect(contentDiv.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("scrolls .content to the top when the j/k keyboard shortcuts fire", async () => {
    await mount("/review/SYD-1");
    (contentDiv.scrollTo as ReturnType<typeof vi.fn>).mockClear();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "j" }));
    });
    await flush();
    expect(contentDiv.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("scrolls .content to the top after a successful Approve", async () => {
    await mount("/review/SYD-1");
    (contentDiv.scrollTo as ReturnType<typeof vi.fn>).mockClear();
    await click(findButton(container, "Approve"));
    expect(contentDiv.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("scrolls .content to the top after a successful Send back", async () => {
    await mount("/review/SYD-1");
    const textarea = container.querySelector("textarea")!;
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      nativeSetter.call(textarea, "please fix the thing");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    (contentDiv.scrollTo as ReturnType<typeof vi.fn>).mockClear();
    await click(findButton(container, "Send back"));
    expect(contentDiv.scrollTo).toHaveBeenCalledWith(0, 0);
  });
});

describe("Review row attention badge (SYD-98)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(listIssues).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders no attention badge when the issue is clean", async () => {
    vi.mocked(listIssues).mockResolvedValue([issue("SYD-1", "First")]);
    const container = await mountReviewRoute("/review/SYD-1");
    expect(container.querySelector(".issue-head .badge.danger")).toBeNull();
  });

  it("renders an icon-only badge for an unresolved delivery_failed, with the message as a hover title", async () => {
    vi.mocked(listIssues).mockResolvedValue([
      {
        ...issue("SYD-1", "First"),
        attention: { reason: "delivery_failed", message: "merge conflict" },
      },
    ]);
    const container = await mountReviewRoute("/review/SYD-1");
    const badge = container.querySelector(".issue-head .badge.danger");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).not.toContain("merge conflict");
    expect(badge?.textContent).toBe("⛔ delivery failed");
    expect(badge?.getAttribute("title")).toBe("merge conflict");
  });
});

describe("Review project scoping", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(listIssues).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes the project filter through to the in_review poll", async () => {
    vi.mocked(listIssues).mockResolvedValue([]);
    await mountReviewRoute("/review/SYD");
    expect(listIssues).toHaveBeenCalledWith({ project: "SYD", status: "in_review" });
  });

  it("omits the project filter for All projects", async () => {
    vi.mocked(listIssues).mockResolvedValue([]);
    await mountReviewRoute("/review");
    expect(listIssues).toHaveBeenCalledWith({ project: undefined, status: "in_review" });
  });

  it("resets to the first item when the project scope changes", async () => {
    vi.mocked(listIssues).mockResolvedValue([issue("SYD-1", "First"), issue("SYD-2", "Second")]);
    const container = await mountReviewRoute("/review/SYD");
    expect(location.pathname).toBe("/review/SYD-1");
    expect(refText(container)).toBe("SYD-1");

    vi.mocked(listIssues).mockResolvedValue([issue("ACME-1", "First"), issue("ACME-2", "Second")]);
    await act(async () => {
      navigate({ view: "review", project: "ACME", ref: null });
    });
    await flush();

    expect(location.pathname).toBe("/review/ACME-1");
    expect(refText(container)).toBe("ACME-1");
  });

  it("a bare project path (e.g. /review/SYD) scopes the queue, distinct from a specific ref", async () => {
    vi.mocked(listIssues).mockResolvedValue([issue("SYD-1", "First"), issue("SYD-2", "Second")]);
    const projectContainer = await mountReviewRoute("/review/SYD");
    expect(refText(projectContainer)).toBe("SYD-1");

    vi.mocked(listIssues).mockReset();
    vi.mocked(listIssues).mockResolvedValue([issue("SYD-1", "First"), issue("SYD-2", "Second")]);
    const refContainer = await mountReviewRoute("/review/SYD-2");
    expect(refText(refContainer)).toBe("SYD-2");
    expect(listIssues).toHaveBeenCalledWith({ project: "SYD", status: "in_review" });
  });
});
