import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue, getIssue } from "../../src/services/issues.js";
import { requestHumanInput } from "../../src/services/needs-input.js";
import { addComment } from "../../src/services/comments.js";
import { getActiveLease } from "../../src/services/leases.js";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "AIPI", name: "aipi" });
  createIssue(db, human, { projectKey: "AIPI", title: "t" });
  updateIssue(db, human, "AIPI-1", { status: "todo" });
});

describe("human-answer release invalidates the lease", () => {
  it("releases an in_progress needsInput issue AND invalidates its lease", () => {
    const { leaseToken } = claimIssue(db, agent, "AIPI-1");
    const id = getIssue(db, "AIPI-1").id;
    requestHumanInput(db, agent, "AIPI-1", "Which approach?", leaseToken);
    addComment(db, human, "AIPI-1", "Go with option B.");
    const after = getIssue(db, "AIPI-1");
    expect(after.status).toBe("todo");
    expect(after.assigneeId).toBeNull();
    expect(after.needsInput).toBe(false);
    expect(getActiveLease(db, id)).toBeNull(); // lease invalidated
  });

  it("on a non-in_progress needsInput issue, only clears the flag (no invalidation)", () => {
    const { leaseToken } = claimIssue(db, agent, "AIPI-1");
    const id = getIssue(db, "AIPI-1").id;
    updateIssue(db, agent, "AIPI-1", { status: "in_review" }, { presented: leaseToken });
    requestHumanInput(db, agent, "AIPI-1", "still need a decision", leaseToken);
    expect(getIssue(db, "AIPI-1").needsInput).toBe(true);
    addComment(db, human, "AIPI-1", "answered");
    const after = getIssue(db, "AIPI-1");
    expect(after.needsInput).toBe(false);
    expect(after.status).toBe("in_review"); // not released
    expect(getActiveLease(db, id)).not.toBeNull(); // lease untouched
  });
});
