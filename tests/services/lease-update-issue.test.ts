import { describe, it, expect, beforeEach } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { openDb, type Db } from "../../src/db/index.js";
import { claimLeases } from "../../src/db/schema.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue, getIssue } from "../../src/services/issues.js";
import { getActiveLease, heartbeatLease, validateLease } from "../../src/services/leases.js";
import { listIssueEvents } from "../../src/services/events.js";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "AIPI", name: "aipi" });
  createIssue(db, human, { projectKey: "AIPI", title: "t" });
  updateIssue(db, human, "AIPI-1", { status: "todo" });
});

describe("updateIssue lease enforcement", () => {
  it("mints a lease on the SYD-111 bare-PATCH auto-claim and returns it via the out-param", () => {
    const minted = { token: null as string | null };
    updateIssue(db, agent, "AIPI-1", { status: "in_progress" }, { minted });
    expect(minted.token).toMatch(/^lease_/);
    const id = getIssue(db, "AIPI-1").id;
    expect(getActiveLease(db, id)?.actorId).toBe(agent.id);
  });

  it("rejects a holder agent's mutation with no lease token, accepts it with the minted one", () => {
    const minted = { token: null as string | null };
    updateIssue(db, agent, "AIPI-1", { status: "in_progress" }, { minted });
    const token = minted.token!;
    // no token -> rejected (shared-token hole: a second session lacks the lease)
    expect(() => updateIssue(db, agent, "AIPI-1", { status: "in_review" })).toThrow();
    // wrong token -> rejected
    expect(() =>
      updateIssue(db, agent, "AIPI-1", { status: "in_review" }, { presented: "lease_wrong" }),
    ).toThrow();
    // correct token -> ok
    const after = updateIssue(db, agent, "AIPI-1", { status: "in_review" }, { presented: token });
    expect(after.status).toBe("in_review");
  });

  it("invalidates the lease on self-release to todo (after validating the holder)", () => {
    const minted = { token: null as string | null };
    updateIssue(db, agent, "AIPI-1", { status: "in_progress" }, { minted });
    const id = getIssue(db, "AIPI-1").id;
    updateIssue(db, agent, "AIPI-1", { status: "todo" }, { presented: minted.token! });
    expect(getIssue(db, "AIPI-1").status).toBe("todo");
    expect(getActiveLease(db, id)).toBeNull();
    const types = listIssueEvents(db, id).map((e) => e.type);
    expect(types).toContain("claim_released");
  });

  it("does not lease-gate a human editing a claimed issue", () => {
    const minted = { token: null as string | null };
    updateIssue(db, agent, "AIPI-1", { status: "in_progress" }, { minted });
    // human reassigns / edits without any lease token — must not throw
    expect(() => updateIssue(db, human, "AIPI-1", { priority: "high" })).not.toThrow();
  });

  it.each([
    { toTodo: false, sameActor: false },
    { toTodo: false, sameActor: true },
    { toTodo: true, sameActor: false },
    { toTodo: true, sameActor: true },
  ])("retires an explicitly cleared claim before replacement ($toTodo, $sameActor)", (scenario) => {
    const first = claimIssue(db, agent, "AIPI-1");
    updateIssue(db, human, "AIPI-1", {
      assigneeName: null,
      ...(scenario.toTodo ? { status: "todo" as const } : {}),
    });
    expect(getActiveLease(db, first.issue.id)).toBeNull();
    expect(() => heartbeatLease(db, first.issue.id, agent.id, first.leaseToken)).toThrow();

    const nextActor = scenario.sameActor
      ? agent
      : createActor(db, { name: "codex/worker", type: "agent" }).actor;
    const next = claimIssue(db, nextActor, "AIPI-1");
    expect(() =>
      updateIssue(db, nextActor, "AIPI-1", { title: "Progress" }, { presented: next.leaseToken }),
    ).not.toThrow();
    expect(() => validateLease(db, first.issue.id, agent.id, first.leaseToken)).toThrow();
    expect(
      db
        .select()
        .from(claimLeases)
        .where(and(eq(claimLeases.issueId, first.issue.id), isNull(claimLeases.invalidatedAt)))
        .all(),
    ).toHaveLength(1);
  });

  it("retires the outgoing lease on direct human reassignment", () => {
    const first = claimIssue(db, agent, "AIPI-1");
    const nextActor = createActor(db, { name: "codex/worker", type: "agent" }).actor;
    updateIssue(db, human, "AIPI-1", { assigneeName: nextActor.name });
    expect(() => validateLease(db, first.issue.id, agent.id, first.leaseToken)).toThrow();
    const next = claimIssue(db, nextActor, "AIPI-1");
    expect(() => heartbeatLease(db, next.issue.id, nextActor.id, next.leaseToken)).not.toThrow();
  });

  it("retires a claim moved to todo even when the human preserves its assignee", () => {
    const first = claimIssue(db, agent, "AIPI-1");
    updateIssue(db, human, "AIPI-1", { status: "todo", assigneeName: agent.name });
    expect(getActiveLease(db, first.issue.id)).toBeNull();
    expect(() => heartbeatLease(db, first.issue.id, agent.id, first.leaseToken)).toThrow();
  });
});
