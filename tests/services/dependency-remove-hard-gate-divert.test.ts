// SYD-246: the divert inside removeDependency that parks an executable
// hard-gated dependency removal as a pending_actions row instead of
// committing it, for a supervised session. Mirrors
// hard-gate-divert.test.ts (the "done" transition's divert in updateIssue).
import { describe, it, expect, beforeEach } from "vitest";
import { createHuman } from "../helpers/human.js";
import type { HumanActor } from "../../src/services/principal.js";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue } from "../../src/services/issues.js";
import {
  addDependency,
  listDependencies,
  removeDependency,
} from "../../src/services/dependencies.js";
import {
  openSupervisedSession,
  resolveSupervisedPrincipal,
} from "../../src/services/supervised-sessions.js";
import { attributionOf, type Attribution } from "../../src/services/attribution.js";
import { setSetting } from "../../src/services/settings.js";
import { pendingActions } from "../../src/db/schema.js";

let db: Db, human: HumanActor, sessionId: number, supAttr: Attribution;
beforeEach(() => {
  db = openDb(":memory:");
  human = createHuman(db, "sean");
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  createIssue(db, human, { projectKey: "SYD", title: "blocker" }); // SYD-1
  createIssue(db, human, { projectKey: "SYD", title: "blocked" }); // SYD-2
  createIssue(db, human, { projectKey: "SYD", title: "second blocker" }); // SYD-3
  const _sess = openSupervisedSession(db, human, "claude-code");
  sessionId = _sess.sessionId;
  supAttr = attributionOf(resolveSupervisedPrincipal(db, _sess.sessionToken)!);
  setSetting(db, human, "supervised.hard_gate_actions", ["done", "dependency.remove"]);
});

describe("removeDependency hard-gate divert", () => {
  it("parks a supervised removal as a pending action instead of committing", () => {
    addDependency(db, human, "SYD-1", "SYD-2");
    expect(() => removeDependency(db, human, "SYD-1", "SYD-2", supAttr)).toThrow(
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
      expect(() => removeDependency(db, human, "SYD-1", "SYD-2", supAttr)).toThrow(
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

  // SYD-281: the divert needs an edge to exist (dependencies.ts requires
  // edgeExists), so a non-existent edge falls through to the human-only gate —
  // which a supervised principal used to pass, silently no-opping. It is now
  // refused. Nothing is parked, because there is nothing to propose.
  it("refuses rather than silently no-opping when the edge doesn't exist", () => {
    expect(() => removeDependency(db, human, "SYD-1", "SYD-2", supAttr)).toThrow(/human/i);
    expect(db.select().from(pendingActions).all()).toHaveLength(0);
  });

  it("proposing removal of two different blockers on the same issue parks two rows, not one clobbering the other", () => {
    addDependency(db, human, "SYD-1", "SYD-2");
    addDependency(db, human, "SYD-3", "SYD-2");
    expect(() => removeDependency(db, human, "SYD-1", "SYD-2", supAttr)).toThrow(
      /awaiting human affirmation/i,
    );
    expect(() => removeDependency(db, human, "SYD-3", "SYD-2", supAttr)).toThrow(
      /awaiting human affirmation/i,
    );
    const rows = db.select().from(pendingActions).all();
    expect(rows).toHaveLength(2);
    const blockerRefs = rows.map((r) => (r.payload as { blockerRef: string }).blockerRef).sort();
    expect(blockerRefs).toEqual(["SYD-1", "SYD-3"]);
  });

  // SYD-281: this is the fails-CLOSED property. Without the operator settings
  // write, a supervised removal skips the divert and lands on the human-only
  // gate, where it is REFUSED — it does not execute. The setting upgrades
  // refusal to a proposable divert, so a partially-applied rollout costs a
  // capability, never a hole.
  it("refuses — not executes — when dependency.remove isn't in the gate list", () => {
    setSetting(db, human, "supervised.hard_gate_actions", ["done"]);
    addDependency(db, human, "SYD-1", "SYD-2");
    expect(() => removeDependency(db, human, "SYD-1", "SYD-2", supAttr)).toThrow(/human/i);
    expect(listDependencies(db, "SYD-2").blockedBy.map((b) => b.ref)).toEqual(["SYD-1"]);
    expect(db.select().from(pendingActions).all()).toHaveLength(0);
  });
});
