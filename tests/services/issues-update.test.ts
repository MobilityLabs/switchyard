import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue, getIssue } from "../../src/services/issues.js";
import { listIssueEvents } from "../../src/services/events.js";
import { requestHumanInput } from "../../src/services/needs-input.js";

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

  it("reordered-but-identical labels record no event, but a real change does", () => {
    updateIssue(db, human, "AIPI-1", { labels: ["a", "b"] });
    const afterInitial = listIssueEvents(db, getIssue(db, "AIPI-1").id).length;
    updateIssue(db, human, "AIPI-1", { labels: ["b", "a"] });
    expect(listIssueEvents(db, getIssue(db, "AIPI-1").id)).toHaveLength(afterInitial);
    updateIssue(db, human, "AIPI-1", { labels: ["a", "c"] });
    expect(listIssueEvents(db, getIssue(db, "AIPI-1").id)).toHaveLength(afterInitial + 1);
  });

  it("rejects unknown priorities legibly", () => {
    expect(() => updateIssue(db, human, "AIPI-1", { priority: "mega" as never }))
      .toThrowError(/valid priorities/i);
  });

  it("agents cannot move issues out of triage; humans can", () => {
    const filed = createIssue(db, agent, {
      projectKey: "AIPI", title: "Agent-filed",
      description: "Filed while working another task; needs a human to confirm priority before scheduling.",
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

  it("agents cannot move issues to done; humans can", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimIssue(db, agent, "AIPI-1");
    updateIssue(db, agent, "AIPI-1", { status: "in_review" });
    expect(() => updateIssue(db, agent, "AIPI-1", { status: "done" }))
      .toThrowError(/only humans move issues to done/i);
    expect(getIssue(db, "AIPI-1").status).toBe("in_review");
    expect(updateIssue(db, human, "AIPI-1", { status: "done" }).status).toBe("done");
  });

  it("agents cannot add the auto label, but may remove it or keep it", () => {
    // starting without "auto": agent adding it is rejected
    updateIssue(db, human, "AIPI-1", { labels: ["urgent"] });
    expect(() => updateIssue(db, agent, "AIPI-1", { labels: ["auto", "urgent"] }))
      .toThrowError(/only humans apply the "auto" label/i);
    expect(getIssue(db, "AIPI-1").labels).toEqual(["urgent"]);

    // a human adding it is fine
    expect(updateIssue(db, human, "AIPI-1", { labels: ["auto", "urgent"] }).labels.sort())
      .toEqual(["auto", "urgent"]);

    // agent removing it is fine
    expect(updateIssue(db, agent, "AIPI-1", { labels: ["urgent"] }).labels).toEqual(["urgent"]);

    // agent keeping an already-present "auto" while changing other labels is fine
    updateIssue(db, human, "AIPI-1", { labels: ["auto", "urgent"] });
    expect(updateIssue(db, agent, "AIPI-1", { labels: ["auto", "other"] }).labels.sort())
      .toEqual(["auto", "other"]);
  });

  it("needs_input clears only on a status change, not on unrelated field edits", () => {
    const filed = createIssue(db, agent, {
      projectKey: "AIPI", title: "Needs a call",
      description: "Blocked on a decision only a human can make about scope.",
      provenance: { sourceType: "manual", detail: "x" },
    });
    updateIssue(db, human, filed.ref, { status: "todo" });
    requestHumanInput(db, agent, filed.ref, "Which scope should this cover?");
    expect(getIssue(db, filed.ref).needsInput).toBe(true);

    // priority/label/title-only edits by a human must NOT clear needsInput
    updateIssue(db, human, filed.ref, { priority: "high" });
    expect(getIssue(db, filed.ref).needsInput).toBe(true);
    updateIssue(db, human, filed.ref, { labels: ["x"] });
    expect(getIssue(db, filed.ref).needsInput).toBe(true);
    updateIssue(db, human, filed.ref, { title: "Needs a call (updated)" });
    expect(getIssue(db, filed.ref).needsInput).toBe(true);

    // a status change by a human does clear it
    updateIssue(db, human, filed.ref, { status: "in_progress" });
    expect(getIssue(db, filed.ref).needsInput).toBe(false);
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
