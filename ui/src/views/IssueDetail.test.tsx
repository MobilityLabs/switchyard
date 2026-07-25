// @vitest-environment jsdom
//
// Unit coverage for the delivery strip (SYD-54): computeDeliveryStatus folds
// the structured pr_opened/delivered/delivery_failed activity events into the
// state the issue view renders — PR link + open/merged, merge sha, deploy
// result, and a delivery-failure banner that clears once a later delivery
// succeeds.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api", () => ({
  addComment: vi.fn(),
  addDependency: vi.fn(),
  getIssue: vi.fn(),
  removeDependency: vi.fn(),
  updateIssue: vi.fn(() => Promise.resolve({})),
  redeliverIssue: vi.fn(() => Promise.resolve({})),
  resolveDeliveryFailure: vi.fn(() => Promise.resolve({})),
  listActors: vi.fn(() => Promise.resolve([])),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
}));

import IssueDetail, {
  ActivityFeed,
  AgentSessionStrip,
  AttentionBanner,
  computeDeliveryStatus,
  DescriptionSection,
  Event,
  groupProgressNotes,
  RestampBanner,
  withAttachmentIds,
} from "./IssueDetail";
import {
  getIssue,
  listAgentSessions,
  redeliverIssue,
  resolveDeliveryFailure,
  updateIssue,
} from "../api";
import type { Activity, Attachment, IssueDetail as IssueDetailType, Issue, Status } from "../types";
import { act } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ev = (o: Partial<Activity>): Activity => ({
  type: "comment",
  actorName: "claude/worker",
  viaAgentName: null,
  payload: {},
  createdAt: 1000,
  ...o,
});

// SYD-92: the full description is always visible on the detail view and the
// expanded triage row — no more "Show full description" click-to-reveal.
describe("DescriptionSection", () => {
  async function render(issue: {
    summary: string | null;
    description: string;
  }): Promise<HTMLElement> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<DescriptionSection issue={issue} projectKey="SYD" knownActorNames={[]} />);
    });
    return container;
  }

  it("renders the full description unconditionally, with no toggle button", async () => {
    const longDescription = "x".repeat(500);
    const container = await render({ summary: "a short summary", description: longDescription });
    expect(container.textContent).toContain(longDescription);
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).not.toContain("Show full description");
  });

  it("renders a short description without a summary lede or toggle", async () => {
    const container = await render({ summary: null, description: "just a short one" });
    expect(container.textContent).toContain("just a short one");
    expect(container.querySelector("button")).toBeNull();
  });

  it("falls back to 'No description.' when the description is empty", async () => {
    const container = await render({ summary: null, description: "" });
    expect(container.textContent).toBe("No description.");
  });
});

// SYD-96: SYD-84's badge renders on Board/Review but IssueDetail never
// rendered `attention` — a delivery_failed issue looked clean on its own
// page, which is where a human goes to investigate.
describe("AttentionBanner", () => {
  async function render(
    attention: Issue["attention"],
    onRetry?: () => void,
    onResolveClick?: () => void,
  ): Promise<HTMLElement> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <AttentionBanner attention={attention} onRetry={onRetry} onResolveClick={onResolveClick} />,
      );
    });
    return container;
  }

  it("renders nothing when the issue is clean", async () => {
    const container = await render(null);
    expect(container.querySelector(".banner.danger")).toBeNull();
  });

  it("renders a full-width danger banner with the failure message for an unresolved delivery_failed", async () => {
    const container = await render({ reason: "delivery_failed", message: "merge conflict" });
    const banner = container.querySelector(".banner.danger");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("merge conflict");
  });

  it("renders no Retry button when onRetry is not passed", async () => {
    const container = await render({ reason: "delivery_failed", message: "merge conflict" });
    expect(container.querySelector(".retry-delivery")).toBeNull();
  });

  // SYD-102: re-stamping done is a silent no-op, so the failure banner needs
  // its own retry trigger rather than telling humans to re-stamp done.
  it("renders a Retry delivery button that calls onRetry when clicked", async () => {
    let clicked = 0;
    const container = await render({ reason: "delivery_failed", message: "merge conflict" }, () => {
      clicked += 1;
    });
    const button = container.querySelector(".retry-delivery") as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(clicked).toBe(1);
  });

  // SYD-262: done_without_merged_pr is a warn banner with no action today, and
  // it can never clear itself on a feat/ branch — it needs the same explicit
  // "I checked, it landed" affordance delivery_failed has.
  it("offers Mark resolved on a done_without_merged_pr deviation", async () => {
    let clicked = 0;
    const container = await render(
      { reason: "done_without_merged_pr", message: "verify the code actually landed" },
      undefined,
      () => {
        clicked += 1;
      },
    );
    const button = container.querySelector(".resolve-delivery") as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(clicked).toBe(1);
  });

  // Retry re-authorizes an attributed agent PR; a deviation has none, so
  // offering it would be a button that cannot work.
  it("offers no Retry delivery on a done_without_merged_pr deviation", async () => {
    const container = await render(
      { reason: "done_without_merged_pr", message: "verify the code actually landed" },
      () => {},
      () => {},
    );
    expect(container.querySelector(".retry-delivery")).toBeNull();
  });

  it("renders no Mark resolved button when onResolveClick is not passed", async () => {
    const container = await render({ reason: "delivery_failed", message: "merge conflict" });
    expect(container.querySelector(".resolve-delivery")).toBeNull();
  });

  // SYD-178: Retry only helps when there's an agent PR pr_state can
  // re-authorize — a fix merged via a non-agent branch needs a separate,
  // explicit way for a human to clear the flag.
  it("renders a Mark resolved button that calls onResolveClick when clicked", async () => {
    let clicked = 0;
    const container = await render(
      { reason: "delivery_failed", message: "merge conflict" },
      undefined,
      () => {
        clicked += 1;
      },
    );
    const button = container.querySelector(".resolve-delivery") as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(clicked).toBe(1);
  });

  it("renders neither action button for a non-delivery attention reason", async () => {
    const container = await render(
      { reason: "stale_claim", message: "claimed 3 days ago" },
      () => {},
      () => {},
    );
    expect(container.querySelector(".retry-delivery")).toBeNull();
    expect(container.querySelector(".resolve-delivery")).toBeNull();
  });
});

// SYD-230: one-click re-authorize delivery of a done issue whose open agent PR
// never delivered (pin-less done), without the done→in_review→done round-trip.
describe("RestampBanner", () => {
  const openPr: Issue["openPr"] = {
    prNumber: 7,
    url: "https://github.com/acme/widgets/pull/7",
    repo: "acme/widgets",
    headSha: "sha1",
  };
  async function render(props: {
    status: Status;
    openPr: Issue["openPr"];
    attention: Issue["attention"];
    onRestamp?: () => void;
  }): Promise<HTMLElement> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<RestampBanner {...props} onRestamp={props.onRestamp ?? (() => {})} />);
    });
    return container;
  }

  it("renders nothing when the issue is not done", async () => {
    const container = await render({ status: "in_review", openPr, attention: null });
    expect(container.querySelector(".retry-delivery")).toBeNull();
  });

  it("renders nothing when done but there is no open PR", async () => {
    const container = await render({ status: "done", openPr: null, attention: null });
    expect(container.querySelector(".retry-delivery")).toBeNull();
  });

  it("renders nothing when a delivery failure is unresolved (AttentionBanner owns that retry)", async () => {
    const container = await render({
      status: "done",
      openPr,
      attention: { reason: "delivery_failed", message: "merge conflict" },
    });
    expect(container.querySelector(".retry-delivery")).toBeNull();
  });

  it("renders a Re-stamp delivery button naming the PR that calls onRestamp when clicked", async () => {
    let clicked = 0;
    const container = await render({
      status: "done",
      openPr,
      attention: null,
      onRestamp: () => {
        clicked += 1;
      },
    });
    const button = container.querySelector(".retry-delivery") as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    expect(container.textContent).toContain("#7");
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(clicked).toBe(1);
  });
});

describe("computeDeliveryStatus", () => {
  it("returns null when there is no delivery activity", () => {
    expect(computeDeliveryStatus([ev({ type: "created" }), ev({ type: "comment" })])).toBeNull();
  });

  it("reports an open PR from pr_opened alone", () => {
    const status = computeDeliveryStatus([
      ev({
        type: "pr_opened",
        payload: { prNumber: 7, url: "https://github.com/acme/widgets/pull/7" },
      }),
    ]);
    expect(status).toEqual({
      prNumber: 7,
      url: "https://github.com/acme/widgets/pull/7",
      state: "open",
      mergeSha: null,
      deploy: null,
      failedMessage: null,
      checks: null,
    });
  });

  it("reports merged + deploy result once delivered fires", () => {
    const status = computeDeliveryStatus([
      ev({ type: "pr_opened", createdAt: 1, payload: { prNumber: 7, url: "https://x/pull/7" } }),
      ev({
        type: "delivered",
        createdAt: 2,
        payload: {
          prNumber: 7,
          mergeSha: "abc123def",
          deploy: { ran: true, ok: true, tail: "done" },
        },
      }),
    ]);
    expect(status).toMatchObject({
      prNumber: 7,
      state: "merged",
      mergeSha: "abc123def",
      deploy: { ran: true, ok: true, tail: "done" },
      failedMessage: null,
    });
  });

  it("reports an open PR from gh_pr_opened, matching the manual pr_opened shape", () => {
    const status = computeDeliveryStatus([
      ev({
        type: "gh_pr_opened",
        payload: {
          prNumber: 9,
          url: "https://github.com/acme/widgets/pull/9",
          branch: "agent/SYD-1",
        },
      }),
    ]);
    expect(status).toMatchObject({
      prNumber: 9,
      url: "https://github.com/acme/widgets/pull/9",
      state: "open",
    });
  });

  it("reports merged from gh_pr_merged, preserving a deploy result from an earlier delivered event", () => {
    const status = computeDeliveryStatus([
      ev({ type: "pr_opened", createdAt: 1, payload: { prNumber: 7, url: "https://x/pull/7" } }),
      ev({
        type: "delivered",
        createdAt: 2,
        payload: { prNumber: 7, mergeSha: "old", deploy: { ran: true, ok: true, tail: "done" } },
      }),
      ev({
        type: "gh_pr_merged",
        createdAt: 3,
        payload: { prNumber: 7, url: "https://x/pull/7", mergeSha: "new123" },
      }),
    ]);
    expect(status).toMatchObject({
      state: "merged",
      mergeSha: "new123",
      deploy: { ran: true, ok: true, tail: "done" },
    });
  });

  it("reports closed (not merged) from gh_pr_closed", () => {
    const status = computeDeliveryStatus([
      ev({ type: "gh_pr_opened", createdAt: 1, payload: { prNumber: 7, url: "https://x/pull/7" } }),
      ev({ type: "gh_pr_closed", createdAt: 2, payload: { prNumber: 7, url: "https://x/pull/7" } }),
    ]);
    expect(status).toMatchObject({ state: "closed", mergeSha: null });
  });

  it("reports open again from gh_pr_reopened after a close (SYD-205)", () => {
    const status = computeDeliveryStatus([
      ev({ type: "gh_pr_opened", createdAt: 1, payload: { prNumber: 7, url: "https://x/pull/7" } }),
      ev({ type: "gh_pr_closed", createdAt: 2, payload: { prNumber: 7, url: "https://x/pull/7" } }),
      ev({
        type: "gh_pr_reopened",
        createdAt: 3,
        payload: { prNumber: 7, url: "https://x/pull/7", branch: "agent/SYD-1" },
      }),
    ]);
    expect(status).toMatchObject({ prNumber: 7, state: "open" });
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
        type: "delivered",
        createdAt: 3,
        payload: { prNumber: 7, mergeSha: "fedcba", deploy: { ran: true, ok: true, tail: "" } },
      }),
    ]);
    expect(status?.failedMessage).toBeNull();
    expect(status?.state).toBe("merged");
  });

  // SYD-178: a fix merged via a non-agent branch never produces a
  // delivered/gh_pr_merged event pr_state would recognize — a human's
  // explicit delivery_resolved is the only thing that clears the strip too.
  it("clears an earlier delivery_failed once a later delivery_resolved fires", () => {
    const status = computeDeliveryStatus([
      ev({ type: "pr_opened", createdAt: 1, payload: { prNumber: 7, url: "https://x/pull/7" } }),
      ev({ type: "delivery_failed", createdAt: 2, payload: { message: "rebase hit conflicts" } }),
      ev({
        type: "delivery_resolved",
        createdAt: 3,
        payload: { note: "merged via feat/SYD-1 PR #124" },
      }),
    ]);
    expect(status?.failedMessage).toBeNull();
  });

  it("does not let an earlier delivery_resolved mask a later delivery_failed", () => {
    const status = computeDeliveryStatus([
      ev({ type: "delivery_resolved", createdAt: 1, payload: { note: "resolved once" } }),
      ev({ type: "delivery_failed", createdAt: 2, payload: { message: "failed again" } }),
    ]);
    expect(status?.failedMessage).toBe("failed again");
  });
});

describe("withAttachmentIds", () => {
  const attachment = (o: Partial<Attachment>): Attachment => ({
    id: 1,
    filename: "shot.png",
    contentType: "image/png",
    size: 10,
    actorName: "claude/dev",
    createdAt: 1,
    ...o,
  });

  it("leaves events that already carry an id untouched", () => {
    const events = [
      ev({
        type: "attachment_added",
        payload: { id: 5, filename: "a.png", contentType: "image/png" },
      }),
    ];
    expect(withAttachmentIds(events, [])).toEqual(events);
  });

  it("backfills id + contentType for a historical event by matching filename", () => {
    const events = [ev({ type: "attachment_added", payload: { filename: "shot.png", size: 10 } })];
    const result = withAttachmentIds(events, [attachment({ id: 42 })]);
    expect(result[0].payload).toMatchObject({
      id: 42,
      contentType: "image/png",
      filename: "shot.png",
    });
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
      ev({
        type: "pr_opened",
        payload: { prNumber: 9, url: "https://github.com/acme/widgets/pull/9" },
      }),
    );
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://github.com/acme/widgets/pull/9");
    expect(link.textContent).toBe("PR #9");
  });

  it("summarizes a delivered event with a shortened sha", async () => {
    const container = await render(
      ev({
        type: "delivered",
        payload: {
          prNumber: 9,
          mergeSha: "abcdef1234567",
          deploy: { ran: true, ok: false, tail: "boom" },
        },
      }),
    );
    expect(container.textContent).toContain("PR #9");
    expect(container.textContent).toContain("abcdef1");
    expect(container.textContent).toContain("deploy FAILED");
  });

  it("shows a via-agent provenance chip for a supervised-session event (SYD-240)", async () => {
    const container = await render(
      ev({
        type: "comment",
        actorName: "sean",
        viaAgentName: "claude-code",
        payload: { body: "edited on Sean's behalf" },
      }),
    );
    expect(container.textContent).toContain("sean");
    expect(container.textContent).toContain("via claude-code");
    expect(container.querySelector(".via-agent-chip")).not.toBeNull();
  });

  it("omits the via-agent chip for a plain, non-supervised event", async () => {
    const container = await render(
      ev({ type: "comment", actorName: "sean", viaAgentName: null, payload: { body: "hi" } }),
    );
    expect(container.querySelector(".via-agent-chip")).toBeNull();
  });

  it("renders a delivery_resolved event with its note (SYD-178)", async () => {
    const container = await render(
      ev({
        type: "delivery_resolved",
        actorName: "sean",
        payload: { note: "merged via feat/SYD-1 PR #124" },
      }),
    );
    expect(container.textContent).toContain("sean");
    expect(container.textContent).toContain("merged via feat/SYD-1 PR #124");
  });

  it("links the PR in a gh_pr_merged event with its merge sha", async () => {
    const container = await render(
      ev({
        type: "gh_pr_merged",
        payload: {
          prNumber: 9,
          url: "https://github.com/acme/widgets/pull/9",
          mergeSha: "abcdef1234567",
        },
      }),
    );
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://github.com/acme/widgets/pull/9");
    expect(container.textContent).toContain("merged");
    expect(container.textContent).toContain("abcdef1");
  });

  it("renders a gh_pr_closed event without a merge sha", async () => {
    const container = await render(
      ev({
        type: "gh_pr_closed",
        payload: { prNumber: 9, url: "https://github.com/acme/widgets/pull/9" },
      }),
    );
    expect(container.textContent).toContain("closed");
    expect(container.textContent).not.toContain("at ");
  });

  it("flags a gh_checks_failed event as a failure", async () => {
    const container = await render(
      ev({ type: "gh_checks_failed", payload: { conclusion: "failure" } }),
    );
    expect(container.textContent).toContain("checks failed");
    expect(container.querySelector(".delivery-failed")).not.toBeNull();
  });

  it("links a gh_pushed event to the compare view with commit count and short sha", async () => {
    const container = await render(
      ev({
        type: "gh_pushed",
        payload: {
          commitCount: 3,
          headSha: "deadbeefcafe",
          url: "https://github.com/acme/widgets/compare/a...b",
        },
      }),
    );
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://github.com/acme/widgets/compare/a...b");
    expect(link.textContent).toBe("3 commits");
    expect(container.textContent).toContain("deadbee");
  });

  it("singularizes a gh_pushed event with one commit and renders without a link when there's no url", async () => {
    const container = await render(
      ev({ type: "gh_pushed", payload: { commitCount: 1, headSha: null, url: null } }),
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("1 commit");
    expect(container.textContent).not.toContain("1 commits");
  });

  it("renders an image attachment as a linked thumbnail", async () => {
    const container = await render(
      ev({
        type: "attachment_added",
        payload: { id: 7, filename: "shot.png", size: 10, contentType: "image/png" },
      }),
    );
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/api/attachments/7/shot.png");
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("/api/attachments/7/shot.png");
    expect(img.getAttribute("alt")).toBe("shot.png");
  });

  it("renders a non-image attachment as a filename link", async () => {
    const container = await render(
      ev({
        type: "attachment_added",
        payload: { id: 8, filename: "clip.mp4", size: 10, contentType: "video/mp4" },
      }),
    );
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/api/attachments/8/clip.mp4");
    expect(link.textContent).toBe("clip.mp4");
    expect(container.querySelector("img")).toBeNull();
  });

  it("falls back to plain text for a historical event with no id and no match", async () => {
    const container = await render(
      ev({ type: "attachment_added", payload: { filename: "old.png", size: 10 } }),
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("attached old.png");
  });
});

// SYD-262: the resolve writes a deviation_resolved event; without a renderer it
// falls through to the generic "actor deviation resolved" line and loses the
// note, which is the whole provenance the required-note rule exists to capture.
describe("Event rendering for deviation_resolved (SYD-262)", () => {
  it("names the actor and shows the note", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <Event
          ev={{
            type: "deviation_resolved",
            actorName: "sean",
            // SYD-240 made viaAgentName a required field on Activity; a human
            // clearing a flag directly has no delegate agent behind it.
            viaAgentName: null,
            createdAt: 1,
            payload: { reason: "done_without_merged_pr", note: "merged as d0073fb via PR #197" },
          }}
          projectKey="SYD"
        />,
      );
    });
    const line = container.querySelector(".event.deviation-resolved");
    expect(line).not.toBeNull();
    expect(line?.textContent).toContain("sean");
    expect(line?.textContent).toContain("merged as d0073fb via PR #197");
  });
});

// SYD-43: progress_note events are recorded by the dispatch worker mid-session
// (src/services/agent-sessions.ts) — the issue's activity feed should surface
// them like any other event rather than falling through to the generic
// "actor <type-with-underscores>" renderer.
describe("Event rendering for progress_note (SYD-43)", () => {
  it("renders the note text as a status line", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <Event
          ev={ev({ type: "progress_note", payload: { note: "compiling" } })}
          projectKey="SYD"
        />,
      );
    });
    expect(container.textContent).toContain("compiling");
    expect(container.querySelector(".progress-note")).not.toBeNull();
  });
});

// SYD-104: a chatty session posts 10-20 progress_note events per issue; the
// activity feed collapses consecutive runs of them to one visible line
// (latest note) with an expander, rather than drowning real comments.
describe("groupProgressNotes (SYD-104)", () => {
  it("keeps non-progress_note events as their own single-element groups", () => {
    const a = ev({ type: "created" });
    const b = ev({ type: "comment" });
    expect(groupProgressNotes([a, b])).toEqual([[a], [b]]);
  });

  it("collapses a consecutive run of progress_note events into one group", () => {
    const before = ev({ type: "comment" });
    const n1 = ev({ type: "progress_note", payload: { note: "one" } });
    const n2 = ev({ type: "progress_note", payload: { note: "two" } });
    const n3 = ev({ type: "progress_note", payload: { note: "three" } });
    const after = ev({ type: "comment" });
    expect(groupProgressNotes([before, n1, n2, n3, after])).toEqual([
      [before],
      [n1, n2, n3],
      [after],
    ]);
  });

  it("starts a new group when a non-note event splits two note runs", () => {
    const n1 = ev({ type: "progress_note", payload: { note: "one" } });
    const mid = ev({ type: "comment" });
    const n2 = ev({ type: "progress_note", payload: { note: "two" } });
    expect(groupProgressNotes([n1, mid, n2])).toEqual([[n1], [mid], [n2]]);
  });
});

describe("ActivityFeed (SYD-104)", () => {
  async function render(activity: Activity[]): Promise<HTMLElement> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ActivityFeed activity={activity} projectKey="SYD" />);
    });
    return container;
  }

  it("renders a lone progress_note like any other event, with no expander", async () => {
    const container = await render([ev({ type: "progress_note", payload: { note: "compiling" } })]);
    expect(container.textContent).toContain("compiling");
    expect(container.querySelector(".link-button")).toBeNull();
  });

  it("collapses a run of notes to the latest one plus an expander", async () => {
    const container = await render([
      ev({ type: "progress_note", payload: { note: "one" } }),
      ev({ type: "progress_note", payload: { note: "two" } }),
      ev({ type: "progress_note", payload: { note: "three" } }),
    ]);
    expect(container.textContent).toContain("three");
    expect(container.textContent).not.toContain("one");
    expect(container.textContent).not.toContain("two");
    const toggle = container.querySelector(".link-button") as HTMLButtonElement | null;
    expect(toggle).not.toBeNull();
    expect(toggle?.textContent).toContain("2 earlier progress notes");
  });

  it("expands to show every note in the run when the toggle is clicked", async () => {
    const container = await render([
      ev({ type: "progress_note", payload: { note: "one" } }),
      ev({ type: "progress_note", payload: { note: "two" } }),
    ]);
    const toggle = container.querySelector(".link-button") as HTMLButtonElement;
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("one");
    expect(container.textContent).toContain("two");
    expect(container.textContent).toContain("Show less");
  });

  it("does not collapse a comment sandwiched between progress_notes", async () => {
    const container = await render([
      ev({ type: "progress_note", payload: { note: "one" } }),
      ev({ type: "comment", payload: { body: "hello" } }),
      ev({ type: "progress_note", payload: { note: "two" } }),
    ]);
    expect(container.textContent).toContain("one");
    expect(container.textContent).toContain("hello");
    expect(container.textContent).toContain("two");
    expect(container.querySelector(".link-button")).toBeNull();
  });
});

// SYD-43: while the dispatch worker has a session running on this issue, the
// detail view shows liveness + the session's latest progress note so a human
// doesn't have to guess whether an agent is still working.
describe("AgentSessionStrip (SYD-43)", () => {
  it("shows a live line per active session with the last note and the actor name", async () => {
    vi.mocked(listAgentSessions).mockResolvedValue([
      {
        id: 1,
        ref: "SYD-1",
        issueTitle: "Ship v1",
        mode: "container",
        pid: null,
        status: "running",
        exitCode: null,
        startedAt: Math.floor(Date.now() / 1000) - 300,
        endedAt: null,
        lastNote: { note: "running the tests", createdAt: 0 },
        actor: "claude/worker",
      },
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<AgentSessionStrip refId="SYD-1" />);
    });
    expect(container.textContent).toContain("running the tests");
    expect(container.textContent).toContain("claude/worker via container");
    expect(container.textContent).toMatch(/5m/);
  });

  it("renders nothing when no session is active", async () => {
    vi.mocked(listAgentSessions).mockResolvedValue([]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<AgentSessionStrip refId="SYD-1" />);
    });
    expect(container.textContent).toBe("");
  });
});

// SYD-208: a done-stamp over an open agent PR, and a Retry over a pinned
// delivery attempt, must both carry the head sha the human actually saw
// rendered on the page — not whatever the server's PR row says right now —
// so the server can refuse the action if the PR moved underneath them.
describe("IssueDetail status select and Retry send the rendered PR head sha (SYD-208)", () => {
  function detail(o: Partial<IssueDetailType> = {}): IssueDetailType {
    return {
      id: 1,
      ref: "SYD-1",
      title: "Ship it",
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
      workerPreference: null,
      parentId: null,
      snoozedUntil: null,
      createdAt: 0,
      updatedAt: 0,
      attention: null,
      openPr: null,
      deliveryPin: null,
      children: [],
      parentRef: null,
      activity: [],
      dependencies: { blockedBy: [], blocks: [] },
      attachments: [],
      ...o,
    };
  }

  async function renderIssueDetail(d: IssueDetailType): Promise<HTMLElement> {
    vi.mocked(getIssue).mockResolvedValue(d);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<IssueDetail refId={d.ref} />);
    });
    await act(async () => {}); // flush the usePoll effects (getIssue, listActors)
    return container;
  }

  beforeEach(() => {
    vi.mocked(updateIssue).mockClear();
    vi.mocked(redeliverIssue).mockClear();
    vi.mocked(resolveDeliveryFailure).mockClear();
  });

  it("gathers child stories into a section and badges the count", async () => {
    const container = await renderIssueDetail(
      detail({
        children: [
          { ref: "SYD-2", title: "Story A", status: "todo" },
          { ref: "SYD-3", title: "Story B", status: "in_review" },
        ],
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Stories (2)");
    expect(text).toContain("2 stories"); // header count badge
    expect(container.querySelector('a[href*="SYD-2"]')).not.toBeNull();
    expect(container.querySelector('a[href*="SYD-3"]')).not.toBeNull();
  });

  it("changes the preferred worker via the header select (PATCH workerPreference)", async () => {
    const container = await renderIssueDetail(detail());
    const select = [...container.querySelectorAll("select")].find((s) =>
      [...s.options].some((o) => o.value === "interactive"),
    )!;
    await act(async () => {
      select.value = "interactive";
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    expect(updateIssue).toHaveBeenCalledWith("SYD-1", { workerPreference: "interactive" });
  });

  it("sends the openPr headSha as expectedHeadSha when the status select is changed to done", async () => {
    const container = await renderIssueDetail(
      detail({
        openPr: {
          prNumber: 12,
          url: "https://github.com/acme/widgets/pull/12",
          repo: "acme/widgets",
          headSha: "abc123",
        },
      }),
    );
    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "done";
      // `Event` is locally shadowed by the imported IssueDetail component of
      // the same name (used by the "Event rendering" describe blocks above),
      // so the native DOM constructor must be reached via `window`.
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    expect(updateIssue).toHaveBeenCalledWith("SYD-1", {
      status: "done",
      expectedHeadSha: "abc123",
    });
  });

  it("omits expectedHeadSha when the status select is changed to a non-done status", async () => {
    const container = await renderIssueDetail(
      detail({
        status: "todo",
        openPr: {
          prNumber: 12,
          url: "https://github.com/acme/widgets/pull/12",
          repo: "acme/widgets",
          headSha: "abc123",
        },
      }),
    );
    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "in_progress";
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    expect(updateIssue).toHaveBeenCalledWith("SYD-1", {
      status: "in_progress",
      expectedHeadSha: undefined,
    });
  });

  it("sends the deliveryPin headSha to redeliverIssue when Retry delivery is clicked", async () => {
    const container = await renderIssueDetail(
      detail({
        attention: { reason: "delivery_failed", message: "merge conflict" },
        deliveryPin: { repo: "acme/widgets", prNumber: 12, headSha: "def456", status: "open" },
      }),
    );
    const button = container.querySelector(".retry-delivery") as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(redeliverIssue).toHaveBeenCalledWith("SYD-1", "def456");
  });

  // SYD-178: a fix merged via a non-agent branch leaves deliveryPin null (no
  // pr_state row to re-authorize) — Mark resolved must still work there.
  it("opens a prompt and calls resolveDeliveryFailure with the typed note when Mark resolved is submitted", async () => {
    const container = await renderIssueDetail(
      detail({
        attention: { reason: "delivery_failed", message: "rebase hit real conflicts" },
        deliveryPin: null,
      }),
    );
    const button = container.querySelector(".resolve-delivery") as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const input = container.querySelector(".modal input") as HTMLInputElement;
    expect(input).not.toBeNull();
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      nativeSetter.call(input, "merged via feat/SYD-1 PR #124");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    const submit = container.querySelector(".modal .primary") as HTMLButtonElement;
    await act(async () => {
      submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(resolveDeliveryFailure).toHaveBeenCalledWith("SYD-1", "merged via feat/SYD-1 PR #124");
  });
});
