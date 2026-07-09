// @vitest-environment jsdom
//
// Unit coverage for the delivery strip (SYD-54): computeDeliveryStatus folds
// the structured pr_opened/delivered/delivery_failed activity events into the
// state the issue view renders — PR link + open/merged, merge sha, deploy
// result, and a delivery-failure banner that clears once a later delivery
// succeeds.
import { describe, it, expect } from "vitest";
import { computeDeliveryStatus, Event } from "./IssueDetail";
import type { Activity } from "../types";
import { act } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ev = (o: Partial<Activity>): Activity => ({
  type: "comment", actorName: "claude/worker", payload: {}, createdAt: 1000, ...o,
});

describe("computeDeliveryStatus", () => {
  it("returns null when there is no delivery activity", () => {
    expect(computeDeliveryStatus([ev({ type: "created" }), ev({ type: "comment" })])).toBeNull();
  });

  it("reports an open PR from pr_opened alone", () => {
    const status = computeDeliveryStatus([
      ev({ type: "pr_opened", payload: { prNumber: 7, url: "https://github.com/acme/widgets/pull/7" } }),
    ]);
    expect(status).toEqual({
      prNumber: 7, url: "https://github.com/acme/widgets/pull/7", state: "open",
      mergeSha: null, deploy: null, failedMessage: null,
    });
  });

  it("reports merged + deploy result once delivered fires", () => {
    const status = computeDeliveryStatus([
      ev({ type: "pr_opened", createdAt: 1, payload: { prNumber: 7, url: "https://x/pull/7" } }),
      ev({
        type: "delivered", createdAt: 2,
        payload: { prNumber: 7, mergeSha: "abc123def", deploy: { ran: true, ok: true, tail: "done" } },
      }),
    ]);
    expect(status).toMatchObject({
      prNumber: 7, state: "merged", mergeSha: "abc123def",
      deploy: { ran: true, ok: true, tail: "done" }, failedMessage: null,
    });
  });

  it("surfaces a delivery_failed banner when it is the most recent delivery event", () => {
    const status = computeDeliveryStatus([
      ev({ type: "pr_opened", createdAt: 1, payload: { prNumber: 7, url: "https://x/pull/7" } }),
      ev({ type: "delivery_failed", createdAt: 2, payload: { message: "merge conflict" } }),
    ]);
    expect(status?.failedMessage).toBe("merge conflict");
    expect(status?.state).toBe("open");
  });

  it("clears an earlier delivery_failed once a later delivered succeeds", () => {
    const status = computeDeliveryStatus([
      ev({ type: "pr_opened", createdAt: 1, payload: { prNumber: 7, url: "https://x/pull/7" } }),
      ev({ type: "delivery_failed", createdAt: 2, payload: { message: "deploy broke" } }),
      ev({
        type: "delivered", createdAt: 3,
        payload: { prNumber: 7, mergeSha: "fedcba", deploy: { ran: true, ok: true, tail: "" } },
      }),
    ]);
    expect(status?.failedMessage).toBeNull();
    expect(status?.state).toBe("merged");
  });
});

describe("Event rendering for delivery events", () => {
  async function render(event: Activity): Promise<HTMLElement> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Event ev={event} projectKey="SYD" />);
    });
    return container;
  }

  it("links the PR in a pr_opened event", async () => {
    const container = await render(
      ev({ type: "pr_opened", payload: { prNumber: 9, url: "https://github.com/acme/widgets/pull/9" } })
    );
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://github.com/acme/widgets/pull/9");
    expect(link.textContent).toBe("PR #9");
  });

  it("summarizes a delivered event with a shortened sha", async () => {
    const container = await render(
      ev({
        type: "delivered",
        payload: { prNumber: 9, mergeSha: "abcdef1234567", deploy: { ran: true, ok: false, tail: "boom" } },
      })
    );
    expect(container.textContent).toContain("PR #9");
    expect(container.textContent).toContain("abcdef1");
    expect(container.textContent).toContain("deploy FAILED");
  });
});
