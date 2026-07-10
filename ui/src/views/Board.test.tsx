// @vitest-environment jsdom
//
// SYD-84: a delivery_failed with no later delivery clear must be glanceable
// on the board without opening the issue — the Card renders a red badge from
// the server-derived `attention` field (Board never fetches full activity).
import { describe, it, expect } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Card } from "./Board";
import type { Issue } from "../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function issue(o: Partial<Issue> = {}): Issue {
  return {
    id: 1, ref: "SYD-1", title: "Ship it", description: "", summary: null,
    status: "done", priority: "none",
    assigneeId: null, creatorId: 1, labels: [],
    sourceType: null, sourceDetail: null, sourceUrl: null,
    needsInput: false, snoozedUntil: null,
    createdAt: 0, updatedAt: 0, attention: null,
    ...o,
  };
}

async function render(i: Issue): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Card issue={i} />);
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
