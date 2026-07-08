import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { openDb } from "../../src/db/index.js";
import { events } from "../../src/db/schema.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue } from "../../src/services/issues.js";
import {
  listRecentEvents,
  DEFAULT_RECENT_EVENTS_LIMIT,
  MAX_RECENT_EVENTS_LIMIT,
} from "../../src/services/events.js";

describe("listRecentEvents", () => {
  it("returns events newest-first, joined with issue ref, title, project key, and actor name", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    createProject(db, { key: "SYD", name: "Switchyard" });
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" }); // 1 event: created
    updateIssue(db, human, "SYD-1", { status: "todo" }); // 1 event: status change

    const rows = listRecentEvents(db);
    expect(rows).toHaveLength(2);
    // newest-first: the status update comes back before the creation
    expect(rows[0].type).not.toBe("created");
    expect(rows[1].type).toBe("created");
    expect(rows[1]).toMatchObject({
      issue: "SYD-1",
      issueTitle: "Ship it",
      projectKey: "SYD",
      actorName: "sean",
    });
    expect(typeof rows[1].createdAt).toBe("number");
  });

  it("filters by since (strictly after the given unix timestamp)", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    createProject(db, { key: "SYD", name: "Switchyard" });
    createIssue(db, human, { projectKey: "SYD", title: "Old one" });
    updateIssue(db, human, "SYD-1", { status: "todo" });

    const all = listRecentEvents(db);
    expect(all).toHaveLength(2);
    const cutoff = all[0].createdAt; // timestamp of the newest (status change) event

    // Backdate the older "created" event so since-filtering has something to exclude.
    db.update(events).set({ createdAt: cutoff - 100 }).where(eq(events.id, all[1].id)).run();

    const recent = listRecentEvents(db, { since: cutoff - 50 });
    expect(recent).toHaveLength(1);
    expect(recent[0].type).not.toBe("created");
  });

  it("defaults the limit to 200 and caps it at 500", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    createProject(db, { key: "SYD", name: "Switchyard" });
    createIssue(db, human, { projectKey: "SYD", title: "Only issue" });

    expect(listRecentEvents(db, {}).length).toBeLessThanOrEqual(DEFAULT_RECENT_EVENTS_LIMIT);
    expect(listRecentEvents(db, { limit: 10000 }).length).toBeLessThanOrEqual(MAX_RECENT_EVENTS_LIMIT);

    // A small explicit limit is honored.
    updateIssue(db, human, "SYD-1", { status: "todo" });
    updateIssue(db, human, "SYD-1", { status: "in_progress" });
    expect(listRecentEvents(db, { limit: 1 })).toHaveLength(1);
  });
});
