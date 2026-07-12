import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue, getIssue } from "../../src/services/issues.js";
import { dependencies } from "../../src/db/schema.js";

// Regression test: claimIssue must enforce blockers with NO side-effect import
// of dependencies.js required. This file imports only issues.js (plus setup
// helpers) to prove blocker enforcement is wired via a direct import, not a
// mutable-binding side effect that only fires when dependencies.js happens to
// have been loaded.
let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "AIPI", name: "aipi" });
  createIssue(db, human, { projectKey: "AIPI", title: "Schema", priority: "high" }); // AIPI-1
  createIssue(db, human, { projectKey: "AIPI", title: "API", priority: "urgent" }); // AIPI-2
  for (const ref of ["AIPI-1", "AIPI-2"]) updateIssue(db, human, ref, { status: "todo" });
});

describe("claimIssue blocker enforcement (isolated from dependencies.js)", () => {
  it("throws when the issue is blocked, without ever importing dependencies.js", () => {
    const blocker = getIssue(db, "AIPI-1");
    const blocked = getIssue(db, "AIPI-2");
    db.insert(dependencies).values({ blockerId: blocker.id, blockedId: blocked.id }).run();

    expect(() => claimIssue(db, agent, "AIPI-2")).toThrowError(/blocked by/);
  });
});
