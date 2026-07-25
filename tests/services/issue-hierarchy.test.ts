import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import {
  createIssue,
  updateIssue,
  getIssue,
  listChildren,
  childCountsByParent,
} from "../../src/services/issues.js";
import { listIssueEvents } from "../../src/services/events.js";

let db: Db, human: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  createProject(db, human, { key: "SYD", name: "switchyard" });
  createIssue(db, human, { projectKey: "SYD", title: "Epic" }); // SYD-1
});

describe("parent/child hierarchy", () => {
  it("createIssue with parentRef nests the child, and listChildren gathers them ordered", () => {
    createIssue(db, human, { projectKey: "SYD", title: "Story A", parentRef: "SYD-1" }); // SYD-2
    createIssue(db, human, { projectKey: "SYD", title: "Story B", parentRef: "SYD-1" }); // SYD-3
    createIssue(db, human, { projectKey: "SYD", title: "Unrelated" }); // SYD-4

    const kids = listChildren(db, "SYD-1");
    expect(kids.map((k) => k.ref)).toEqual(["SYD-2", "SYD-3"]);
    expect(kids[0].title).toBe("Story A");
    expect(listChildren(db, "SYD-4")).toEqual([]);
  });

  it("childCountsByParent maps a parent id to its child count", () => {
    createIssue(db, human, { projectKey: "SYD", title: "Story A", parentRef: "SYD-1" });
    createIssue(db, human, { projectKey: "SYD", title: "Story B", parentRef: "SYD-1" });
    const parent = getIssue(db, "SYD-1");
    const counts = childCountsByParent(db);
    expect(counts.get(parent.id)).toBe(2);
  });

  it("updateIssue re-parents an existing issue and records a parent_changed event", () => {
    createIssue(db, human, { projectKey: "SYD", title: "Story", parentRef: undefined }); // SYD-2
    const child = getIssue(db, "SYD-2");
    expect(child.parentId).toBeNull();

    updateIssue(db, human, "SYD-2", { parentRef: "SYD-1" });
    const parent = getIssue(db, "SYD-1");
    expect(getIssue(db, "SYD-2").parentId).toBe(parent.id);
    expect(listIssueEvents(db, child.id).some((e) => e.type === "parent_changed")).toBe(true);

    // Clearing with null detaches it.
    updateIssue(db, human, "SYD-2", { parentRef: null });
    expect(getIssue(db, "SYD-2").parentId).toBeNull();
  });

  it("refuses to make an issue its own parent", () => {
    expect(() => updateIssue(db, human, "SYD-1", { parentRef: "SYD-1" })).toThrow(/own parent/i);
  });
});
