// @vitest-environment jsdom
//
// SYD phase 1 task 8 / phase 2 task 10: the approval-queue panel is the
// human-presence surface for supervised sessions' hard-gate — a click on a
// surface Claude cannot drive. Covers the happy path (Approve removes the
// row), a 4xx affirm failure staying visible inline rather than silently
// vanishing, and (phase 2) that the panel never offers a button that would
// 403 when supervised.affirm_requires_signature is on (SYD-242), and that it
// no longer polls the whole issue list to resolve a ref (SYD-244).
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Issue, PendingAction, SettingView } from "../types";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    listPendingActions: vi.fn(() => Promise.resolve([] as PendingAction[])),
    listIssues: vi.fn(() => Promise.resolve([] as Issue[])),
    affirmPendingAction: vi.fn(),
    listSettings: vi.fn(() => Promise.resolve([] as SettingView[])),
  };
});

import { listPendingActions, listIssues, affirmPendingAction, listSettings, ApiError } from "../api";
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
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    issueRef: "SYD-42",
    issueStatus: "in_progress",
    canonical: '{"v":1}',
    viaAgentName: null,
    ...overrides,
  };
}

function signatureSetting(required: boolean): SettingView {
  return {
    key: "supervised.affirm_requires_signature",
    value: required,
    default: false,
    isDefault: !required,
    description: "Require a hardware-signed affirmation to release a gated action.",
  };
}

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

function findButton(scope: Element, label: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll("button")].find((x) => x.textContent === label);
}

afterEach(() => {
  vi.mocked(listPendingActions).mockReset();
  vi.mocked(listIssues).mockReset();
  vi.mocked(affirmPendingAction).mockReset();
  vi.mocked(listSettings).mockReset();
});

describe("Approvals view", () => {
  it("shows the empty state when nothing is pending", async () => {
    vi.mocked(listPendingActions).mockResolvedValue([]);
    const container = await renderApprovals();
    expect(container.textContent).toContain("Nothing waiting on a human");
  });

  it("renders a queued row's ref straight from the endpoint, then removes it on Approve, without polling the issue list", async () => {
    vi.mocked(listPendingActions).mockResolvedValue([pendingAction()]);
    vi.mocked(affirmPendingAction).mockResolvedValue({} as Issue);
    const container = await renderApprovals();

    expect(container.querySelector('a[href="/issue/SYD-42"]')).not.toBeNull();
    expect(container.textContent).toContain("done");
    expect(container.textContent).toContain("session #5");
    expect(listIssues).not.toHaveBeenCalled();

    // Approve re-polls the queue; simulate the row disappearing server-side.
    vi.mocked(listPendingActions).mockResolvedValue([]);
    await click(buttonIn(container, "Approve"));

    expect(affirmPendingAction).toHaveBeenCalledWith(1);
    expect(container.textContent).toContain("Nothing waiting on a human");
  });

  it("falls back to the honest issue id when the endpoint returns no ref, never fabricating one", async () => {
    vi.mocked(listPendingActions).mockResolvedValue([pendingAction({ issueId: 999, issueRef: null })]);
    const container = await renderApprovals();
    expect(container.textContent).toContain("issue #999");
    expect(container.querySelector("a.ref")).toBeNull();
  });

  it("keeps the row and surfaces the error message inline when affirm 400s (e.g. head moved)", async () => {
    vi.mocked(listPendingActions).mockResolvedValue([pendingAction()]);
    vi.mocked(affirmPendingAction).mockRejectedValue(
      new ApiError(400, "Pending action 1 is no longer pending — re-review."),
    );
    const container = await renderApprovals();

    await click(buttonIn(container, "Approve"));

    expect(container.textContent).toContain("re-review");
    // The row itself is still there — a failed affirm must not look approved.
    expect(container.querySelector('a[href="/issue/SYD-42"]')).not.toBeNull();
  });

  it("shows which agent proposed the action", async () => {
    vi.mocked(listPendingActions).mockResolvedValue([pendingAction({ viaAgentName: "claude/dev" })]);
    const container = await renderApprovals();
    expect(container.textContent).toContain("claude/dev");
  });

  it("still shows Approve when signatures are not required", async () => {
    vi.mocked(listPendingActions).mockResolvedValue([pendingAction()]);
    vi.mocked(listSettings).mockResolvedValue([signatureSetting(false)]);
    const container = await renderApprovals();
    expect(findButton(container, "Approve")).not.toBeUndefined();
  });

  it("hides Approve and explains why when signatures are required", async () => {
    vi.mocked(listPendingActions).mockResolvedValue([pendingAction()]);
    vi.mocked(listSettings).mockResolvedValue([signatureSetting(true)]);
    const container = await renderApprovals();

    expect(container.querySelector('a[href="/issue/SYD-42"]')).not.toBeNull();
    expect(findButton(container, "Approve")).toBeUndefined();
    expect(container.textContent).toContain("npm run affirm -- <REF>");
    expect(container.textContent).toContain("PIN or fingerprint, depending on your key");
  });
});
