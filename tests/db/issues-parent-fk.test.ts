import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue } from "../../src/services/issues.js";
import { issues } from "../../src/db/schema.js";

describe("issues.parent_id foreign key", () => {
  it("rejects a parentId pointing at a nonexistent issue", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    createProject(db, { key: "AIPI", name: "aipi" });
    createIssue(db, human, { projectKey: "AIPI", title: "Ship v1" });

    expect(() =>
      db
        .insert(issues)
        .values({
          projectId: 1,
          number: 999,
          title: "dangling child",
          status: "backlog",
          creatorId: human.id,
          parentId: 9999,
        })
        .run(),
    ).toThrowError(/FOREIGN KEY constraint failed/i);
  });

  it("still allows a parentId pointing at a real issue", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    createProject(db, { key: "AIPI", name: "aipi" });
    const parent = createIssue(db, human, { projectKey: "AIPI", title: "Parent" });
    const child = createIssue(db, human, {
      projectKey: "AIPI",
      title: "Child",
      parentRef: parent.ref,
    });
    expect(child.parentId).toBe(parent.id);
  });
});
