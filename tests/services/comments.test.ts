import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue } from "../../src/services/issues.js";
import { addComment, getActivity } from "../../src/services/comments.js";

describe("comments and activity", () => {
  it("appends comments and returns the attributed stream", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    const agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
    createProject(db, { key: "AIPI", name: "aipi" });
    createIssue(db, human, { projectKey: "AIPI", title: "Ship v1" });
    addComment(db, agent, "AIPI-1", "Implemented and verified with vitest — 12 tests pass.");
    const activity = getActivity(db, "AIPI-1");
    expect(activity.map((a) => a.type)).toEqual(["created", "comment"]);
    expect(activity[1].actorName).toBe("claude/worker");
    expect(activity[1].payload.body).toMatch(/12 tests pass/);
    expect(() => addComment(db, agent, "AIPI-1", "  ")).toThrowError(/empty/i);
  });

  it("emits agent_question when a human leads a comment with @agent", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    createProject(db, { key: "AIPI", name: "aipi" });
    createIssue(db, human, { projectKey: "AIPI", title: "Ship v1" });

    addComment(db, human, "AIPI-1", "@agent what's blocking this?");
    const activity = getActivity(db, "AIPI-1");
    expect(activity.map((a) => a.type)).toEqual(["created", "comment", "agent_question"]);
    expect(activity[2].payload.body).toMatch(/what's blocking/);
    expect(activity[2].actorName).toBe("sean");
  });

  it("matches @agent case-insensitively and tolerates leading whitespace", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    createProject(db, { key: "AIPI", name: "aipi" });
    createIssue(db, human, { projectKey: "AIPI", title: "Ship v1" });

    addComment(db, human, "AIPI-1", "  @AGENT any update?");
    expect(getActivity(db, "AIPI-1").map((a) => a.type)).toEqual([
      "created",
      "comment",
      "agent_question",
    ]);
  });

  it("does not emit agent_question for an ordinary comment or a mid-sentence mention", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    createProject(db, { key: "AIPI", name: "aipi" });
    createIssue(db, human, { projectKey: "AIPI", title: "Ship v1" });

    addComment(db, human, "AIPI-1", "looks good to me");
    addComment(db, human, "AIPI-1", "ping @agent later");
    expect(getActivity(db, "AIPI-1").map((a) => a.type)).toEqual(["created", "comment", "comment"]);
  });

  it("does not emit agent_question when an agent actor writes the comment", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    const agentActor = createActor(db, { name: "claude/worker", type: "agent" }).actor;
    createProject(db, { key: "AIPI", name: "aipi" });
    createIssue(db, human, { projectKey: "AIPI", title: "Ship v1" });

    addComment(db, agentActor, "AIPI-1", "@agent can someone else confirm?");
    expect(getActivity(db, "AIPI-1").map((a) => a.type)).toEqual(["created", "comment"]);
  });
});
