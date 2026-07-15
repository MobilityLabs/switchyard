// @vitest-environment jsdom
//
// SYD phase 1 task 8: the approval-queue panel is the human-presence surface
// for supervised sessions' hard-gate — a click on a surface Claude cannot
// drive. Covers the happy path (Approve removes the row) and a 4xx affirm
// failure staying visible inline rather than silently vanishing.
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Issue, PendingAction } from "../types";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    listPendingActions: vi.fn(() => Promise.resolve([] as PendingAction[])),
    listIssues: vi.fn(() => Promise.resolve([] as Issue[])),
    affirmPendingAction: vi.fn(),
  };
});

import { listPendingActions, listIssues, affirmPendingAction, ApiError } from "../api";
import Approvals from "./Approvals";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function pendingAction(overrides: Partial<PendingAction> = {}): PendingAction {
  return {
    id: 1,
    sessionId: 5,
    issueId: 42,
    actionType: "done",
    payload: { status: "done" },
    status: "pending",
    affirmedById: null,
    affirmedAt: null,
    createdAt: Math.floor(Date.now() / 1000) - 120,
    ...overrides,
  };
}

const ISSUE: Issue = {
  id: 42,
  ref: "SYD-42",
  title: "Ship the thing",
  description: "",
  summary: null,
  status: "in_progress",
  priority: "medium",
  assigneeId: null,
  creatorId: 1,
  labels: [],
  workerPreference: null,
  parentId: null,
  sourceType: null,
  sourceDetail: null,
  sourceUrl: null,
  needsInput: false,
  snoozedUntil: null,
  createdAt: 1,
  updatedAt: 1,
  attention: null,
  openPr: null,
};

async function renderApprovals(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Approvals />);
  });
  return container;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function buttonIn(scope: Element, label: string): HTMLButtonElement {
  const b = [...scope.querySelectorAll("button")].find((x) => x.textContent === label);
  if (!b) throw new Error(`no button "${label}"`);
  return b;
}

afterEach(() => {
  vi.mocked(listPendingActions).mockReset();
  vi.mocked(listIssues).mockReset();
  vi.mocked(affirmPendingAction).mockReset();
});

describe("Approvals view", () => {
  it("shows the empty state when nothing is pending", async () => {
    vi.mocked(listPendingActions).mockResolvedValue([]);
    vi.mocked(listIssues).mockResolvedValue([]);
    const container = await renderApprovals();
    expect(container.textContent).toContain("Nothing waiting on a human");
  });

  it("renders a queued row with its resolved issue ref, then removes it on Approve", async () => {
    vi.mocked(listPendingActions).mockResolvedValue([pendingAction()]);
    vi.mocked(listIssues).mockResolvedValue([ISSUE]);
    vi.mocked(affirmPendingAction).mockResolvedValue(ISSUE);
    const container = await renderApprovals();

    expect(container.querySelector('a[href="/issue/SYD-42"]')).not.toBeNull();
    expect(container.textContent).toContain("done");
    expect(container.textContent).toContain("session #5");

    // Approve re-polls the queue; simulate the row disappearing server-side.
    vi.mocked(listPendingActions).mockResolvedValue([]);
    await click(buttonIn(container, "Approve"));

    expect(affirmPendingAction).toHaveBeenCalledWith(1);
    expect(container.textContent).toContain("Nothing waiting on a human");
  });

  it("falls back to the honest issue id when the ref can't be resolved, never fabricating one", async () => {
    vi.mocked(listPendingActions).mockResolvedValue([pendingAction({ issueId: 999 })]);
    vi.mocked(listIssues).mockResolvedValue([]);
    const container = await renderApprovals();
    expect(container.textContent).toContain("issue #999");
    expect(container.querySelector("a.ref")).toBeNull();
  });

  it("keeps the row and surfaces the error message inline when affirm 400s (e.g. head moved)", async () => {
    vi.mocked(listPendingActions).mockResolvedValue([pendingAction()]);
    vi.mocked(listIssues).mockResolvedValue([ISSUE]);
    vi.mocked(affirmPendingAction).mockRejectedValue(
      new ApiError(400, "Pending action 1 is no longer pending — re-review."),
    );
    const container = await renderApprovals();

    await click(buttonIn(container, "Approve"));

    expect(container.textContent).toContain("re-review");
    // The row itself is still there — a failed affirm must not look approved.
    expect(container.querySelector('a[href="/issue/SYD-42"]')).not.toBeNull();
  });
});
