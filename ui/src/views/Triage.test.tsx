// @vitest-environment jsdom
//
// SYD-65: priority/labels go almost entirely unused because nothing prompts
// for them at the one moment a human is already making a judgment call —
// accepting an issue out of triage. Covers the pure default-priority rule
// and the "Accept → todo" prompt's wiring into a single updateIssue call.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act as reactAct } from "react";
import { createRoot } from "react-dom/client";
import { defaultAcceptPriority, TriageRow } from "./Triage";
import type { Issue } from "../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../api", () => ({
  addComment: vi.fn(),
  getIssue: vi.fn(),
  markDuplicate: vi.fn(),
  snoozeIssue: vi.fn(),
  updateIssue: vi.fn(() => Promise.resolve({})),
}));

import { updateIssue } from "../api";

const ISSUE: Issue = {
  id: 1, ref: "SYD-1", title: "Do the thing", description: "", summary: null,
  status: "triage", priority: "none",
  assigneeId: null, creatorId: 1, labels: [],
  sourceType: null, sourceDetail: null, sourceUrl: null,
  needsInput: false, snoozedUntil: null,
  createdAt: 0, updatedAt: 0,
};

describe("defaultAcceptPriority", () => {
  it("defaults an unset priority to medium", () => {
    expect(defaultAcceptPriority("none")).toBe("medium");
  });

  it("keeps a priority a human already set", () => {
    expect(defaultAcceptPriority("high")).toBe("high");
  });
});

describe("TriageRow accept → todo prompt", () => {
  beforeEach(() => vi.mocked(updateIssue).mockClear());

  async function renderRow(issue: Issue): Promise<HTMLElement> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await reactAct(async () => {
      root.render(
        <TriageRow
          issue={issue}
          act={(fn: () => Promise<unknown>) => { fn(); }}
          knownActorNames={[]}
          expanded={false}
          onToggleExpand={() => {}}
        />
      );
    });
    return container;
  }

  it("opens a priority/labels prompt defaulted to medium instead of accepting immediately", async () => {
    const container = await renderRow(ISSUE);
    const acceptButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Accept → todo")!;

    await reactAct(async () => acceptButton.click());

    expect(updateIssue).not.toHaveBeenCalled();
    const select = container.querySelector(".accept-prompt select") as HTMLSelectElement;
    expect(select.value).toBe("medium");
  });

  it("pre-fills the prompt with an already-set priority and existing labels", async () => {
    const container = await renderRow({ ...ISSUE, priority: "high", labels: ["backend"] });
    const acceptButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Accept → todo")!;

    await reactAct(async () => acceptButton.click());

    const select = container.querySelector(".accept-prompt select") as HTMLSelectElement;
    const labelsInput = container.querySelector(".accept-labels") as HTMLInputElement;
    expect(select.value).toBe("high");
    expect(labelsInput.value).toBe("backend");
  });

  it("confirms with a single status+priority+labels update", async () => {
    const container = await renderRow(ISSUE);
    const acceptButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Accept → todo")!;
    await reactAct(async () => acceptButton.click());

    const labelsInput = container.querySelector(".accept-labels") as HTMLInputElement;
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await reactAct(async () => {
      nativeSetter.call(labelsInput, "backend, urgent-fix");
      labelsInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const confirmButton = [...container.querySelectorAll<HTMLButtonElement>(".accept-prompt button")].find((b) => b.textContent === "Confirm")!;
    await reactAct(async () => confirmButton.click());

    expect(updateIssue).toHaveBeenCalledWith("SYD-1", {
      status: "todo", priority: "medium", labels: ["backend", "urgent-fix"],
    });
  });

  it("cancel closes the prompt without updating anything", async () => {
    const container = await renderRow(ISSUE);
    const acceptButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Accept → todo")!;
    await reactAct(async () => acceptButton.click());

    const cancelButton = [...container.querySelectorAll<HTMLButtonElement>(".accept-prompt button")].find((b) => b.textContent === "Cancel")!;
    await reactAct(async () => cancelButton.click());

    expect(updateIssue).not.toHaveBeenCalled();
    expect([...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Accept → todo")).toBeTruthy();
  });
});
