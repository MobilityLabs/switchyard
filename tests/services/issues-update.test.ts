import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue, getIssue } from "../../src/services/issues.js";
import { listIssueEvents } from "../../src/services/events.js";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, { key: "AIPI", name: "aipi" });
  createIssue(db, human, { projectKey: "AIPI", title: "Ship v1" });
});

describe("updateIssue", () => {
  it("applies field changes and records one event per changed field", () => {
    const updated = updateIssue(db, human, "AIPI-1", {
      status: "todo",
      priority: "high",
      assigneeName: "claude/worker",
    });
    expect(updated.status).toBe("todo");
    expect(updated.priority).toBe("high");
    expect(updated.assigneeId).toBe(agent.id);
    const types = listIssueEvents(db, updated.id).map((e) => e.type);
    expect(types).toEqual(["created", "status_changed", "priority_changed", "assigned"]);
  });

  it("rejects unknown statuses and assignees legibly", () => {
    expect(() => updateIssue(db, human, "AIPI-1", { status: "doing" as never }))
      .toThrowError(/valid statuses/i);
    expect(() => updateIssue(db, human, "AIPI-1", { assigneeName: "ghost" }))
      .toThrowError(/no actor named "ghost"/i);
  });

  it("no-op labels update records no event", () => {
    updateIssue(db, human, "AIPI-1", { labels: ["a"] });
    const before = listIssueEvents(db, getIssue(db, "AIPI-1").id).length;
    updateIssue(db, human, "AIPI-1", { labels: ["a"] });
    expect(listIssueEvents(db, getIssue(db, "AIPI-1").id)).toHaveLength(before);
  });

  it("rejects unknown priorities legibly", () => {
    expect(() => updateIssue(db, human, "AIPI-1", { priority: "mega" as never }))
      .toThrowError(/valid priorities/i);
  });

  it("agents cannot move issues out of triage; humans can", () => {
    const filed = createIssue(db, agent, {
      projectKey: "AIPI", title: "Agent-filed",
      provenance: { sourceType: "manual", detail: "x" },
    });
    // non-status edits by agents are still allowed in triage
    expect(updateIssue(db, agent, filed.ref, { priority: "high" }).priority).toBe("high");
    expect(() => updateIssue(db, agent, filed.ref, { status: "todo" }))
      .toThrowError(/only humans move issues out of triage/i);
    expect(() => claimIssue(db, agent, filed.ref))
      .toThrowError(/only humans move issues out of triage/i);
    expect(updateIssue(db, human, filed.ref, { status: "todo" }).status).toBe("todo");
  });
});

describe("claimIssue", () => {
  it("assigns the caller and moves to in_progress", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    const claimed = claimIssue(db, agent, "AIPI-1");
    expect(claimed.assigneeId).toBe(agent.id);
    expect(claimed.status).toBe("in_progress");
    expect(getIssue(db, "AIPI-1").status).toBe("in_progress");
  });
});
