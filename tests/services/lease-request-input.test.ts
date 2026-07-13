import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue } from "../../src/services/issues.js";
import { requestHumanInput } from "../../src/services/needs-input.js";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "AIPI", name: "aipi" });
  createIssue(db, human, { projectKey: "AIPI", title: "t" });
  updateIssue(db, human, "AIPI-1", { status: "todo" });
});

describe("requestHumanInput lease gate", () => {
  it("rejects an agent escalation with no lease token and accepts it with the claim's token", () => {
    const { leaseToken } = claimIssue(db, agent, "AIPI-1");
    expect(() => requestHumanInput(db, agent, "AIPI-1", "Which approach?")).toThrow();
    const issue = requestHumanInput(db, agent, "AIPI-1", "Which approach?", leaseToken);
    expect(issue.needsInput).toBe(true);
  });
});
