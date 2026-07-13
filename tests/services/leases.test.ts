import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue } from "../../src/services/issues.js";
import { getActiveLease, mintLease, validateLease } from "../../src/services/leases.js";
import { getSetting } from "../../src/services/settings.js";

let db: Db, human: Actor, agent: Actor, issueId: number;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "AIPI", name: "aipi" });
  issueId = createIssue(db, human, { projectKey: "AIPI", title: "t" }).id;
});

describe("leases", () => {
  it("defaults lease_ttl_seconds to 8h", () => {
    expect(getSetting(db, "claims.lease_ttl_seconds")).toBe(8 * 3600);
  });

  it("mints a token, finds the active lease, and validates the minted token", () => {
    const token = mintLease(db, issueId, agent.id, 3600);
    expect(token).toMatch(/^lease_[0-9a-f]+$/);
    const active = getActiveLease(db, issueId);
    expect(active?.actorId).toBe(agent.id);
    expect(active?.tokenHash).not.toBe(token); // stored hashed, not plaintext
    expect(() => validateLease(db, issueId, agent.id, token)).not.toThrow();
  });

  it("rejects a wrong, absent, expired, or wrong-actor token", () => {
    const token = mintLease(db, issueId, agent.id, 3600);
    expect(() => validateLease(db, issueId, agent.id, "lease_deadbeef")).toThrow();
    expect(() => validateLease(db, issueId, agent.id, undefined)).toThrow();
    expect(() => validateLease(db, issueId, human.id, token)).toThrow(); // actor mismatch
    // expired: a fresh issue whose only lease was minted already-expired
    const other = createIssue(db, human, { projectKey: "AIPI", title: "other" }).id;
    const stale = mintLease(db, other, agent.id, -10);
    expect(getActiveLease(db, other)).toBeNull(); // past expires_at ⇒ not active
    expect(() => validateLease(db, other, agent.id, stale)).toThrow();
  });
});
