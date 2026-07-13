import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue, getIssue } from "../../src/services/issues.js";
import { getActiveLease, heartbeatLease } from "../../src/services/leases.js";
import { getSetting } from "../../src/services/settings.js";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "AIPI", name: "aipi" });
  createIssue(db, human, { projectKey: "AIPI", title: "t" });
  updateIssue(db, human, "AIPI-1", { status: "todo" });
});

describe("heartbeatLease", () => {
  it("defaults heartbeat_window_seconds to 600 (= N x interval)", () => {
    expect(getSetting(db, "claims.heartbeat_window_seconds")).toBe(600);
  });

  it("renews expires_at to now + heartbeat window (shorter than the 8h mint) and bumps last_beat_at", () => {
    const { leaseToken } = claimIssue(db, agent, "AIPI-1");
    const id = getIssue(db, "AIPI-1").id;
    const minted = getActiveLease(db, id)!;
    // the mint used the 8h interactive TTL
    expect(minted.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 7 * 3600);

    const beat = heartbeatLease(db, id, agent.id, leaseToken);
    const window = getSetting(db, "claims.heartbeat_window_seconds");
    const now = Math.floor(Date.now() / 1000);
    // a heartbeat collapses the window to ~10 min of honest liveness
    expect(beat.expiresAt).toBeLessThanOrEqual(now + window);
    expect(beat.expiresAt).toBeGreaterThan(now + window - 5);
    expect(beat.expiresAt).toBeLessThan(minted.expiresAt);
    expect(beat.lastBeatAt).toBeGreaterThanOrEqual(minted.lastBeatAt);
  });

  it("rejects a wrong, absent, or non-holder token", () => {
    const { leaseToken } = claimIssue(db, agent, "AIPI-1");
    const id = getIssue(db, "AIPI-1").id;
    expect(() => heartbeatLease(db, id, agent.id, "lease_wrong")).toThrow();
    expect(() => heartbeatLease(db, id, agent.id, undefined)).toThrow();
    expect(() => heartbeatLease(db, id, human.id, leaseToken)).toThrow(); // actor mismatch
  });
});
