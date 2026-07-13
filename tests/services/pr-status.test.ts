import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, getIssue } from "../../src/services/issues.js";
import { recordDeliveryEvent } from "../../src/services/delivery-events.js";
import { recordEvent } from "../../src/services/events.js";
import { getOpenPr, listOpenPrByIssueId, getMergedPrEvent } from "../../src/services/pr-status.js";

function setup() {
  const db = openDb(":memory:");
  const human = createActor(db, { name: "sean", type: "human" }).actor;
  const agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
  return { db, human, agent };
}

describe("getOpenPr", () => {
  it("returns null for an issue with no PR events", () => {
    const { db } = setup();
    expect(getOpenPr(db, getIssue(db, "SYD-1").id)).toBeNull();
  });

  it("flags an issue whose latest event is pr_opened", () => {
    const { db, human, agent } = setup();
    const issue = getIssue(db, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
    expect(getOpenPr(db, issue.id)).toEqual({
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
  });

  it("flags an issue whose latest event is gh_pr_opened (webhook path)", () => {
    const { db, human, agent } = setup();
    const issue = getIssue(db, "SYD-1");
    recordEvent(db, {
      issueId: issue.id,
      actorId: agent.id,
      type: "gh_pr_opened",
      payload: {
        prNumber: 41,
        url: "https://github.com/acme/widgets/pull/41",
        branch: "agent/SYD-1",
      },
    });
    expect(getOpenPr(db, issue.id)).toEqual({
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
  });

  it("flags an issue open again after gh_pr_reopened follows a close (SYD-205)", () => {
    const { db, agent } = setup();
    const issue = getIssue(db, "SYD-1");
    const pr = { prNumber: 41, url: "https://github.com/acme/widgets/pull/41" };
    recordEvent(db, {
      issueId: issue.id,
      actorId: agent.id,
      type: "gh_pr_opened",
      payload: { ...pr, branch: "agent/SYD-1" },
    });
    recordEvent(db, { issueId: issue.id, actorId: agent.id, type: "gh_pr_closed", payload: pr });
    expect(getOpenPr(db, issue.id)).toBeNull();
    recordEvent(db, {
      issueId: issue.id,
      actorId: agent.id,
      type: "gh_pr_reopened",
      payload: { ...pr, branch: "agent/SYD-1" },
    });
    expect(getOpenPr(db, issue.id)).toEqual(pr);
  });

  it("clears once delivered", () => {
    const { db, human, agent } = setup();
    const issue = getIssue(db, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://x/41",
    });
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "delivered",
      prNumber: 41,
      mergeSha: "abc123",
      deploy: { ran: false },
    });
    expect(getOpenPr(db, issue.id)).toBeNull();
  });

  it("clears once gh_pr_merged or gh_pr_closed fires", () => {
    const { db, human, agent } = setup();
    const issue = getIssue(db, "SYD-1");
    recordEvent(db, {
      issueId: issue.id,
      actorId: agent.id,
      type: "gh_pr_opened",
      payload: { prNumber: 41, url: "https://x/41" },
    });
    recordEvent(db, {
      issueId: issue.id,
      actorId: agent.id,
      type: "gh_pr_closed",
      payload: { prNumber: 41, url: "https://x/41" },
    });
    expect(getOpenPr(db, issue.id)).toBeNull();
  });

  it("doesn't let a belated close for an old PR report a newer still-open PR as closed (SYD-125)", () => {
    const { db, human, agent } = setup();
    const issue = getIssue(db, "SYD-1");
    recordEvent(db, {
      issueId: issue.id,
      actorId: agent.id,
      type: "gh_pr_opened",
      payload: { prNumber: 1, url: "https://x/1" },
    });
    recordEvent(db, {
      issueId: issue.id,
      actorId: agent.id,
      type: "gh_pr_opened",
      payload: { prNumber: 2, url: "https://x/2" },
    });
    // A belated close for PR#1 arrives after PR#2 already opened.
    recordEvent(db, {
      issueId: issue.id,
      actorId: agent.id,
      type: "gh_pr_closed",
      payload: { prNumber: 1, url: "https://x/1" },
    });
    expect(getOpenPr(db, issue.id)).toEqual({ prNumber: 2, url: "https://x/2" });
  });

  it("re-flags if a new PR opens after the previous one closed", () => {
    const { db, human, agent } = setup();
    const issue = getIssue(db, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://x/41",
    });
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "delivered",
      prNumber: 41,
      mergeSha: "abc123",
      deploy: { ran: false },
    });
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 55,
      url: "https://x/55",
    });
    expect(getOpenPr(db, issue.id)).toEqual({ prNumber: 55, url: "https://x/55" });
  });
});

describe("listOpenPrByIssueId", () => {
  it("only includes issues with an unresolved open PR", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Also shipping" }); // SYD-2
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://x/41",
    });

    const open = getIssue(db, "SYD-1");
    const clean = getIssue(db, "SYD-2");
    const flags = listOpenPrByIssueId(db);
    expect(flags.get(open.id)).toEqual({ prNumber: 41, url: "https://x/41" });
    expect(flags.has(clean.id)).toBe(false);
  });
});

describe("getMergedPrEvent", () => {
  it("returns null when the issue has no merge event", () => {
    const { db } = setup();
    expect(getMergedPrEvent(db, getIssue(db, "SYD-1").id)).toBeNull();
  });

  it("returns the prNumber + event id of a delivered event", () => {
    const { db, human } = setup();
    const issue = getIssue(db, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "delivered",
      prNumber: 41,
      mergeSha: "abc123",
      deploy: { ran: false },
    });
    const merged = getMergedPrEvent(db, issue.id);
    expect(merged?.prNumber).toBe(41);
    expect(merged?.eventId).toBeGreaterThan(0);
  });

  it("returns the prNumber of a gh_pr_merged event (webhook path)", () => {
    const { db, agent } = setup();
    const issue = getIssue(db, "SYD-1");
    recordEvent(db, {
      issueId: issue.id,
      actorId: agent.id,
      type: "gh_pr_merged",
      payload: { prNumber: 41, url: "https://github.com/acme/widgets/pull/41", mergeSha: "abc" },
    });
    expect(getMergedPrEvent(db, issue.id)?.prNumber).toBe(41);
  });

  it("returns the most recent merge event when several exist", () => {
    const { db, human } = setup();
    const issue = getIssue(db, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", { type: "delivered", prNumber: 41, mergeSha: "a", deploy: { ran: false } });
    recordDeliveryEvent(db, human, "SYD-1", { type: "delivered", prNumber: 42, mergeSha: "b", deploy: { ran: false } });
    expect(getMergedPrEvent(db, issue.id)?.prNumber).toBe(42);
  });

  it("returns the most recent merge event across delivered and gh_pr_merged types", () => {
    const { db, human, agent } = setup();
    const issue = getIssue(db, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", { type: "delivered", prNumber: 41, mergeSha: "a", deploy: { ran: false } });
    recordEvent(db, {
      issueId: issue.id,
      actorId: agent.id,
      type: "gh_pr_merged",
      payload: { prNumber: 42, url: "https://github.com/acme/widgets/pull/42", mergeSha: "b" },
    });
    expect(getMergedPrEvent(db, issue.id)?.prNumber).toBe(42);
  });
});
