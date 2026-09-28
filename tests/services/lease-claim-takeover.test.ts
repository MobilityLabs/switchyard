import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { claimLeases } from "../../src/db/schema.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue, getIssue } from "../../src/services/issues.js";
import { validateLease, getActiveLease } from "../../src/services/leases.js";
import { listIssueEvents } from "../../src/services/events.js";
import { nextTask } from "../../src/services/dependencies.js";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "AIPI", name: "aipi" });
  createIssue(db, human, { projectKey: "AIPI", title: "t" });
  updateIssue(db, human, "AIPI-1", { status: "todo" });
});

describe("claimIssue leases + takeover", () => {
  it("returns a fresh lease token that validates", () => {
    const { issue, leaseToken } = claimIssue(db, agent, "AIPI-1");
    expect(issue.status).toBe("in_progress");
    expect(leaseToken).toMatch(/^lease_/);
    expect(() => validateLease(db, issue.id, agent.id, leaseToken)).not.toThrow();
  });

  it("fails loudly on a bare same-actor re-claim of an actively-leased issue", () => {
    claimIssue(db, agent, "AIPI-1");
    expect(() => claimIssue(db, agent, "AIPI-1")).toThrow(/takeover/i);
  });

  it("takeover:true invalidates the old lease, records lease_taken_over, and evicts the old holder", () => {
    const first = claimIssue(db, agent, "AIPI-1").leaseToken;
    const id = getIssue(db, "AIPI-1").id;
    const second = claimIssue(db, agent, "AIPI-1", { takeover: true }).leaseToken;
    expect(second).not.toBe(first);
    // old token no longer validates; new one does
    expect(() => validateLease(db, id, agent.id, first)).toThrow();
    expect(() => validateLease(db, id, agent.id, second)).not.toThrow();
    // evicted holder's next lease-gated call is rejected immediately
    expect(() =>
      updateIssue(db, agent, "AIPI-1", { status: "in_review" }, { presented: first }),
    ).toThrow();
    expect(listIssueEvents(db, id).map((e) => e.type)).toContain("lease_taken_over");
    // exactly one active lease
    expect(getActiveLease(db, id)?.tokenHash).toBeTruthy();
  });

  it("starts a preassigned todo issue and records its transition", () => {
    updateIssue(db, human, "AIPI-1", { assigneeName: agent.name });
    const claimed = claimIssue(db, agent, "AIPI-1");
    expect(claimed.issue).toMatchObject({ status: "in_progress", assigneeId: agent.id });
    expect(nextTask(db, agent)).toBeNull();
    expect(() => validateLease(db, claimed.issue.id, agent.id, claimed.leaseToken)).not.toThrow();
    expect(listIssueEvents(db, claimed.issue.id).at(-1)).toMatchObject({
      type: "status_changed",
      payload: { from: "todo", to: "in_progress" },
    });
    expect(() =>
      updateIssue(db, agent, "AIPI-1", { status: "in_review" }, { presented: claimed.leaseToken }),
    ).not.toThrow();
  });

  it("takes over review work by applying the permitted transition back to in_progress", () => {
    const first = claimIssue(db, agent, "AIPI-1");
    updateIssue(db, agent, "AIPI-1", { status: "in_review" }, { presented: first.leaseToken });
    const next = claimIssue(db, agent, "AIPI-1", { takeover: true });
    expect(next.issue.status).toBe("in_progress");
    expect(() => validateLease(db, first.issue.id, agent.id, first.leaseToken)).toThrow();
    expect(() => validateLease(db, next.issue.id, agent.id, next.leaseToken)).not.toThrow();
    expect(listIssueEvents(db, next.issue.id)).toContainEqual(
      expect.objectContaining({
        type: "status_changed",
        payload: { from: "in_review", to: "in_progress" },
      }),
    );
  });

  it.each(["backlog", "triage", "done", "canceled"] as const)(
    "refuses an agent claim on preassigned %s without minting or recording anything",
    (status) => {
      updateIssue(db, human, "AIPI-1", { status, assigneeName: agent.name });
      const before = getIssue(db, "AIPI-1");
      const eventsBefore = listIssueEvents(db, before.id);
      expect(() => claimIssue(db, agent, "AIPI-1", { takeover: true })).toThrow();
      expect(getIssue(db, "AIPI-1")).toEqual(before);
      expect(listIssueEvents(db, before.id)).toEqual(eventsBefore);
      expect(db.select().from(claimLeases).all()).toEqual([]);
    },
  );

  it("keeps ordinary human transition permissions on a preassigned issue", () => {
    updateIssue(db, human, "AIPI-1", { status: "done", assigneeName: human.name });
    expect(claimIssue(db, human, "AIPI-1").issue.status).toBe("in_progress");
  });

  it("rolls back lease rotation when a takeover would reopen a done issue", () => {
    const first = claimIssue(db, agent, "AIPI-1");
    updateIssue(db, human, "AIPI-1", { status: "done" });
    const leasesBefore = db.select().from(claimLeases).all();
    const eventsBefore = listIssueEvents(db, first.issue.id);
    expect(() => claimIssue(db, agent, "AIPI-1", { takeover: true })).toThrow(/only humans reopen/);
    expect(getIssue(db, "AIPI-1").status).toBe("done");
    expect(db.select().from(claimLeases).all()).toEqual(leasesBefore);
    expect(listIssueEvents(db, first.issue.id)).toEqual(eventsBefore);
    expect(() => validateLease(db, first.issue.id, agent.id, first.leaseToken)).not.toThrow();
  });

  it("does not let a preassigned service actor bypass the issue mutation guard", () => {
    const service = createActor(db, { name: "poller", type: "service" }).actor;
    updateIssue(db, human, "AIPI-1", { assigneeName: service.name });
    expect(() => claimIssue(db, service, "AIPI-1")).toThrow(/cannot modify issues/);
    expect(getIssue(db, "AIPI-1").status).toBe("todo");
    expect(db.select().from(claimLeases).all()).toEqual([]);
  });
});
