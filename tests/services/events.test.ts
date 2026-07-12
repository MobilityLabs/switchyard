import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { openDb } from "../../src/db/index.js";
import { events } from "../../src/db/schema.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue } from "../../src/services/issues.js";
import { addComment } from "../../src/services/comments.js";
import {
  listRecentEvents,
  listRecentEventsPage,
  listUnansweredQuestions,
  recordEvent,
  DEFAULT_RECENT_EVENTS_LIMIT,
  MAX_RECENT_EVENTS_LIMIT,
} from "../../src/services/events.js";

describe("listRecentEvents", () => {
  it("returns events newest-first, joined with issue ref, title, project key, and actor name", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    createProject(db, human, { key: "SYD", name: "Switchyard" });
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
    createProject(db, human, { key: "SYD", name: "Switchyard" });
    createIssue(db, human, { projectKey: "SYD", title: "Old one" });
    updateIssue(db, human, "SYD-1", { status: "todo" });

    const all = listRecentEvents(db);
    expect(all).toHaveLength(2);
    const cutoff = all[0].createdAt; // timestamp of the newest (status change) event

    // Backdate the older "created" event so since-filtering has something to exclude.
    db.update(events)
      .set({ createdAt: cutoff - 100 })
      .where(eq(events.id, all[1].id))
      .run();

    const recent = listRecentEvents(db, { since: cutoff - 50 });
    expect(recent).toHaveLength(1);
    expect(recent[0].type).not.toBe("created");
  });

  it("defaults the limit to 200 and caps it at 500", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    createProject(db, human, { key: "SYD", name: "Switchyard" });
    createIssue(db, human, { projectKey: "SYD", title: "Only issue" });

    expect(listRecentEvents(db, {}).length).toBeLessThanOrEqual(DEFAULT_RECENT_EVENTS_LIMIT);
    expect(listRecentEvents(db, { limit: 10000 }).length).toBeLessThanOrEqual(
      MAX_RECENT_EVENTS_LIMIT,
    );

    // A small explicit limit is honored.
    updateIssue(db, human, "SYD-1", { status: "todo" });
    updateIssue(db, human, "SYD-1", { status: "in_progress" });
    expect(listRecentEvents(db, { limit: 1 })).toHaveLength(1);
  });
});

describe("listRecentEventsPage", () => {
  function setupManyEvents(count: number) {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    createProject(db, human, { key: "SYD", name: "Switchyard" });
    const issue = createIssue(db, human, { projectKey: "SYD", title: "Busy issue" }); // 1 "created" event
    for (let i = 0; i < count - 1; i++) {
      recordEvent(db, { issueId: issue.id, actorId: human.id, type: "comment", payload: {} });
    }
    return { db, human };
  }

  it("is not truncated and has no nextCursor when everything fits in one page (SYD-89)", () => {
    const { db } = setupManyEvents(3);
    const page = listRecentEventsPage(db, { limit: 10 });
    expect(page.events).toHaveLength(3);
    expect(page.truncated).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("flags truncation and exposes a cursor to fetch the next-older page (SYD-89)", () => {
    const { db } = setupManyEvents(5);
    const page = listRecentEventsPage(db, { limit: 2 });
    expect(page.events).toHaveLength(2);
    expect(page.truncated).toBe(true);
    expect(page.nextCursor).toBe(page.events[page.events.length - 1].id);
  });

  it("pages through the full window via beforeId until truncated is false, covering every event exactly once (SYD-89)", () => {
    const { db } = setupManyEvents(1203); // > MAX_RECENT_EVENTS_LIMIT, forces multiple pages
    const seen: number[] = [];
    let cursor: number | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = listRecentEventsPage(db, { limit: 500, beforeId: cursor });
      seen.push(...page.events.map((e) => e.id));
      if (!page.truncated) break;
      cursor = page.nextCursor!;
    }
    expect(seen).toHaveLength(1203);
    expect(new Set(seen).size).toBe(1203); // no duplicates or gaps across page boundaries
  });

  it("honors since across pages, never paging past the window's oldest event", () => {
    const { db, human } = setupManyEvents(3);
    const all = listRecentEvents(db);
    const cutoff = all[all.length - 1].createdAt; // "created" event's timestamp

    updateIssue(db, human, "SYD-1", { status: "todo" }); // newer event, after cutoff
    const page = listRecentEventsPage(db, { since: cutoff, limit: 10 });
    expect(page.events.every((e) => e.createdAt > cutoff)).toBe(true);
    expect(page.truncated).toBe(false);
  });
});

describe("listUnansweredQuestions", () => {
  function setup() {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    const agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
    createProject(db, human, { key: "SYD", name: "Switchyard" });
    return { db, human, agent };
  }

  it("returns an issue whose @agent question has no later agent comment", () => {
    const { db, human } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    addComment(db, human, "SYD-1", "@agent what's blocking this?");

    expect(listUnansweredQuestions(db).map((q) => q.ref)).toEqual(["SYD-1"]);
  });

  it("drops an issue once an agent actor comments after the question", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    addComment(db, human, "SYD-1", "@agent what's blocking this?");
    addComment(db, agent, "SYD-1", "Nothing — it's ready for review.");

    expect(listUnansweredQuestions(db)).toEqual([]);
  });

  it("still an unanswered question if a human replies but no agent answers", () => {
    const { db, human } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    addComment(db, human, "SYD-1", "@agent what's blocking this?");
    addComment(db, human, "SYD-1", "bump");

    expect(listUnansweredQuestions(db).map((q) => q.ref)).toEqual(["SYD-1"]);
  });

  it("coalesces two unanswered questions on the same issue into a single result", () => {
    const { db, human } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    addComment(db, human, "SYD-1", "@agent first question?");
    addComment(db, human, "SYD-1", "@agent second question?");

    expect(listUnansweredQuestions(db).map((q) => q.ref)).toEqual(["SYD-1"]);
  });

  it("becomes unanswered again if a second question follows an answered one", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    addComment(db, human, "SYD-1", "@agent first question?");
    addComment(db, agent, "SYD-1", "Answered the first one.");
    addComment(db, human, "SYD-1", "@agent a follow-up question?");

    expect(listUnansweredQuestions(db).map((q) => q.ref)).toEqual(["SYD-1"]);
  });

  it("ignores issues with no agent_question events", () => {
    const { db, human } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    addComment(db, human, "SYD-1", "just a regular comment");

    expect(listUnansweredQuestions(db)).toEqual([]);
  });
});
