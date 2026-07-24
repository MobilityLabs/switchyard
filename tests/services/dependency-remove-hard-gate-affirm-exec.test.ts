// SYD-246: exercises the dependency.remove divert (src/services/dependencies.ts
// removeDependency) together with the affirm executor
// (src/services/hard-gate.ts affirmPendingAction) as one end-to-end flow — a
// supervised proposal to remove an edge creates the pending row, then a human
// affirms it. Mirrors hard-gate-affirm-exec.test.ts (the "done" transition).
import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, claimIssue } from "../../src/services/issues.js";
import {
  addDependency,
  listDependencies,
  removeDependency,
} from "../../src/services/dependencies.js";
import { listIssueEvents } from "../../src/services/events.js";
import { openSupervisedSession } from "../../src/services/supervised-sessions.js";
import { setSetting } from "../../src/services/settings.js";
import { events, pendingActions } from "../../src/db/schema.js";
import { affirmPendingAction, getPendingAction } from "../../src/services/hard-gate.js";

let db: Db, human: Actor, agent: Actor, blockedId: number, sessionId: number;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  createIssue(db, human, { projectKey: "SYD", title: "blocker" }); // SYD-1
  blockedId = createIssue(db, human, { projectKey: "SYD", title: "blocked" }).id; // SYD-2
  sessionId = openSupervisedSession(db, human, "claude-code").sessionId;
  setSetting(db, human, "supervised.hard_gate_actions", ["done", "dependency.remove"]);
  addDependency(db, human, "SYD-1", "SYD-2");
});

function onlyPendingId(): number {
  const rows = db.select().from(pendingActions).all();
  expect(rows).toHaveLength(1);
  return rows[0].id;
}

describe("removeDependency divert -> affirm end to end", () => {
  it("affirming the human's own pending action executes the removal", () => {
    expect(() => removeDependency(db, human, "SYD-1", "SYD-2", { sessionId })).toThrow(
      /awaiting human affirmation/i,
    );
    const id = onlyPendingId();

    const view = affirmPendingAction(db, human, id);
    expect(view.ref).toBe("SYD-2");
    expect(listDependencies(db, "SYD-2").blockedBy).toEqual([]);
    expect(getPendingAction(db, id)!.status).toBe("affirmed");
    expect(getPendingAction(db, id)!.affirmedById).toBe(human.id);

    const removed = listIssueEvents(db, blockedId).filter((e) => e.type === "blocked_by_removed");
    expect(removed).toHaveLength(1);
    // The now-unblocked issue is claimable.
    expect(claimIssue(db, agent, "SYD-2").issue.status).toBe("in_progress");
  });

  it("executes as the human with no supervised attribution on the event", () => {
    expect(() => removeDependency(db, human, "SYD-1", "SYD-2", { sessionId })).toThrow(
      /awaiting human affirmation/i,
    );
    const id = onlyPendingId();
    affirmPendingAction(db, human, id);

    const removed = db
      .select()
      .from(events)
      .where(and(eq(events.issueId, blockedId), eq(events.type, "blocked_by_removed")))
      .all()
      .at(-1)!;
    expect(removed.actorId).toBe(human.id);
    expect(removed.sessionId).toBeNull();
    expect(removed.viaAgentId).toBeNull();
  });

  it("double-affirm: second affirm throws and exactly one removal event is recorded", () => {
    expect(() => removeDependency(db, human, "SYD-1", "SYD-2", { sessionId })).toThrow(
      /awaiting human affirmation/i,
    );
    const id = onlyPendingId();

    affirmPendingAction(db, human, id);
    expect(() => affirmPendingAction(db, human, id)).toThrow(/no longer pending/i);

    const removed = listIssueEvents(db, blockedId).filter((e) => e.type === "blocked_by_removed");
    expect(removed).toHaveLength(1);
  });

  it("refuses a pending row whose payload is missing blocker/blocked refs", () => {
    // Not reachable through the real divert (which always writes both refs);
    // guards a malformed row from silently no-opping instead of executing.
    const id = db
      .insert(pendingActions)
      .values({ sessionId, issueId: blockedId, actionType: "dependency.remove", payload: {} })
      .returning({ id: pendingActions.id })
      .get().id;
    expect(() => affirmPendingAction(db, human, id)).toThrow(/missing blocker\/blocked refs/i);
    expect(getPendingAction(db, id)!.status).toBe("pending");
  });
});
