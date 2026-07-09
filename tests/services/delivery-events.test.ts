import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue } from "../../src/services/issues.js";
import { getActivity } from "../../src/services/comments.js";
import { recordDeliveryEvent } from "../../src/services/delivery-events.js";

describe("recordDeliveryEvent", () => {
  it("appends pr_opened, delivered, and delivery_failed events to the activity feed", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    const worker = createActor(db, { name: "claude/worker", type: "agent" }).actor;
    createProject(db, { key: "SYD", name: "Switchyard" });
    createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });

    recordDeliveryEvent(db, worker, "SYD-1", {
      type: "pr_opened", prNumber: 12, url: "https://github.com/acme/widgets/pull/12",
    });
    recordDeliveryEvent(db, worker, "SYD-1", {
      type: "delivered", prNumber: 12, mergeSha: "abc123", deploy: { ran: true, ok: true, tail: "done" },
    });

    const activity = getActivity(db, "SYD-1");
    expect(activity.map((a) => a.type)).toEqual(["created", "pr_opened", "delivered"]);
    expect(activity[1].payload).toEqual({ prNumber: 12, url: "https://github.com/acme/widgets/pull/12" });
    expect(activity[1].actorName).toBe("claude/worker");
    expect(activity[2].payload).toEqual({
      prNumber: 12, mergeSha: "abc123", deploy: { ran: true, ok: true, tail: "done" },
    });
  });

  it("records delivery_failed with just a message", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    const worker = createActor(db, { name: "claude/worker", type: "agent" }).actor;
    createProject(db, { key: "SYD", name: "Switchyard" });
    createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });

    recordDeliveryEvent(db, worker, "SYD-1", { type: "delivery_failed", message: "merge conflict" });

    const activity = getActivity(db, "SYD-1");
    expect(activity[1]).toMatchObject({ type: "delivery_failed", payload: { message: "merge conflict" } });
  });

  it("throws for an unknown issue ref", () => {
    const db = openDb(":memory:");
    const worker = createActor(db, { name: "claude/worker", type: "agent" }).actor;
    createProject(db, { key: "SYD", name: "Switchyard" });
    expect(() =>
      recordDeliveryEvent(db, worker, "SYD-9", { type: "delivery_failed", message: "boom" })
    ).toThrowError(/does not exist/);
  });
});
