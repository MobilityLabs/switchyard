import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue, getIssue } from "../../src/services/issues.js";
import { validateLease, getActiveLease } from "../../src/services/leases.js";
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
});
