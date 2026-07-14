import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type Db } from "../../src/db/index.js";
import { issues } from "../../src/db/schema.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, getIssue } from "../../src/services/issues.js";
import { listIssueEvents } from "../../src/services/events.js";
import { searchIssues } from "../../src/services/search.js";
import {
  snoozeIssue,
  markDuplicate,
  redeliverIssue,
  resolveDeliveryFailure,
} from "../../src/services/triage-actions.js";
import { recordDeliveryEvent } from "../../src/services/delivery-events.js";
import { addGithubRepo } from "../../src/services/github-repos.js";

const REPO = "acme/widgets";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "AIPI", name: "aipi" });
  createIssue(db, human, { projectKey: "AIPI", title: "First" });
  createIssue(db, human, { projectKey: "AIPI", title: "Second" });
});

describe("snoozeIssue", () => {
  it("rejects agents legibly", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    expect(() => snoozeIssue(db, agent, "AIPI-1", future)).toThrowError(/human/i);
  });

  it("rejects a non-future until", () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    expect(() => snoozeIssue(db, human, "AIPI-1", past)).toThrowError(/future/i);
  });

  it("sets snoozedUntil and records a snoozed event", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const updated = snoozeIssue(db, human, "AIPI-1", future);
    expect(updated.snoozedUntil).toBe(future);
    const events = listIssueEvents(db, updated.id);
    const snoozed = events.at(-1)!;
    expect(snoozed.type).toBe("snoozed");
    expect(snoozed.payload).toMatchObject({ until: future });
  });

  it("hides snoozed issues from excludeSnoozed searches until the time passes", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const snoozed = snoozeIssue(db, human, "AIPI-1", future);

    expect(
      searchIssues(db, { excludeSnoozed: true })
        .map((i) => i.ref)
        .sort(),
    ).toEqual(["AIPI-2"]);
    expect(
      searchIssues(db, {})
        .map((i) => i.ref)
        .sort(),
    ).toEqual(["AIPI-1", "AIPI-2"]);

    // simulate the passage of time by pushing snoozedUntil into the past directly (test setup only —
    // the service itself only accepts future timestamps)
    const past = Math.floor(Date.now() / 1000) - 10;
    db.update(issues).set({ snoozedUntil: past }).where(eq(issues.id, snoozed.id)).run();

    expect(
      searchIssues(db, { excludeSnoozed: true })
        .map((i) => i.ref)
        .sort(),
    ).toEqual(["AIPI-1", "AIPI-2"]);
  });
});

describe("markDuplicate", () => {
  it("rejects agents legibly", () => {
    expect(() => markDuplicate(db, agent, "AIPI-1", "AIPI-2")).toThrowError(/human/i);
  });

  it("rejects self-duplicate", () => {
    expect(() => markDuplicate(db, human, "AIPI-1", "AIPI-1")).toThrowError(/itself|differ/i);
  });

  it("rejects a nonexistent ofRef", () => {
    expect(() => markDuplicate(db, human, "AIPI-1", "AIPI-99")).toThrowError(/does not exist/i);
  });

  it("cancels the issue and records a marked_duplicate event linking to ofRef", () => {
    const updated = markDuplicate(db, human, "AIPI-1", "AIPI-2");
    expect(updated.status).toBe("canceled");
    const types = listIssueEvents(db, updated.id).map((e) => e.type);
    expect(types).toContain("marked_duplicate");
    const dup = listIssueEvents(db, updated.id).find((e) => e.type === "marked_duplicate")!;
    expect(dup.payload).toMatchObject({ of: "AIPI-2" });
    expect(getIssue(db, "AIPI-1").status).toBe("canceled");
  });
});

describe("redeliverIssue", () => {
  it("rejects agents legibly", () => {
    recordDeliveryEvent(db, human, "AIPI-1", {
      type: "delivery_failed",
      message: "merge conflict",
    });
    expect(() => redeliverIssue(db, agent, "AIPI-1")).toThrowError(/human/i);
  });

  it("rejects an issue with no unresolved delivery failure", () => {
    expect(() => redeliverIssue(db, human, "AIPI-1")).toThrowError(
      /no unresolved delivery failure/i,
    );
  });

  it("rejects an issue whose delivery_failed was already resolved", () => {
    recordDeliveryEvent(db, human, "AIPI-1", {
      type: "delivery_failed",
      message: "merge conflict",
    });
    recordDeliveryEvent(db, human, "AIPI-1", {
      type: "delivered",
      prNumber: 7,
      mergeSha: "abc123",
      deploy: { ran: false },
    });
    expect(() => redeliverIssue(db, human, "AIPI-1")).toThrowError(
      /no unresolved delivery failure/i,
    );
  });

  it("records a redeliver_requested event without changing issue status", () => {
    addGithubRepo(db, human, { fullName: REPO, projectKey: "AIPI" });
    recordDeliveryEvent(db, human, "AIPI-1", {
      type: "pr_opened",
      prNumber: 7,
      url: `https://github.com/${REPO}/pull/7`,
      headSha: "sha1",
    });
    recordDeliveryEvent(db, human, "AIPI-1", {
      type: "delivery_failed",
      message: "merge conflict",
    });
    const before = getIssue(db, "AIPI-1");
    const updated = redeliverIssue(db, human, "AIPI-1", "sha1");
    expect(updated.status).toBe(before.status);
    const events = listIssueEvents(db, updated.id);
    const requested = events.at(-1)!;
    expect(requested.type).toBe("redeliver_requested");
    expect(requested.actorName).toBe(human.name);
  });
});

describe("redeliverIssue SHA pin (SYD-208)", () => {
  it("refuses without expectedHeadSha", () => {
    addGithubRepo(db, human, { fullName: REPO, projectKey: "AIPI" });
    recordDeliveryEvent(db, human, "AIPI-1", {
      type: "pr_opened",
      prNumber: 7,
      url: `https://github.com/${REPO}/pull/7`,
      headSha: "sha1",
    });
    recordDeliveryEvent(db, human, "AIPI-1", {
      type: "delivery_failed",
      message: "merge conflict",
    });
    expect(() => redeliverIssue(db, human, "AIPI-1")).toThrowError(/expectedHeadSha/);
  });

  it("refuses a moved head, naming old and new SHAs", () => {
    addGithubRepo(db, human, { fullName: REPO, projectKey: "AIPI" });
    recordDeliveryEvent(db, human, "AIPI-1", {
      type: "pr_opened",
      prNumber: 7,
      url: `https://github.com/${REPO}/pull/7`,
      headSha: "old-sha",
      ghUpdatedAt: "2026-07-13T10:00:00Z",
    });
    recordDeliveryEvent(db, human, "AIPI-1", {
      type: "delivery_failed",
      message: "merge conflict",
    });
    // Head moves (a new push) after the human looked at old-sha.
    recordDeliveryEvent(db, human, "AIPI-1", {
      type: "pr_opened",
      prNumber: 7,
      url: `https://github.com/${REPO}/pull/7`,
      headSha: "new-sha",
      ghUpdatedAt: "2026-07-13T11:00:00Z",
    });
    expect(() => redeliverIssue(db, human, "AIPI-1", "old-sha")).toThrowError(/old-sha/);
    expect(() => redeliverIssue(db, human, "AIPI-1", "old-sha")).toThrowError(/new-sha/);
  });

  it("records redeliver_requested with the pin when the SHA matches", () => {
    addGithubRepo(db, human, { fullName: REPO, projectKey: "AIPI" });
    recordDeliveryEvent(db, human, "AIPI-1", {
      type: "pr_opened",
      prNumber: 7,
      url: `https://github.com/${REPO}/pull/7`,
      headSha: "sha1",
    });
    recordDeliveryEvent(db, human, "AIPI-1", {
      type: "delivery_failed",
      message: "merge conflict",
    });
    const updated = redeliverIssue(db, human, "AIPI-1", "sha1");
    const requested = listIssueEvents(db, updated.id).at(-1)!;
    expect(requested.type).toBe("redeliver_requested");
    expect(requested.payload).toEqual({ pin: { repo: REPO, prNumber: 7, headSha: "sha1" } });
  });

  it("pins the merged PR when no open PR exists (deploy-retry authorization)", () => {
    addGithubRepo(db, human, { fullName: REPO, projectKey: "AIPI" });
    recordDeliveryEvent(db, human, "AIPI-1", {
      type: "pr_opened",
      prNumber: 9,
      url: `https://github.com/${REPO}/pull/9`,
      headSha: "sha-merged",
    });
    recordDeliveryEvent(db, human, "AIPI-1", {
      type: "delivered",
      prNumber: 9,
      mergeSha: "mergesha",
      deploy: { ran: false },
    });
    recordDeliveryEvent(db, human, "AIPI-1", {
      type: "delivery_failed",
      message: "deploy script failed",
    });
    const updated = redeliverIssue(db, human, "AIPI-1", "sha-merged");
    const requested = listIssueEvents(db, updated.id).at(-1)!;
    expect(requested.type).toBe("redeliver_requested");
    expect(requested.payload).toEqual({
      pin: { repo: REPO, prNumber: 9, headSha: "sha-merged" },
    });
  });

  it("refuses when the issue has no attributed PR row at all", () => {
    recordDeliveryEvent(db, human, "AIPI-1", {
      type: "delivery_failed",
      message: "merge conflict",
    });
    expect(() => redeliverIssue(db, human, "AIPI-1", "whatever")).toThrowError(
      /no agent PR on record/i,
    );
  });
});

// SYD-178: the fix for SYD-108 merged via a feat/ branch, which pr_state
// never attributes to the issue (strict agent/<ref> match, SYD-206) — Retry
// had nothing to re-authorize, so the delivery_failed flag stayed lit
// forever. resolveDeliveryFailure is the human's explicit escape hatch.
describe("resolveDeliveryFailure", () => {
  it("rejects agents legibly", () => {
    recordDeliveryEvent(db, human, "AIPI-1", {
      type: "delivery_failed",
      message: "merge conflict",
    });
    expect(() => resolveDeliveryFailure(db, agent, "AIPI-1", "merged by hand")).toThrowError(
      /human/i,
    );
  });

  it("rejects an empty or blank note", () => {
    recordDeliveryEvent(db, human, "AIPI-1", {
      type: "delivery_failed",
      message: "merge conflict",
    });
    expect(() => resolveDeliveryFailure(db, human, "AIPI-1", "")).toThrowError(/note is required/i);
    expect(() => resolveDeliveryFailure(db, human, "AIPI-1", "   ")).toThrowError(
      /note is required/i,
    );
  });

  it("rejects an issue with no unresolved delivery failure", () => {
    expect(() => resolveDeliveryFailure(db, human, "AIPI-1", "merged by hand")).toThrowError(
      /no unresolved delivery failure/i,
    );
  });

  it("rejects an issue whose delivery_failed was already resolved", () => {
    recordDeliveryEvent(db, human, "AIPI-1", {
      type: "delivery_failed",
      message: "merge conflict",
    });
    resolveDeliveryFailure(db, human, "AIPI-1", "merged by hand");
    expect(() => resolveDeliveryFailure(db, human, "AIPI-1", "merged by hand")).toThrowError(
      /no unresolved delivery failure/i,
    );
  });

  it("has no agent-PR requirement, unlike redeliver — it works with no pr_state row at all", () => {
    recordDeliveryEvent(db, human, "AIPI-1", {
      type: "delivery_failed",
      message: "rebase onto main hit real conflicts",
    });
    const updated = resolveDeliveryFailure(db, human, "AIPI-1", "merged via feat/AIPI-1 PR #124");
    const events = listIssueEvents(db, updated.id);
    const resolved = events.at(-1)!;
    expect(resolved.type).toBe("delivery_resolved");
    expect(resolved.actorName).toBe(human.name);
    expect(resolved.payload).toEqual({ note: "merged via feat/AIPI-1 PR #124" });
  });

  it("trims the note", () => {
    recordDeliveryEvent(db, human, "AIPI-1", {
      type: "delivery_failed",
      message: "merge conflict",
    });
    const updated = resolveDeliveryFailure(db, human, "AIPI-1", "  merged by hand  ");
    const resolved = listIssueEvents(db, updated.id).at(-1)!;
    expect(resolved.payload).toEqual({ note: "merged by hand" });
  });

  it("does not change issue status", () => {
    recordDeliveryEvent(db, human, "AIPI-1", {
      type: "delivery_failed",
      message: "merge conflict",
    });
    const before = getIssue(db, "AIPI-1");
    const updated = resolveDeliveryFailure(db, human, "AIPI-1", "merged by hand");
    expect(updated.status).toBe(before.status);
  });
});

// SYD-230: re-stamp lets a human re-authorize delivery of an already-done issue
// whose done-stamp never triggered delivery (pin-less done — the open agent PR
// wasn't in pr_state at stamp-time), without a delivery_failure and without the
// done→in_review→done round-trip.
describe("redeliverIssue re-stamp on a done issue (SYD-230)", () => {
  function seedOpenPr(headSha: string) {
    addGithubRepo(db, human, { fullName: REPO, projectKey: "AIPI" });
    recordDeliveryEvent(db, human, "AIPI-1", {
      type: "pr_opened",
      prNumber: 7,
      url: `https://github.com/${REPO}/pull/7`,
      headSha,
    });
  }
  function forceDone() {
    const id = getIssue(db, "AIPI-1").id;
    db.update(issues).set({ status: "done" }).where(eq(issues.id, id)).run();
  }

  it("authorizes delivery for a done issue with an open agent PR and no delivery failure", () => {
    seedOpenPr("sha1");
    forceDone();
    const updated = redeliverIssue(db, human, "AIPI-1", "sha1");
    expect(updated.status).toBe("done");
    const requested = listIssueEvents(db, updated.id).at(-1)!;
    expect(requested.type).toBe("redeliver_requested");
    expect(requested.payload).toEqual({ pin: { repo: REPO, prNumber: 7, headSha: "sha1" } });
  });

  it("still enforces the head-SHA compare-and-set on the re-stamp path", () => {
    seedOpenPr("new-sha");
    forceDone();
    expect(() => redeliverIssue(db, human, "AIPI-1", "old-sha")).toThrowError(/new-sha/);
  });

  it("refuses a non-done issue with an open PR and no delivery failure (re-stamp is done-only)", () => {
    seedOpenPr("sha1");
    // status left at its post-create default (not done)
    expect(() => redeliverIssue(db, human, "AIPI-1", "sha1")).toThrowError(
      /no unresolved delivery failure/i,
    );
  });
});
