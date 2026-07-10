import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue } from "../../src/services/issues.js";
import {
  addDependency,
  getOpenBlockers,
  listBlockedIssueIds,
  listDependencies,
  nextTask,
  removeDependency,
} from "../../src/services/dependencies.js";
import { listIssueEvents } from "../../src/services/events.js";
import { recordDeliveryEvent } from "../../src/services/delivery-events.js";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, { key: "AIPI", name: "aipi" });
  createIssue(db, human, { projectKey: "AIPI", title: "Schema", priority: "high" });   // AIPI-1
  createIssue(db, human, { projectKey: "AIPI", title: "API", priority: "urgent" });    // AIPI-2
  createIssue(db, human, { projectKey: "AIPI", title: "Docs", priority: "low" });      // AIPI-3
  for (const ref of ["AIPI-1", "AIPI-2", "AIPI-3"]) updateIssue(db, human, ref, { status: "todo" });
});

describe("dependencies", () => {
  it("blocked issues cannot be claimed until the blocker is done", () => {
    addDependency(db, human, "AIPI-1", "AIPI-2"); // schema blocks api
    expect(getOpenBlockers(db, 2).map((b) => b.ref)).toEqual(["AIPI-1"]);
    expect(() => claimIssue(db, agent, "AIPI-2"))
      .toThrowError(/blocked by AIPI-1.*next_task/s);
    updateIssue(db, human, "AIPI-1", { status: "done" });
    expect(claimIssue(db, agent, "AIPI-2").status).toBe("in_progress");
  });

  it("nextTask returns highest-priority unblocked todo, or null", () => {
    addDependency(db, human, "AIPI-1", "AIPI-2");
    expect(nextTask(db, agent)?.ref).toBe("AIPI-1"); // urgent AIPI-2 is blocked
    updateIssue(db, human, "AIPI-1", { status: "done" });
    expect(nextTask(db, agent)?.ref).toBe("AIPI-2");
    expect(nextTask(db, agent, "AIPI")?.ref).toBe("AIPI-2");
    for (const ref of ["AIPI-2", "AIPI-3"]) updateIssue(db, human, ref, { status: "done" });
    expect(nextTask(db, agent)).toBeNull();
  });

  it("listBlockedIssueIds returns ids of issues with an open blocker, cleared once the blocker closes (SYD-160)", () => {
    addDependency(db, human, "AIPI-1", "AIPI-2"); // AIPI-1 blocks AIPI-2
    addDependency(db, human, "AIPI-3", "AIPI-2"); // AIPI-3 also blocks AIPI-2 — still one id
    expect([...listBlockedIssueIds(db)]).toEqual([2]);
    updateIssue(db, human, "AIPI-1", { status: "done" });
    expect([...listBlockedIssueIds(db)]).toEqual([2]); // AIPI-3 still open
    updateIssue(db, human, "AIPI-3", { status: "canceled" });
    expect(listBlockedIssueIds(db).size).toBe(0);
  });

  it("nextTask skips issues assigned to someone else", () => {
    updateIssue(db, human, "AIPI-2", { assigneeName: "sean" });
    expect(nextTask(db, agent)?.ref).toBe("AIPI-1");
  });

  it("nextTask skips a todo issue with an open PR from a released prior claim (SYD-99)", () => {
    claimIssue(db, agent, "AIPI-2"); // urgent, would otherwise win
    recordDeliveryEvent(db, agent, "AIPI-2", { type: "pr_opened", prNumber: 41, url: "https://x/41" });
    updateIssue(db, human, "AIPI-2", { status: "todo", assigneeName: null }); // stale-claim release
    expect(nextTask(db, agent)?.ref).toBe("AIPI-1");
  });

  it("nextTask throws legibly for an unknown project key", () => {
    expect(() => nextTask(db, agent, "ZZ")).toThrowError(/no project with key "ZZ"/i);
  });

  it("re-adding the same dependency records exactly one blocked_by_added event", () => {
    addDependency(db, human, "AIPI-1", "AIPI-2");
    addDependency(db, human, "AIPI-1", "AIPI-2");
    const types = listIssueEvents(db, 2).filter((e) => e.type === "blocked_by_added");
    expect(types).toHaveLength(1);
  });

  it("rejects a direct cycle (A blocks B, then B blocks A)", () => {
    addDependency(db, human, "AIPI-1", "AIPI-2");
    expect(() => addDependency(db, human, "AIPI-2", "AIPI-1")).toThrowError(/cycle/i);
  });

  it("rejects a transitive cycle (A blocks B, B blocks C, then C blocks A)", () => {
    addDependency(db, human, "AIPI-1", "AIPI-2");
    addDependency(db, human, "AIPI-2", "AIPI-3");
    expect(() => addDependency(db, human, "AIPI-3", "AIPI-1")).toThrowError(/cycle/i);
  });

  it("listDependencies returns both directions with ref, title, and status", () => {
    addDependency(db, human, "AIPI-1", "AIPI-2"); // schema blocks api
    addDependency(db, human, "AIPI-2", "AIPI-3"); // api blocks docs
    expect(listDependencies(db, "AIPI-2")).toEqual({
      blockedBy: [{ ref: "AIPI-1", title: "Schema", status: "todo" }],
      blocks: [{ ref: "AIPI-3", title: "Docs", status: "todo" }],
    });
    expect(listDependencies(db, "AIPI-3")).toEqual({
      blockedBy: [{ ref: "AIPI-2", title: "API", status: "todo" }],
      blocks: [],
    });
  });

  it("removeDependency deletes the edge and records blocked_by_removed on the blocked issue", () => {
    addDependency(db, human, "AIPI-1", "AIPI-2");
    removeDependency(db, human, "AIPI-1", "AIPI-2");
    expect(listDependencies(db, "AIPI-2").blockedBy).toEqual([]);
    const types = listIssueEvents(db, 2).map((e) => e.type);
    expect(types.filter((t) => t === "blocked_by_removed")).toHaveLength(1);
    // The issue is claimable again.
    expect(claimIssue(db, agent, "AIPI-2").status).toBe("in_progress");
  });

  it("removing a dependency that does not exist is a no-op with no event", () => {
    removeDependency(db, human, "AIPI-1", "AIPI-2");
    expect(listIssueEvents(db, 2).some((e) => e.type === "blocked_by_removed")).toBe(false);
  });

  it("agents cannot remove a dependency — removal would defeat a human's gate", () => {
    addDependency(db, human, "AIPI-1", "AIPI-2");
    expect(() => removeDependency(db, agent, "AIPI-1", "AIPI-2")).toThrowError(/only humans/i);
    expect(listDependencies(db, "AIPI-2").blockedBy).toHaveLength(1);
    // Agents CAN still add — declaring a discovered blocker is intended.
    expect(() => addDependency(db, agent, "AIPI-2", "AIPI-3")).not.toThrow();
  });

  it("agents cannot PATCH a blocked issue straight to in_progress (same gate as claim)", () => {
    addDependency(db, human, "AIPI-1", "AIPI-2");
    expect(() => updateIssue(db, agent, "AIPI-2", { status: "in_progress" }))
      .toThrowError(/blocked by AIPI-1/);
    // Humans stay exempt, matching claim semantics for deliberate overrides.
    expect(updateIssue(db, human, "AIPI-2", { status: "in_progress" }).status).toBe("in_progress");
  });

  it("allows a diamond dependency shape", () => {
    createIssue(db, human, { projectKey: "AIPI", title: "D", priority: "low" }); // AIPI-4
    updateIssue(db, human, "AIPI-4", { status: "todo" });
    addDependency(db, human, "AIPI-1", "AIPI-2"); // A blocks B
    addDependency(db, human, "AIPI-1", "AIPI-3"); // A blocks C
    addDependency(db, human, "AIPI-2", "AIPI-4"); // B blocks D
    expect(() => addDependency(db, human, "AIPI-3", "AIPI-4")).not.toThrow(); // C blocks D
  });
});
