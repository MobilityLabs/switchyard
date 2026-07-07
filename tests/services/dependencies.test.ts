import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue } from "../../src/services/issues.js";
import { addDependency, getOpenBlockers, nextTask } from "../../src/services/dependencies.js";
import { listIssueEvents } from "../../src/services/events.js";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, { key: "AIPI", name: "aipi" });
  createIssue(db, human, { projectKey: "AIPI", title: "Schema", priority: "high" });   // AIPI-1
  createIssue(db, human, { projectKey: "AIPI", title: "API", priority: "urgent" });    // AIPI-2
  createIssue(db, human, { projectKey: "AIPI", title: "Docs", priority: "low" });      // AIPI-3
  for (const ref of ["AIPI-1", "AIPI-2", "AIPI-3"]) updateIssue(db, human, ref, { status: "todo" });
});

describe("dependencies", () => {
  it("blocked issues cannot be claimed until the blocker is done", () => {
    addDependency(db, human, "AIPI-1", "AIPI-2"); // schema blocks api
    expect(getOpenBlockers(db, 2).map((b) => b.ref)).toEqual(["AIPI-1"]);
    expect(() => claimIssue(db, agent, "AIPI-2"))
      .toThrowError(/blocked by AIPI-1.*next_task/s);
    updateIssue(db, human, "AIPI-1", { status: "done" });
    expect(claimIssue(db, agent, "AIPI-2").status).toBe("in_progress");
  });

  it("nextTask returns highest-priority unblocked todo, or null", () => {
    addDependency(db, human, "AIPI-1", "AIPI-2");
    expect(nextTask(db, agent)?.ref).toBe("AIPI-1"); // urgent AIPI-2 is blocked
    updateIssue(db, human, "AIPI-1", { status: "done" });
    expect(nextTask(db, agent)?.ref).toBe("AIPI-2");
    expect(nextTask(db, agent, "AIPI")?.ref).toBe("AIPI-2");
    for (const ref of ["AIPI-2", "AIPI-3"]) updateIssue(db, human, ref, { status: "done" });
    expect(nextTask(db, agent)).toBeNull();
  });

  it("nextTask skips issues assigned to someone else", () => {
    updateIssue(db, human, "AIPI-2", { assigneeName: "sean" });
    expect(nextTask(db, agent)?.ref).toBe("AIPI-1");
  });

  it("nextTask throws legibly for an unknown project key", () => {
    expect(() => nextTask(db, agent, "ZZ")).toThrowError(/no project with key "ZZ"/i);
  });

  it("re-adding the same dependency records exactly one blocked_by_added event", () => {
    addDependency(db, human, "AIPI-1", "AIPI-2");
    addDependency(db, human, "AIPI-1", "AIPI-2");
    const types = listIssueEvents(db, 2).filter((e) => e.type === "blocked_by_added");
    expect(types).toHaveLength(1);
  });
});
