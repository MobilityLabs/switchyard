import { describe, expect, it } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { boardColumnCounts } from "../../src/services/board-column-counts.js";
import { createIssue, updateIssue } from "../../src/services/issues.js";
import { createProject } from "../../src/services/projects.js";

describe("boardColumnCounts", () => {
  it("counts each project and status and reflects a moved issue", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    createProject(db, human, { key: "SYD", name: "Switchyard" });
    createProject(db, human, { key: "AIPI", name: "AIPI" });
    const first = createIssue(db, human, { projectKey: "SYD", title: "First" });
    createIssue(db, human, { projectKey: "SYD", title: "Second" });
    createIssue(db, human, { projectKey: "AIPI", title: "Other" });

    expect(boardColumnCounts(db)).toEqual({
      SYD: { backlog: 2 },
      AIPI: { backlog: 1 },
    });

    updateIssue(db, human, first.ref, { status: "in_review" });
    expect(boardColumnCounts(db)).toEqual({
      SYD: { backlog: 1, in_review: 1 },
      AIPI: { backlog: 1 },
    });
  });
});
