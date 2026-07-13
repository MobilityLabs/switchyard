import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type Db } from "../../src/db/index.js";
import { claimLeases, issues, events } from "../../src/db/schema.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue, getIssue } from "../../src/services/issues.js";
import { expireLeases, invalidateLease, getActiveLease } from "../../src/services/leases.js";
import { releaseStaleClaims } from "../../src/services/stale-claims.js";
import { listIssueEvents } from "../../src/services/events.js";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "AIPI", name: "aipi" });
});

/** Claim AIPI-1 (claimIssue mints its lease), then force that lease expired. */
function claimThenExpireLease(): number {
  createIssue(db, human, { projectKey: "AIPI", title: "t" });
  updateIssue(db, human, "AIPI-1", { status: "todo" });
  claimIssue(db, agent, "AIPI-1");
  const id = getIssue(db, "AIPI-1").id;
  db.update(claimLeases).set({ expiresAt: 1 }).where(eq(claimLeases.issueId, id)).run();
  return id;
}

describe("expireLeases", () => {
  it("releases an issue whose lease expired, recording claim_released{lease_expired}", () => {
    const id = claimThenExpireLease();
    expect(expireLeases(db)).toBe(1);
    const after = getIssue(db, "AIPI-1");
    expect(after.status).toBe("todo");
    expect(after.assigneeId).toBeNull();
    const last = listIssueEvents(db, id).at(-1)!;
    expect(last.type).toBe("claim_released");
    expect(last.payload).toMatchObject({ reason: "lease_expired" });
    expect(getActiveLease(db, id)).toBeNull();
    expect(expireLeases(db)).toBe(0); // idempotent — lease now invalidated
  });

  it("does not sweep within the server-uptime grace window after a restart (SYD-210 Layer B)", () => {
    const id = claimThenExpireLease();
    const now = Math.floor(Date.now() / 1000);
    // server just came up (within the 600s heartbeat window): a correlated
    // redeploy outage must not mass-expire live leases before they re-heartbeat.
    expect(expireLeases(db, now, now - 60)).toBe(0);
    expect(getIssue(db, "AIPI-1").status).toBe("in_progress");
    // once the server has been up longer than the window, expiry resumes.
    expect(expireLeases(db, now, now - 601)).toBe(1);
    expect(getIssue(db, "AIPI-1").status).toBe("todo");
  });

  it("leaves a still-valid lease alone", () => {
    createIssue(db, human, { projectKey: "AIPI", title: "t" });
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimIssue(db, agent, "AIPI-1");
    const id = getIssue(db, "AIPI-1").id;
    expect(expireLeases(db)).toBe(0);
    expect(getIssue(db, "AIPI-1").status).toBe("in_progress");
  });

  it("does not release when the issue moved on before the sweep landed (race)", () => {
    const id = claimThenExpireLease();
    db.update(issues).set({ status: "in_review" }).where(eq(issues.id, id)).run();
    expect(expireLeases(db)).toBe(0);
    expect(getIssue(db, "AIPI-1").status).toBe("in_review");
    const types = listIssueEvents(db, id).map((e) => e.type);
    expect(types).not.toContain("claim_released");
  });

  it("invalidateLease marks the active lease and is a no-op when none", () => {
    createIssue(db, human, { projectKey: "AIPI", title: "t" });
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimIssue(db, agent, "AIPI-1");
    const id = getIssue(db, "AIPI-1").id;
    invalidateLease(db, id);
    expect(getActiveLease(db, id)).toBeNull();
    expect(() => invalidateLease(db, id)).not.toThrow();
  });

  it("releaseStaleClaims skips a leased claim (leases own expiry now)", () => {
    createIssue(db, human, { projectKey: "AIPI", title: "t" });
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimIssue(db, agent, "AIPI-1");
    const id = getIssue(db, "AIPI-1").id;
    // age all events past the 4h idle window, but the lease is still valid
    db.update(events)
      .set({ createdAt: Math.floor(Date.now() / 1000) - 5 * 3600 })
      .where(eq(events.issueId, id))
      .run();
    expect(releaseStaleClaims(db)).toBe(0); // would be 1 without the leased-skip
    expect(getIssue(db, "AIPI-1").status).toBe("in_progress");
  });
});
