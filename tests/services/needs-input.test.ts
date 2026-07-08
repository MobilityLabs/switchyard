import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, getIssue, claimIssue } from "../../src/services/issues.js";
import { addComment } from "../../src/services/comments.js";
import { listIssueEvents } from "../../src/services/events.js";
import { searchIssues } from "../../src/services/search.js";
import { requestHumanInput } from "../../src/services/needs-input.js";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, { key: "AIPI", name: "aipi" });
  createIssue(db, human, { projectKey: "AIPI", title: "Ship v1" });
});

describe("requestHumanInput", () => {
  it("sets needsInput and records a comment event plus a needs_input_set event", () => {
    const updated = requestHumanInput(db, agent, "AIPI-1", "Should this ship behind a flag?");
    expect(updated.needsInput).toBe(true);

    const types = listIssueEvents(db, updated.id).map((e) => e.type);
    expect(types).toEqual(["created", "comment", "needs_input_set"]);
    const commentEvent = listIssueEvents(db, updated.id)[1];
    expect(commentEvent.payload.body).toBe("Should this ship behind a flag?");
  });

  it("rejects an empty question", () => {
    expect(() => requestHumanInput(db, agent, "AIPI-1", "  ")).toThrowError(/question/i);
  });
});

describe("needsInput clearing", () => {
  it("a human comment clears the flag and records needs_input_cleared", () => {
    requestHumanInput(db, agent, "AIPI-1", "Which env?");
    expect(getIssue(db, "AIPI-1").needsInput).toBe(true);

    addComment(db, human, "AIPI-1", "Use staging.");
    const after = getIssue(db, "AIPI-1");
    expect(after.needsInput).toBe(false);

    const types = listIssueEvents(db, after.id).map((e) => e.type);
    expect(types).toEqual(["created", "comment", "needs_input_set", "comment", "needs_input_cleared"]);
  });

  it("a human answer on an in_progress issue releases the claim so the worker can re-dispatch", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimIssue(db, agent, "AIPI-1");
    requestHumanInput(db, agent, "AIPI-1", "Which env?");

    addComment(db, human, "AIPI-1", "Use staging.");
    const after = getIssue(db, "AIPI-1");
    expect(after.needsInput).toBe(false);
    expect(after.status).toBe("todo");
    expect(after.assigneeId).toBeNull();

    const events = listIssueEvents(db, after.id);
    const released = events.filter((e) => e.type === "claim_released");
    expect(released).toHaveLength(1);
    expect(released[0].payload).toEqual({ reason: "needs_input_cleared" });
  });

  it("a human answer on an issue that is not in_progress clears the flag without touching status", () => {
    updateIssue(db, human, "AIPI-1", { status: "in_review" });
    requestHumanInput(db, agent, "AIPI-1", "Ready to merge?");

    addComment(db, human, "AIPI-1", "Yes, but squash first.");
    const after = getIssue(db, "AIPI-1");
    expect(after.needsInput).toBe(false);
    expect(after.status).toBe("in_review");

    const types = listIssueEvents(db, after.id).map((e) => e.type);
    expect(types).not.toContain("claim_released");
  });

  it("a human status change clears the flag", () => {
    requestHumanInput(db, agent, "AIPI-1", "Which env?");
    const updated = updateIssue(db, human, "AIPI-1", { status: "todo" });
    expect(updated.needsInput).toBe(false);
    const types = listIssueEvents(db, updated.id).map((e) => e.type);
    expect(types).toContain("needs_input_cleared");
  });

  it("an agent comment does not clear the flag", () => {
    requestHumanInput(db, agent, "AIPI-1", "Which env?");
    addComment(db, agent, "AIPI-1", "Bumping this.");
    expect(getIssue(db, "AIPI-1").needsInput).toBe(true);
    const types = listIssueEvents(db, getIssue(db, "AIPI-1").id).map((e) => e.type);
    expect(types).not.toContain("needs_input_cleared");
  });

  it("an agent status change does not clear the flag", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    requestHumanInput(db, agent, "AIPI-1", "Which env?");
    updateIssue(db, agent, "AIPI-1", { priority: "high" });
    expect(getIssue(db, "AIPI-1").needsInput).toBe(true);
  });
});

describe("searchIssues needsInput filter", () => {
  it("filters issues by the needsInput flag", () => {
    createIssue(db, human, { projectKey: "AIPI", title: "Second issue" });
    requestHumanInput(db, agent, "AIPI-1", "Which env?");

    expect(searchIssues(db, { needsInput: true }).map((i) => i.ref)).toEqual(["AIPI-1"]);
    expect(searchIssues(db, { needsInput: false }).map((i) => i.ref)).toEqual(["AIPI-2"]);
  });
});
