// @vitest-environment jsdom
//
// SYD-91: Accept → todo is a single click applying a sane default priority —
// no intermediate priority/labels prompt (that prompt was added by SYD-65
// and reverted per direct feedback: it added gate latency without earning
// its cost). Covers the pure default-priority rule and the button's wiring
// into a single updateIssue call.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act as reactAct } from "react";
import { createRoot } from "react-dom/client";
import Triage, { defaultAcceptPriority, TriageRow } from "./Triage";
import type { Issue } from "../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../api", () => ({
  addComment: vi.fn(),
  getIssue: vi.fn(),
  markDuplicate: vi.fn(),
  snoozeIssue: vi.fn(),
  updateIssue: vi.fn(() => Promise.resolve({})),
  listIssues: vi.fn(() => Promise.resolve([])),
  listActors: vi.fn(() => Promise.resolve([])),
}));

import { listIssues, updateIssue } from "../api";

const ISSUE: Issue = {
  id: 1,
  ref: "SYD-1",
  title: "Do the thing",
  description: "",
  summary: null,
  status: "triage",
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
};

describe("defaultAcceptPriority", () => {
  it("defaults an unset priority to medium", () => {
    expect(defaultAcceptPriority("none")).toBe("medium");
  });

  it("keeps a priority a human already set", () => {
    expect(defaultAcceptPriority("high")).toBe("high");
  });
});

describe("TriageRow accept → todo", () => {
  beforeEach(() => vi.mocked(updateIssue).mockClear());

  async function renderRow(issue: Issue): Promise<HTMLElement> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await reactAct(async () => {
      root.render(
        <TriageRow
          issue={issue}
          act={(fn: () => Promise<unknown>) => {
            fn();
          }}
          knownActorNames={[]}
          expanded={false}
          onToggleExpand={() => {}}
        />,
      );
    });
    return container;
  }

  it("accepts immediately with the default priority, leaving labels untouched", async () => {
    const container = await renderRow(ISSUE);
    const acceptButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Accept → todo",
    )!;

    await reactAct(async () => acceptButton.click());

    expect(updateIssue).toHaveBeenCalledWith("SYD-1", { status: "todo", priority: "medium" });
  });

  it("keeps an already-set priority instead of overriding it", async () => {
    const container = await renderRow({ ...ISSUE, priority: "high", labels: ["backend"] });
    const acceptButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Accept → todo",
    )!;

    await reactAct(async () => acceptButton.click());

    expect(updateIssue).toHaveBeenCalledWith("SYD-1", { status: "todo", priority: "high" });
  });
});

// SYD-131: the row is the primary click target for expanding a triage item,
// which previously had no keyboard/AT path at all.
describe("TriageRow keyboard accessibility", () => {
  async function renderRow(expanded: boolean, onToggleExpand: () => void): Promise<HTMLElement> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await reactAct(async () => {
      root.render(
        <TriageRow
          issue={ISSUE}
          act={() => {}}
          knownActorNames={[]}
          expanded={expanded}
          onToggleExpand={onToggleExpand}
        />
      );
    });
    return container;
  }

  it("is a focusable button target that reflects expanded state", async () => {
    const container = await renderRow(false, () => {});
    const row = container.querySelector(".triage-row")!;
    expect(row.getAttribute("role")).toBe("button");
    expect(row.getAttribute("tabIndex")).toBe("0");
    expect(row.getAttribute("aria-expanded")).toBe("false");
  });

  it("toggles expansion on Enter", async () => {
    let toggled = 0;
    const container = await renderRow(false, () => { toggled += 1; });
    const row = container.querySelector(".triage-row")!;
    await reactAct(async () => {
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(toggled).toBe(1);
  });

  it("toggles expansion on Space", async () => {
    let toggled = 0;
    const container = await renderRow(false, () => { toggled += 1; });
    const row = container.querySelector(".triage-row")!;
    await reactAct(async () => {
      row.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    });
    expect(toggled).toBe(1);
  });

  it("leaves toggling to the control when Enter originates from a nested button", async () => {
    let toggled = 0;
    const container = await renderRow(false, () => { toggled += 1; });
    const acceptButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Accept → todo")!;
    await reactAct(async () => {
      acceptButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(toggled).toBe(0);
  });
});

// SYD-77: Triage is project-scoped like Board, with a null project meaning
// "All projects" — both the main inbox poll and the needs-input lane must
// respect the current scope.
describe("Triage project scoping", () => {
  beforeEach(() => vi.mocked(listIssues).mockClear());

  async function renderTriage(project: string | null): Promise<void> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await reactAct(async () => {
      root.render(<Triage project={project} />);
    });
  }

  it("passes the project filter through to both the inbox and needs-input polls", async () => {
    await renderTriage("SYD");
    expect(listIssues).toHaveBeenCalledWith({
      project: "SYD",
      status: "triage",
      excludeSnoozed: true,
    });
    expect(listIssues).toHaveBeenCalledWith({ project: "SYD", needsInput: true });
  });

  it("omits the project filter for All projects", async () => {
    await renderTriage(null);
    expect(listIssues).toHaveBeenCalledWith({
      project: undefined,
      status: "triage",
      excludeSnoozed: true,
    });
    expect(listIssues).toHaveBeenCalledWith({ project: undefined, needsInput: true });
  });
});
