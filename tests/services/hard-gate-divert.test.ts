// Task 6: the divert inside updateIssue that parks an executable hard-gated
// status change as a pending_actions row instead of committing it, for a
// supervised session. See src/services/hard-gate.ts for the gate policy and
// pending-action CRUD this divert calls into.
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, getIssue, updateIssue } from "../../src/services/issues.js";
import { openSupervisedSession } from "../../src/services/supervised-sessions.js";
import { pendingActions } from "../../src/db/schema.js";

let db: Db, human: Actor, issueId: number, sessionId: number;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  issueId = createIssue(db, human, { projectKey: "SYD", title: "t", description: "d" }).id;
  sessionId = openSupervisedSession(db, human, "claude-code").sessionId;
});

describe("updateIssue hard-gate divert", () => {
  it("parks a supervised done-stamp as a pending action instead of committing", () => {
    expect(() =>
      updateIssue(db, human, "SYD-1", { status: "done" }, {}, { sessionId }),
    ).toThrow(/awaiting human affirmation/i);
    expect(getIssue(db, "SYD-1").status).not.toBe("done");
    expect(db.select().from(pendingActions).all()).toHaveLength(1);
  });

  it("dedups a retried proposal instead of piling up rows", () => {
    for (let i = 0; i < 2; i++) {
      expect(() =>
        updateIssue(db, human, "SYD-1", { status: "done" }, {}, { sessionId }),
      ).toThrow(/awaiting human affirmation/i);
    }
    expect(db.select().from(pendingActions).all()).toHaveLength(1);
  });

  it("does not divert a plain (non-supervised) human done-stamp", () => {
    const view = updateIssue(db, human, "SYD-1", { status: "done" }, {}, {});
    expect(view.status).toBe("done");
    expect(db.select().from(pendingActions).all()).toHaveLength(0);
  });

  it("does not divert a supervised no-op that keeps the same status", () => {
    // Plain human stamps done first (not diverted, attr = {}).
    updateIssue(db, human, "SYD-1", { status: "done" }, {}, {});
    // Now a supervised call proposes the same status: patch.status ===
    // target.status, so the divert must not fire (today's code no-ops here).
    const view = updateIssue(db, human, "SYD-1", { status: "done" }, {}, { sessionId });
    expect(view.status).toBe("done");
    expect(db.select().from(pendingActions).all()).toHaveLength(0);
  });

  it("rejects a mixed patch instead of silently dropping the other fields", () => {
    expect(() =>
      updateIssue(db, human, "SYD-1", { status: "done", priority: "high" }, {}, { sessionId }),
    ).toThrow(/must be its own call/i);
    expect(db.select().from(pendingActions).all()).toHaveLength(0);
    expect(getIssue(db, "SYD-1").status).not.toBe("done");
  });

  it("does not treat undefined-valued sibling keys as a mixed patch", () => {
    // Mirrors the MCP update_issue adapter, which always constructs the patch
    // object with every key present and `undefined` for anything the caller
    // omitted (src/mcp/server.ts). A naive Object.keys(patch) filter would see
    // "priority" and "title" as present and wrongly reject this as mixed.
    expect(() =>
      updateIssue(
        db,
        human,
        "SYD-1",
        { status: "done", priority: undefined, title: undefined },
        {},
        { sessionId },
      ),
    ).toThrow(/awaiting human affirmation/i);
    expect(db.select().from(pendingActions).all()).toHaveLength(1);
  });
});
