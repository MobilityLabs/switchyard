import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, getIssue } from "../../src/services/issues.js";
import { recordDeliveryEvent } from "../../src/services/delivery-events.js";
import { getAttention, listAttentionByIssueId } from "../../src/services/attention.js";

function setup() {
  const db = openDb(":memory:");
  const human = createActor(db, { name: "sean", type: "human" }).actor;
  const agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
  return { db, human, agent };
}

describe("getAttention", () => {
  it("returns null for an issue with no delivery events", () => {
    const { db } = setup();
    const issue = getIssue(db, "SYD-1");
    expect(getAttention(db, issue.id)).toBeNull();
  });

  it("flags an issue whose latest delivery event is delivery_failed", () => {
    const { db, human, agent } = setup();
    const issue = getIssue(db, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", { type: "delivery_failed", message: "merge conflict" });
    expect(getAttention(db, issue.id)).toEqual({
      reason: "delivery_failed",
      message: "merge conflict",
    });
  });

  it("clears the flag once a later delivered event fires", () => {
    const { db, human, agent } = setup();
    const issue = getIssue(db, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", { type: "delivery_failed", message: "merge conflict" });
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "delivered",
      prNumber: 7,
      mergeSha: "abc123",
      deploy: { ran: false },
    });
    expect(getAttention(db, issue.id)).toBeNull();
  });

  it("re-flags if delivery fails again after a successful delivery", () => {
    const { db, human, agent } = setup();
    const issue = getIssue(db, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "delivered",
      prNumber: 7,
      mergeSha: "abc123",
      deploy: { ran: false },
    });
    recordDeliveryEvent(db, human, "SYD-1", { type: "delivery_failed", message: "deploy broke" });
    expect(getAttention(db, issue.id)).toEqual({
      reason: "delivery_failed",
      message: "deploy broke",
    });
  });
});

describe("listAttentionByIssueId", () => {
  it("only includes issues with an unresolved delivery_failed", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Also shipping" }); // SYD-2
    recordDeliveryEvent(db, human, "SYD-1", { type: "delivery_failed", message: "merge conflict" });

    const failing = getIssue(db, "SYD-1");
    const clean = getIssue(db, "SYD-2");
    const flags = listAttentionByIssueId(db);
    expect(flags.get(failing.id)).toEqual({ reason: "delivery_failed", message: "merge conflict" });
    expect(flags.has(clean.id)).toBe(false);
  });

  it("clears once delivered, for the bulk query too", () => {
    const { db, human, agent } = setup();
    recordDeliveryEvent(db, human, "SYD-1", { type: "delivery_failed", message: "merge conflict" });
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "delivered",
      prNumber: 7,
      mergeSha: "abc123",
      deploy: { ran: false },
    });
    expect(listAttentionByIssueId(db).size).toBe(0);
  });
});
