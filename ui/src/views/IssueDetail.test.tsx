// @vitest-environment jsdom
//
// Unit coverage for the delivery strip (SYD-54): computeDeliveryStatus folds
// the structured pr_opened/delivered/delivery_failed activity events into the
// state the issue view renders — PR link + open/merged, merge sha, deploy
// result, and a delivery-failure banner that clears once a later delivery
// succeeds.
import { describe, it, expect } from "vitest";
import { computeDeliveryStatus, Event, withAttachmentIds } from "./IssueDetail";
import type { Activity, Attachment } from "../types";
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
      mergeSha: null, deploy: null, failedMessage: null, checks: null,
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

  it("reports an open PR from gh_pr_opened, matching the manual pr_opened shape", () => {
    const status = computeDeliveryStatus([
      ev({ type: "gh_pr_opened", payload: { prNumber: 9, url: "https://github.com/acme/widgets/pull/9", branch: "agent/SYD-1" } }),
    ]);
    expect(status).toMatchObject({ prNumber: 9, url: "https://github.com/acme/widgets/pull/9", state: "open" });
  });

  it("reports merged from gh_pr_merged, preserving a deploy result from an earlier delivered event", () => {
    const status = computeDeliveryStatus([
      ev({ type: "pr_opened", createdAt: 1, payload: { prNumber: 7, url: "https://x/pull/7" } }),
      ev({
        type: "delivered", createdAt: 2,
        payload: { prNumber: 7, mergeSha: "old", deploy: { ran: true, ok: true, tail: "done" } },
      }),
      ev({ type: "gh_pr_merged", createdAt: 3, payload: { prNumber: 7, url: "https://x/pull/7", mergeSha: "new123" } }),
    ]);
    expect(status).toMatchObject({
      state: "merged", mergeSha: "new123", deploy: { ran: true, ok: true, tail: "done" },
    });
  });

  it("reports closed (not merged) from gh_pr_closed", () => {
    const status = computeDeliveryStatus([
      ev({ type: "gh_pr_opened", createdAt: 1, payload: { prNumber: 7, url: "https://x/pull/7" } }),
      ev({ type: "gh_pr_closed", createdAt: 2, payload: { prNumber: 7, url: "https://x/pull/7" } }),
    ]);
    expect(status).toMatchObject({ state: "closed", mergeSha: null });
  });

  it("folds gh_checks_passed / gh_checks_failed into the checks field, latest wins", () => {
    const passed = computeDeliveryStatus([
      ev({ type: "gh_pr_opened", createdAt: 1, payload: { prNumber: 7, url: "https://x/pull/7" } }),
      ev({ type: "gh_checks_failed", createdAt: 2, payload: { conclusion: "failure" } }),
      ev({ type: "gh_checks_passed", createdAt: 3, payload: { conclusion: "success" } }),
    ]);
    expect(passed?.checks).toBe("passed");

    const failed = computeDeliveryStatus([
      ev({ type: "gh_pr_opened", createdAt: 1, payload: { prNumber: 7, url: "https://x/pull/7" } }),
      ev({ type: "gh_checks_passed", createdAt: 2, payload: { conclusion: "success" } }),
      ev({ type: "gh_checks_failed", createdAt: 3, payload: { conclusion: "failure" } }),
    ]);
    expect(failed?.checks).toBe("failed");
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

describe("withAttachmentIds", () => {
  const attachment = (o: Partial<Attachment>): Attachment => ({
    id: 1, filename: "shot.png", contentType: "image/png", size: 10, actorName: "claude/dev", createdAt: 1, ...o,
  });

  it("leaves events that already carry an id untouched", () => {
    const events = [ev({ type: "attachment_added", payload: { id: 5, filename: "a.png", contentType: "image/png" } })];
    expect(withAttachmentIds(events, [])).toEqual(events);
  });

  it("backfills id + contentType for a historical event by matching filename", () => {
    const events = [ev({ type: "attachment_added", payload: { filename: "shot.png", size: 10 } })];
    const result = withAttachmentIds(events, [attachment({ id: 42 })]);
    expect(result[0].payload).toMatchObject({ id: 42, contentType: "image/png", filename: "shot.png" });
  });

  it("consumes each attachment at most once so duplicate filenames map to distinct rows", () => {
    const events = [
      ev({ type: "attachment_added", payload: { filename: "shot.png" } }),
      ev({ type: "attachment_added", payload: { filename: "shot.png" } }),
    ];
    const result = withAttachmentIds(events, [attachment({ id: 1 }), attachment({ id: 2 })]);
    expect(result[0].payload.id).toBe(1);
    expect(result[1].payload.id).toBe(2);
  });

  it("leaves the event unmatched (no id) when no attachment has that filename", () => {
    const events = [ev({ type: "attachment_added", payload: { filename: "missing.png" } })];
    const result = withAttachmentIds(events, [attachment({ id: 1, filename: "other.png" })]);
    expect(result[0].payload.id).toBeUndefined();
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

  it("links the PR in a gh_pr_merged event with its merge sha", async () => {
    const container = await render(
      ev({ type: "gh_pr_merged", payload: { prNumber: 9, url: "https://github.com/acme/widgets/pull/9", mergeSha: "abcdef1234567" } })
    );
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://github.com/acme/widgets/pull/9");
    expect(container.textContent).toContain("merged");
    expect(container.textContent).toContain("abcdef1");
  });

  it("renders a gh_pr_closed event without a merge sha", async () => {
    const container = await render(
      ev({ type: "gh_pr_closed", payload: { prNumber: 9, url: "https://github.com/acme/widgets/pull/9" } })
    );
    expect(container.textContent).toContain("closed");
    expect(container.textContent).not.toContain("at ");
  });

  it("flags a gh_checks_failed event as a failure", async () => {
    const container = await render(ev({ type: "gh_checks_failed", payload: { conclusion: "failure" } }));
    expect(container.textContent).toContain("checks failed");
    expect(container.querySelector(".delivery-failed")).not.toBeNull();
  });

  it("links a gh_pushed event to the compare view with commit count and short sha", async () => {
    const container = await render(
      ev({
        type: "gh_pushed",
        payload: { commitCount: 3, headSha: "deadbeefcafe", url: "https://github.com/acme/widgets/compare/a...b" },
      })
    );
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://github.com/acme/widgets/compare/a...b");
    expect(link.textContent).toBe("3 commits");
    expect(container.textContent).toContain("deadbee");
  });

  it("singularizes a gh_pushed event with one commit and renders without a link when there's no url", async () => {
    const container = await render(ev({ type: "gh_pushed", payload: { commitCount: 1, headSha: null, url: null } }));
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("1 commit");
    expect(container.textContent).not.toContain("1 commits");
  });

  it("renders an image attachment as a linked thumbnail", async () => {
    const container = await render(
      ev({ type: "attachment_added", payload: { id: 7, filename: "shot.png", size: 10, contentType: "image/png" } })
    );
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/api/attachments/7/shot.png");
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("/api/attachments/7/shot.png");
    expect(img.getAttribute("alt")).toBe("shot.png");
  });

  it("renders a non-image attachment as a filename link", async () => {
    const container = await render(
      ev({ type: "attachment_added", payload: { id: 8, filename: "clip.mp4", size: 10, contentType: "video/mp4" } })
    );
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/api/attachments/8/clip.mp4");
    expect(link.textContent).toBe("clip.mp4");
    expect(container.querySelector("img")).toBeNull();
  });

  it("falls back to plain text for a historical event with no id and no match", async () => {
    const container = await render(
      ev({ type: "attachment_added", payload: { filename: "old.png", size: 10 } })
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("attached old.png");
  });
});
