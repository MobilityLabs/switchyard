import { describe, it, expect, beforeEach } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, getIssue } from "../../src/services/issues.js";
import { recordDeliveryEvent } from "../../src/services/delivery-events.js";
import { addGithubRepo } from "../../src/services/github-repos.js";
import {
  openSupervisedSession,
  closeSupervisedSession,
} from "../../src/services/supervised-sessions.js";
import { setSetting } from "../../src/services/settings.js";
import { events, pendingActions } from "../../src/db/schema.js";
import {
  isHardGated,
  EXECUTABLE_GATE_ACTIONS,
  findOrCreatePendingAction,
  getPendingAction,
  listPendingActions,
  affirmPendingAction,
} from "../../src/services/hard-gate.js";

const REPO = "acme/widgets";

let db: Db, human: Actor, issueId: number, sessionId: number;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  addGithubRepo(db, human, { fullName: REPO, projectKey: "SYD" });
  issueId = createIssue(db, human, { projectKey: "SYD", title: "t", description: "d" }).id;
  sessionId = openSupervisedSession(db, human, "claude-code").sessionId;
});

describe("isHardGated", () => {
  it("gates done by default", () => {
    expect(isHardGated(db, "done")).toBe(true);
  });

  it("does not gate a transition outside the configured set", () => {
    expect(isHardGated(db, "in_review")).toBe(false);
  });

  it("an empty opt-out disables gating entirely (full absorption)", () => {
    setSetting(db, human, "supervised.hard_gate_actions", []);
    expect(isHardGated(db, "done")).toBe(false);
  });

  it("only lists actions that have an executor", () => {
    expect(EXECUTABLE_GATE_ACTIONS).toEqual(["done"]);
  });
});

describe("supervised.hard_gate_actions validation", () => {
  it("rejects gating an action with no executor", () => {
    expect(() => setSetting(db, human, "supervised.hard_gate_actions", ["in_review"])).toThrow(
      /not an affirmable/i,
    );
  });

  it("accepts the executable set", () => {
    expect(() => setSetting(db, human, "supervised.hard_gate_actions", ["done"])).not.toThrow();
  });
});

describe("findOrCreatePendingAction", () => {
  it("dedups on (session, issue, action) and refreshes the stored payload", () => {
    const first = findOrCreatePendingAction(db, sessionId, issueId, "done", {
      expectedHeadSha: "aaa",
    });
    const second = findOrCreatePendingAction(db, sessionId, issueId, "done", {
      expectedHeadSha: "bbb",
    });
    expect(second).toBe(first);
    expect(db.select().from(pendingActions).all()).toHaveLength(1);
    expect(getPendingAction(db, first)!.payload).toEqual({ expectedHeadSha: "bbb" });
  });

  it("keeps separate rows per issue", () => {
    const other = createIssue(db, human, { projectKey: "SYD", title: "t2" }).id;
    const a = findOrCreatePendingAction(db, sessionId, issueId, "done", {});
    const b = findOrCreatePendingAction(db, sessionId, other, "done", {});
    expect(b).not.toBe(a);
  });

  it("an affirmed row no longer blocks a fresh proposal for the same tuple", () => {
    const first = findOrCreatePendingAction(db, sessionId, issueId, "done", {});
    affirmPendingAction(db, human, first);
    const second = findOrCreatePendingAction(db, sessionId, issueId, "done", {});
    expect(second).not.toBe(first);
    expect(getPendingAction(db, second)!.status).toBe("pending");
  });
});

describe("getPendingAction / listPendingActions", () => {
  it("returns null for an unknown id", () => {
    expect(getPendingAction(db, 999)).toBeNull();
  });

  it("lists pending rows and drops them once affirmed", () => {
    const id = findOrCreatePendingAction(db, sessionId, issueId, "done", {});
    expect(listPendingActions(db, "pending").map((r) => r.id)).toEqual([id]);
    affirmPendingAction(db, human, id);
    expect(listPendingActions(db, "pending")).toEqual([]);
    expect(listPendingActions(db, "affirmed").map((r) => r.id)).toEqual([id]);
  });
});

describe("affirmPendingAction", () => {
  it("executes the gated done transition and marks the row affirmed", () => {
    const id = findOrCreatePendingAction(db, sessionId, issueId, "done", {});
    const view = affirmPendingAction(db, human, id);
    expect(view.status).toBe("done");
    expect(getIssue(db, "SYD-1").status).toBe("done");
    const row = getPendingAction(db, id)!;
    expect(row.status).toBe("affirmed");
    expect(row.affirmedById).toBe(human.id);
    expect(row.affirmedAt).not.toBeNull();
  });

  it("executes as the human with no supervised attribution on the event", () => {
    const id = findOrCreatePendingAction(db, sessionId, issueId, "done", {});
    affirmPendingAction(db, human, id);
    const done = db
      .select()
      .from(events)
      .where(and(eq(events.issueId, issueId), eq(events.type, "status_changed")))
      .all()
      .at(-1)!;
    expect(done.payload).toMatchObject({ to: "done" });
    expect(done.actorId).toBe(human.id);
    expect(done.sessionId).toBeNull();
    expect(done.viaAgentId).toBeNull();
  });

  it("carries the payload's expectedHeadSha into the executed update", () => {
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 7,
      url: `https://github.com/${REPO}/pull/7`,
      headSha: "current-sha",
    });
    const id = findOrCreatePendingAction(db, sessionId, issueId, "done", {
      expectedHeadSha: "current-sha",
    });
    expect(affirmPendingAction(db, human, id).status).toBe("done");
  });

  it("refuses a human who is not the session's accountable human", () => {
    const other = createActor(db, { name: "other", type: "human" }).actor;
    const id = findOrCreatePendingAction(db, sessionId, issueId, "done", {});
    expect(() => affirmPendingAction(db, other, id)).toThrow(/only the accountable human/i);
    expect(getIssue(db, "SYD-1").status).not.toBe("done");
  });

  it("refuses an agent", () => {
    const agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
    const id = findOrCreatePendingAction(db, sessionId, issueId, "done", {});
    expect(() => affirmPendingAction(db, agent, id)).toThrow(/only a human/i);
  });

  it("refuses an unknown id", () => {
    expect(() => affirmPendingAction(db, human, 999)).toThrow(/no pending action/i);
  });

  it("refuses an action type with no executor rather than silently no-opping", () => {
    const id = findOrCreatePendingAction(db, sessionId, issueId, "in_review", {});
    expect(() => affirmPendingAction(db, human, id)).toThrow(/no executor/i);
    expect(getPendingAction(db, id)!.status).toBe("pending");
  });

  it("refuses a second affirmation of the same row", () => {
    const id = findOrCreatePendingAction(db, sessionId, issueId, "done", {});
    affirmPendingAction(db, human, id);
    expect(() => affirmPendingAction(db, human, id)).toThrow(/no longer pending/i);
  });

  it("refuses affirmation once the parking session has been closed", () => {
    const closed = openSupervisedSession(db, human, "claude-code-closed");
    const id = findOrCreatePendingAction(db, closed.sessionId, issueId, "done", {});
    closeSupervisedSession(db, closed.sessionToken);
    expect(() => affirmPendingAction(db, human, id)).toThrow(/closed|expired/i);
    expect(getIssue(db, "SYD-1").status).not.toBe("done");
    expect(getPendingAction(db, id)!.status).toBe("pending");
  });

  it("refuses affirmation once the parking session has expired", () => {
    const expired = openSupervisedSession(db, human, "claude-code-expired");
    db.run(sql`UPDATE sessions SET expires_at = 1 WHERE id = ${expired.sessionId}`);
    const id = findOrCreatePendingAction(db, expired.sessionId, issueId, "done", {});
    expect(() => affirmPendingAction(db, human, id)).toThrow(/closed|expired/i);
    expect(getIssue(db, "SYD-1").status).not.toBe("done");
    expect(getPendingAction(db, id)!.status).toBe("pending");
  });

  it("still affirms a pending action from a live (open, unexpired) session", () => {
    const live = openSupervisedSession(db, human, "claude-code-live");
    const id = findOrCreatePendingAction(db, live.sessionId, issueId, "done", {});
    expect(affirmPendingAction(db, human, id).status).toBe("done");
  });

  it("rolls back the claim when execution throws, leaving the row re-affirmable", () => {
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 7,
      url: `https://github.com/${REPO}/pull/7`,
      headSha: "current-sha",
    });
    const id = findOrCreatePendingAction(db, sessionId, issueId, "done", {
      expectedHeadSha: "stale-sha",
    });
    expect(() => affirmPendingAction(db, human, id)).toThrow(/stale-sha/);
    expect(getPendingAction(db, id)!.status).toBe("pending");
    expect(getIssue(db, "SYD-1").status).not.toBe("done");

    // The refreshed payload makes the same row affirmable again.
    findOrCreatePendingAction(db, sessionId, issueId, "done", { expectedHeadSha: "current-sha" });
    expect(affirmPendingAction(db, human, id).status).toBe("done");
  });
});
