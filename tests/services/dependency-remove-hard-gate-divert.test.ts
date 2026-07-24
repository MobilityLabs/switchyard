// SYD-246: the divert inside removeDependency that parks an executable
// hard-gated dependency removal as a pending_actions row instead of
// committing it, for a supervised session. Mirrors
// hard-gate-divert.test.ts (the "done" transition's divert in updateIssue).
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue } from "../../src/services/issues.js";
import {
  addDependency,
  listDependencies,
  removeDependency,
} from "../../src/services/dependencies.js";
import { openSupervisedSession } from "../../src/services/supervised-sessions.js";
import { setSetting } from "../../src/services/settings.js";
import { pendingActions } from "../../src/db/schema.js";

let db: Db, human: Actor, sessionId: number;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  createIssue(db, human, { projectKey: "SYD", title: "blocker" }); // SYD-1
  createIssue(db, human, { projectKey: "SYD", title: "blocked" }); // SYD-2
  createIssue(db, human, { projectKey: "SYD", title: "second blocker" }); // SYD-3
  sessionId = openSupervisedSession(db, human, "claude-code").sessionId;
  setSetting(db, human, "supervised.hard_gate_actions", ["done", "dependency.remove"]);
});

describe("removeDependency hard-gate divert", () => {
  it("parks a supervised removal as a pending action instead of committing", () => {
    addDependency(db, human, "SYD-1", "SYD-2");
    expect(() => removeDependency(db, human, "SYD-1", "SYD-2", { sessionId })).toThrow(
      /awaiting human affirmation/i,
    );
    expect(listDependencies(db, "SYD-2").blockedBy).toEqual([
      { ref: "SYD-1", title: "blocker", status: "backlog" },
    ]);
    expect(db.select().from(pendingActions).all()).toHaveLength(1);
  });

  it("dedups a retried proposal instead of piling up rows", () => {
    addDependency(db, human, "SYD-1", "SYD-2");
    for (let i = 0; i < 2; i++) {
      expect(() => removeDependency(db, human, "SYD-1", "SYD-2", { sessionId })).toThrow(
        /awaiting human affirmation/i,
      );
    }
    expect(db.select().from(pendingActions).all()).toHaveLength(1);
  });

  it("does not divert a plain (non-supervised) human removal", () => {
    addDependency(db, human, "SYD-1", "SYD-2");
    removeDependency(db, human, "SYD-1", "SYD-2", {});
    expect(listDependencies(db, "SYD-2").blockedBy).toEqual([]);
    expect(db.select().from(pendingActions).all()).toHaveLength(0);
  });

  it("does not divert when the edge doesn't exist — already a no-op", () => {
    removeDependency(db, human, "SYD-1", "SYD-2", { sessionId });
    expect(db.select().from(pendingActions).all()).toHaveLength(0);
  });

  it("proposing removal of two different blockers on the same issue parks two rows, not one clobbering the other", () => {
    addDependency(db, human, "SYD-1", "SYD-2");
    addDependency(db, human, "SYD-3", "SYD-2");
    expect(() => removeDependency(db, human, "SYD-1", "SYD-2", { sessionId })).toThrow(
      /awaiting human affirmation/i,
    );
    expect(() => removeDependency(db, human, "SYD-3", "SYD-2", { sessionId })).toThrow(
      /awaiting human affirmation/i,
    );
    const rows = db.select().from(pendingActions).all();
    expect(rows).toHaveLength(2);
    const blockerRefs = rows.map((r) => (r.payload as { blockerRef: string }).blockerRef).sort();
    expect(blockerRefs).toEqual(["SYD-1", "SYD-3"]);
  });

  it("does not divert when dependency.remove isn't in the gate list (full absorption)", () => {
    setSetting(db, human, "supervised.hard_gate_actions", ["done"]);
    addDependency(db, human, "SYD-1", "SYD-2");
    removeDependency(db, human, "SYD-1", "SYD-2", { sessionId });
    expect(listDependencies(db, "SYD-2").blockedBy).toEqual([]);
    expect(db.select().from(pendingActions).all()).toHaveLength(0);
  });
});
