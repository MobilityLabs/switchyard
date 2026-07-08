import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type Db } from "../../src/db/index.js";
import { issues } from "../../src/db/schema.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, getIssue } from "../../src/services/issues.js";
import { listIssueEvents } from "../../src/services/events.js";
import { searchIssues } from "../../src/services/search.js";
import { snoozeIssue, markDuplicate } from "../../src/services/triage-actions.js";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, { key: "AIPI", name: "aipi" });
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

    expect(searchIssues(db, { excludeSnoozed: true }).map((i) => i.ref).sort()).toEqual(["AIPI-2"]);
    expect(searchIssues(db, {}).map((i) => i.ref).sort()).toEqual(["AIPI-1", "AIPI-2"]);

    // simulate the passage of time by pushing snoozedUntil into the past directly (test setup only —
    // the service itself only accepts future timestamps)
    const past = Math.floor(Date.now() / 1000) - 10;
    db.update(issues).set({ snoozedUntil: past }).where(eq(issues.id, snoozed.id)).run();

    expect(searchIssues(db, { excludeSnoozed: true }).map((i) => i.ref).sort()).toEqual(["AIPI-1", "AIPI-2"]);
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
