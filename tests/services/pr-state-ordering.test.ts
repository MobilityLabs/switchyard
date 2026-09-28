import { describe, expect, it } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue } from "../../src/services/issues.js";
import { addGithubRepo } from "../../src/services/github-repos.js";
import { declarePrLink } from "../../src/services/pr-links.js";
import { listIssueEvents } from "../../src/services/events.js";
import { findPrState, upsertPrState, type PrObservation } from "../../src/services/pr-state.js";
import { getOpenPr } from "../../src/services/pr-status.js";
import { handleGithubWebhook } from "../../src/services/github-webhook.js";

const REPO = "acme/widgets";
const T1 = "2026-07-12T10:00:00Z";
const T2 = "2026-07-12T11:00:00Z";
const T3 = "2026-07-12T12:00:00Z";

function setup() {
  const db = openDb(":memory:");
  const human = createActor(db, { name: "sean", type: "human" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  const issue = createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
  addGithubRepo(db, human, { fullName: REPO, projectKey: "SYD" });
  declarePrLink(db, human, "SYD-1", { repo: REPO, prNumber: 12 });
  const observe = (o: Partial<PrObservation>) =>
    upsertPrState(db, human, {
      repo: REPO,
      prNumber: 12,
      status: "open",
      branch: "feat/widget",
      ghUpdatedAt: T1,
      ...o,
    });
  return { db, issue, observe };
}

describe("PR close/reopen ordering", () => {
  it("returns a diagnostic to ingestion clients when a close lacks freshness evidence", () => {
    const { db, observe } = setup();
    observe({ ghUpdatedAt: T2 });
    const outcome = handleGithubWebhook(
      db,
      "pull_request",
      {
        action: "closed",
        pull_request: { number: 12, merged: false },
      },
      REPO,
    );
    expect(outcome).toMatchObject({
      handled: true,
      duplicate: true,
      reason: expect.stringContaining("close is missing"),
    });
    expect(findPrState(db, REPO, 12)?.status).toBe("open");
  });

  it("preserves the open claim gate after an old close is replayed", () => {
    const { db, issue, observe } = setup();
    observe({ status: "closed" });
    expect(observe({ reopened: true, ghUpdatedAt: T2 }).transition).toBe("reopened");
    expect(observe({ status: "closed" })).toMatchObject({
      applied: false,
      reason: expect.stringContaining("older"),
    });
    expect(findPrState(db, REPO, 12)?.status).toBe("open");
    expect(getOpenPr(db, issue.id)?.prNumber).toBe(12);

    expect(observe({ reopened: true, ghUpdatedAt: T2 }).transition).toBeNull();
    expect(listIssueEvents(db, issue.id).filter((e) => e.type === "gh_pr_reopened")).toHaveLength(
      1,
    );
    expect(observe({ status: "closed", ghUpdatedAt: T3 }).transition).toBe("closed");
    expect(getOpenPr(db, issue.id)).toBeNull();
  });

  it.each([null, "not-a-time"])(
    "rejects a close without valid freshness evidence (%s)",
    (ghUpdatedAt) => {
      const { db, observe } = setup();
      observe({ status: "closed" });
      observe({ reopened: true, ghUpdatedAt: T2 });
      expect(observe({ status: "closed", ghUpdatedAt })).toMatchObject({
        applied: false,
        reason: expect.stringContaining("missing"),
      });
      expect(findPrState(db, REPO, 12)?.status).toBe("open");
    },
  );

  it("accepts final merge evidence even if it arrives behind a fresher open observation", () => {
    const { db, observe } = setup();
    observe({ status: "closed" });
    observe({ reopened: true, ghUpdatedAt: T2 });
    observe({ ghUpdatedAt: T3 });
    expect(observe({ status: "merged", ghUpdatedAt: T1 }).transition).toBe("merged");
    expect(findPrState(db, REPO, 12)).toMatchObject({
      status: "merged",
      ghUpdatedAt: Date.parse(T3) / 1000,
    });
    expect(observe({ reopened: true, ghUpdatedAt: "2026-07-13T00:00:00Z" })).toMatchObject({
      applied: false,
      reason: "merged is final",
    });
  });

  it("accepts a close at the current timestamp and a close on an untimestamped open row", () => {
    const { observe } = setup();
    observe({ ghUpdatedAt: null });
    expect(observe({ status: "closed" }).transition).toBe("closed");
    observe({ reopened: true, ghUpdatedAt: T2 });
    expect(observe({ status: "closed", ghUpdatedAt: T2 }).transition).toBe("closed");
  });
});
