import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue, getIssue } from "../../src/services/issues.js";
import { ensureClaimLeaseCutover } from "../../src/services/lease-cutover.js";
import { listIssueEvents } from "../../src/services/events.js";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "AIPI", name: "aipi" });
});

describe("ensureClaimLeaseCutover", () => {
  it("releases every in_progress claim once, with claim_released{lease_cutover}", () => {
    createIssue(db, human, { projectKey: "AIPI", title: "a" });
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimIssue(db, agent, "AIPI-1");
    createIssue(db, human, { projectKey: "AIPI", title: "b" }); // stays backlog
    const id1 = getIssue(db, "AIPI-1").id;

    const first = ensureClaimLeaseCutover(db);
    expect(first).toEqual({ released: 1, alreadyDone: false });
    const after = getIssue(db, "AIPI-1");
    expect(after.status).toBe("todo");
    expect(after.assigneeId).toBeNull();
    const last = listIssueEvents(db, id1).at(-1)!;
    expect(last.type).toBe("claim_released");
    expect(last.payload).toMatchObject({ reason: "lease_cutover" });

    // once-only
    expect(ensureClaimLeaseCutover(db)).toEqual({ released: 0, alreadyDone: true });
  });

  it("fires no events for non-in_progress issues", () => {
    createIssue(db, human, { projectKey: "AIPI", title: "a" });
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    const id = getIssue(db, "AIPI-1").id;
    const before = listIssueEvents(db, id).length;
    expect(ensureClaimLeaseCutover(db).released).toBe(0);
    expect(listIssueEvents(db, id).length).toBe(before);
  });
});
