import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type Db } from "../../src/db/index.js";
import { events } from "../../src/db/schema.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue, getIssue } from "../../src/services/issues.js";
import { recordDeliveryEvent } from "../../src/services/delivery-events.js";
import { recordEvent } from "../../src/services/events.js";
import { requestHumanInput } from "../../src/services/needs-input.js";
import { getDeviation, listDeviationByIssueId } from "../../src/services/deviation.js";

function setup() {
  const db = openDb(":memory:");
  const human = createActor(db, { name: "sean", type: "human" }).actor;
  const agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  return { db, human, agent };
}

function ageAllEvents(db: Db, issueId: number, secondsAgo: number) {
  const old = Math.floor(Date.now() / 1000) - secondsAgo;
  db.update(events).set({ createdAt: old }).where(eq(events.issueId, issueId)).run();
}

describe("getDeviation — open_pr_not_in_review", () => {
  it("flags an in_progress issue with an open PR", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1"); // -> in_progress
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
    const flag = getDeviation(db, getIssue(db, "SYD-1").id);
    expect(flag?.reason).toBe("open_pr_not_in_review");
    expect(flag?.message).toContain("#41");
  });

  it("flags a todo issue with an open PR", () => {
    const { db, human } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 7,
      url: "https://github.com/acme/widgets/pull/7",
    });
    expect(getDeviation(db, getIssue(db, "SYD-1").id)?.reason).toBe("open_pr_not_in_review");
  });

  it("does NOT flag an in_review issue with an open PR (correct state)", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
    updateIssue(db, human, "SYD-1", { status: "in_review" });
    expect(getDeviation(db, getIssue(db, "SYD-1").id)).toBeNull();
  });

  it("prefers open_pr_not_in_review over stale_claim when both apply", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1"); // -> in_progress
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
    ageAllEvents(db, getIssue(db, "SYD-1").id, 2 * 3600); // idle past the 1h threshold too
    expect(getDeviation(db, getIssue(db, "SYD-1").id)?.reason).toBe("open_pr_not_in_review");
  });
});

describe("getDeviation — merged_pr_not_done", () => {
  it("flags an in_review issue whose PR is merged", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
    updateIssue(db, human, "SYD-1", { status: "in_review" });
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "delivered",
      prNumber: 41,
      mergeSha: "abc",
      deploy: { ran: false },
    });
    const flag = getDeviation(db, getIssue(db, "SYD-1").id);
    expect(flag?.reason).toBe("merged_pr_not_done");
    expect(flag?.message).toContain("#41");
  });

  it("does NOT flag a done issue with a merged PR", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    updateIssue(db, human, "SYD-1", { status: "in_review" });
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "delivered",
      prNumber: 41,
      mergeSha: "abc",
      deploy: { ran: false },
    });
    updateIssue(db, human, "SYD-1", { status: "done" });
    expect(getDeviation(db, getIssue(db, "SYD-1").id)).toBeNull();
  });
});

describe("getDeviation — stale_claim", () => {
  it("flags an in_progress issue idle past claims.deviation_seconds", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    ageAllEvents(db, getIssue(db, "SYD-1").id, 2 * 3600); // 2h > 1h default
    expect(getDeviation(db, getIssue(db, "SYD-1").id)?.reason).toBe("stale_claim");
  });

  it("does NOT flag a fresh in_progress claim", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    expect(getDeviation(db, getIssue(db, "SYD-1").id)).toBeNull();
  });

  it("does NOT flag an idle claim that is waiting on human input", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    requestHumanInput(db, agent, "SYD-1", "which db?");
    ageAllEvents(db, getIssue(db, "SYD-1").id, 2 * 3600);
    expect(getDeviation(db, getIssue(db, "SYD-1").id)).toBeNull();
  });

  it("does NOT flag a stale issue that is not in_progress", () => {
    const { db, human } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    ageAllEvents(db, getIssue(db, "SYD-1").id, 5 * 3600);
    expect(getDeviation(db, getIssue(db, "SYD-1").id)).toBeNull();
  });
});

describe("listDeviationByIssueId", () => {
  it("returns one flag per drifting issue and omits clean ones", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Has PR" }); // SYD-1
    createIssue(db, human, { projectKey: "SYD", title: "Clean" }); // SYD-2
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
    const map = listDeviationByIssueId(db);
    expect(map.get(getIssue(db, "SYD-1").id)?.reason).toBe("open_pr_not_in_review");
    expect(map.has(getIssue(db, "SYD-2").id)).toBe(false);
  });
});
