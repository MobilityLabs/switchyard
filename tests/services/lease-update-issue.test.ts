import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, getIssue } from "../../src/services/issues.js";
import { getActiveLease } from "../../src/services/leases.js";
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
});
