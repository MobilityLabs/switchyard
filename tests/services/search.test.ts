import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue } from "../../src/services/issues.js";
import { searchIssues } from "../../src/services/search.js";

let db: Db, human: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  createProject(db, { key: "AIPI", name: "aipi" });
  createProject(db, { key: "HAND", name: "housing" });
  createIssue(db, human, { projectKey: "AIPI", title: "Fix flaky API test", labels: ["testing"] });
  createIssue(db, human, { projectKey: "AIPI", title: "Write docs" });
  createIssue(db, human, { projectKey: "HAND", title: "Map layer bug" });
  updateIssue(db, human, "AIPI-1", { status: "todo", assigneeName: "sean" });
});

describe("searchIssues", () => {
  it("filters by project, status, assignee, label, and text — ANDed", () => {
    expect(searchIssues(db, { projectKey: "AIPI" })).toHaveLength(2);
    expect(searchIssues(db, { status: "todo" }).map((i) => i.ref)).toEqual(["AIPI-1"]);
    expect(searchIssues(db, { assigneeName: "sean" }).map((i) => i.ref)).toEqual(["AIPI-1"]);
    expect(searchIssues(db, { label: "testing" }).map((i) => i.ref)).toEqual(["AIPI-1"]);
    expect(searchIssues(db, { text: "FLAKY" }).map((i) => i.ref)).toEqual(["AIPI-1"]);
    expect(searchIssues(db, { projectKey: "HAND", status: "todo" })).toHaveLength(0);
  });

  it("returns everything with no filters, newest first", () => {
    const all = searchIssues(db, {});
    expect(all).toHaveLength(3);
    expect(all[0].ref).toBe("HAND-1");
  });
});
