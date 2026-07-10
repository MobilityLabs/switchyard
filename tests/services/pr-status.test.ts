import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, getIssue } from "../../src/services/issues.js";
import { recordDeliveryEvent } from "../../src/services/delivery-events.js";
import { recordEvent } from "../../src/services/events.js";
import { getOpenPr, listOpenPrByIssueId } from "../../src/services/pr-status.js";

function setup() {
  const db = openDb(":memory:");
  const human = createActor(db, { name: "sean", type: "human" }).actor;
  const agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, { key: "SYD", name: "Switchyard" });
  createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
  return { db, human, agent };
}

describe("getOpenPr", () => {
  it("returns null for an issue with no PR events", () => {
    const { db } = setup();
    expect(getOpenPr(db, getIssue(db, "SYD-1").id)).toBeNull();
  });

  it("flags an issue whose latest event is pr_opened", () => {
    const { db, agent } = setup();
    const issue = getIssue(db, "SYD-1");
    recordDeliveryEvent(db, agent, "SYD-1", {
      type: "pr_opened", prNumber: 41, url: "https://github.com/acme/widgets/pull/41",
    });
    expect(getOpenPr(db, issue.id)).toEqual({ prNumber: 41, url: "https://github.com/acme/widgets/pull/41" });
  });

  it("flags an issue whose latest event is gh_pr_opened (webhook path)", () => {
    const { db, agent } = setup();
    const issue = getIssue(db, "SYD-1");
    recordEvent(db, {
      issueId: issue.id, actorId: agent.id, type: "gh_pr_opened",
      payload: { prNumber: 41, url: "https://github.com/acme/widgets/pull/41", branch: "agent/SYD-1" },
    });
    expect(getOpenPr(db, issue.id)).toEqual({ prNumber: 41, url: "https://github.com/acme/widgets/pull/41" });
  });

  it("clears once delivered", () => {
    const { db, human, agent } = setup();
    const issue = getIssue(db, "SYD-1");
    recordDeliveryEvent(db, agent, "SYD-1", { type: "pr_opened", prNumber: 41, url: "https://x/41" });
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "delivered", prNumber: 41, mergeSha: "abc123", deploy: { ran: false },
    });
    expect(getOpenPr(db, issue.id)).toBeNull();
  });

  it("clears once gh_pr_merged or gh_pr_closed fires", () => {
    const { db, agent } = setup();
    const issue = getIssue(db, "SYD-1");
    recordEvent(db, { issueId: issue.id, actorId: agent.id, type: "gh_pr_opened", payload: { prNumber: 41, url: "https://x/41" } });
    recordEvent(db, { issueId: issue.id, actorId: agent.id, type: "gh_pr_closed", payload: { prNumber: 41, url: "https://x/41" } });
    expect(getOpenPr(db, issue.id)).toBeNull();
  });

  it("re-flags if a new PR opens after the previous one closed", () => {
    const { db, human, agent } = setup();
    const issue = getIssue(db, "SYD-1");
    recordDeliveryEvent(db, agent, "SYD-1", { type: "pr_opened", prNumber: 41, url: "https://x/41" });
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "delivered", prNumber: 41, mergeSha: "abc123", deploy: { ran: false },
    });
    recordDeliveryEvent(db, agent, "SYD-1", { type: "pr_opened", prNumber: 55, url: "https://x/55" });
    expect(getOpenPr(db, issue.id)).toEqual({ prNumber: 55, url: "https://x/55" });
  });
});

describe("listOpenPrByIssueId", () => {
  it("only includes issues with an unresolved open PR", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Also shipping" }); // SYD-2
    recordDeliveryEvent(db, agent, "SYD-1", { type: "pr_opened", prNumber: 41, url: "https://x/41" });

    const open = getIssue(db, "SYD-1");
    const clean = getIssue(db, "SYD-2");
    const flags = listOpenPrByIssueId(db);
    expect(flags.get(open.id)).toEqual({ prNumber: 41, url: "https://x/41" });
    expect(flags.has(clean.id)).toBe(false);
  });
});
