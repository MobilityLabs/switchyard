import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type Db } from "../../src/db/index.js";
import { claimLeases, events, issues } from "../../src/db/schema.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue, getIssue } from "../../src/services/issues.js";
import { listIssueEvents } from "../../src/services/events.js";
import { releaseStaleClaims } from "../../src/services/stale-claims.js";
import { setSetting } from "../../src/services/settings.js";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "AIPI", name: "aipi" });
});

function ageAllEvents(db: Db, issueId: number, secondsAgo: number) {
  const old = Math.floor(Date.now() / 1000) - secondsAgo;
  db.update(events).set({ createdAt: old }).where(eq(events.issueId, issueId)).run();
}

// SYD-210: releaseStaleClaims is now the LEGACY idle-release path for
// lease-LESS claims only (leased claims are governed by expireLeases). These
// tests exercise that legacy path, so they claim then strip the lease to model
// a pre-cutover / lease-less in_progress claim.
function claimLeaseless(ref: string) {
  const { issue } = claimIssue(db, agent, ref);
  db.delete(claimLeases).where(eq(claimLeases.issueId, issue.id)).run();
  return issue;
}

// Set the needs-input flag directly (bypassing requestHumanInput, which
// requires a live lease token) — these tests only need the flag as a
// precondition; the escalation path itself is covered in needs-input.test.ts.
function flagNeedsInput(issueId: number) {
  db.update(issues).set({ needsInput: true }).where(eq(issues.id, issueId)).run();
}

describe("releaseStaleClaims", () => {
  it("releases an in_progress issue whose newest event is older than the idle window", () => {
    createIssue(db, human, { projectKey: "AIPI", title: "Ship v1" });
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimLeaseless("AIPI-1");
    const issue = getIssue(db, "AIPI-1");
    ageAllEvents(db, issue.id, 5 * 3600); // 5h old, past the 4h default

    const released = releaseStaleClaims(db);
    expect(released).toBe(1);

    const after = getIssue(db, "AIPI-1");
    expect(after.status).toBe("todo");
    expect(after.assigneeId).toBeNull();

    const types = listIssueEvents(db, issue.id).map((e) => e.type);
    expect(types.at(-1)).toBe("claim_released");
    const releaseEvent = listIssueEvents(db, issue.id).at(-1)!;
    expect(releaseEvent.payload).toMatchObject({ idleSeconds: expect.any(Number) });
    expect((releaseEvent.payload as { idleSeconds: number }).idleSeconds).toBeGreaterThanOrEqual(
      5 * 3600,
    );
    expect(releaseEvent.actorName).toBe("claude/worker"); // attributed to assignee
  });

  it("leaves a fresh in_progress issue untouched", () => {
    createIssue(db, human, { projectKey: "AIPI", title: "Ship v1" });
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimLeaseless("AIPI-1");
    // events are fresh (just created), well within the default 4h window

    const released = releaseStaleClaims(db);
    expect(released).toBe(0);

    const after = getIssue(db, "AIPI-1");
    expect(after.status).toBe("in_progress");
    expect(after.assigneeId).toBe(agent.id);
  });

  it("leaves non-in_progress issues untouched even if stale", () => {
    createIssue(db, human, { projectKey: "AIPI", title: "Ship v1" });
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    const issue = getIssue(db, "AIPI-1");
    ageAllEvents(db, issue.id, 5 * 3600);

    const released = releaseStaleClaims(db);
    expect(released).toBe(0);
    expect(getIssue(db, "AIPI-1").status).toBe("todo");
  });

  it("attributes claim_released to the creator when unassigned somehow", () => {
    createIssue(db, human, { projectKey: "AIPI", title: "Ship v1" });
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimLeaseless("AIPI-1");
    const issue = getIssue(db, "AIPI-1");
    // manually clear assignee while keeping status in_progress, to exercise the creator fallback
    updateIssue(db, human, "AIPI-1", { assigneeName: null });
    ageAllEvents(db, issue.id, 5 * 3600);

    releaseStaleClaims(db);
    const releaseEvent = listIssueEvents(db, issue.id).at(-1)!;
    expect(releaseEvent.type).toBe("claim_released");
    expect(releaseEvent.actorName).toBe("sean"); // fell back to creator
  });

  it("leaves a stale in_progress issue untouched when needsInput is set", () => {
    createIssue(db, human, { projectKey: "AIPI", title: "Ship v1" });
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimLeaseless("AIPI-1");
    const issue = getIssue(db, "AIPI-1");
    flagNeedsInput(issue.id);
    expect(getIssue(db, "AIPI-1").needsInput).toBe(true);
    ageAllEvents(db, issue.id, 5 * 3600); // 5h old, past the 4h default

    const released = releaseStaleClaims(db);
    expect(released).toBe(0);

    const after = getIssue(db, "AIPI-1");
    expect(after.status).toBe("in_progress");
    expect(after.assigneeId).toBe(agent.id);
    expect(after.needsInput).toBe(true);
  });

  it("does not release an issue that escalated (needsInput) between the outer read and the update transaction", () => {
    createIssue(db, human, { projectKey: "AIPI", title: "Ship v1" });
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimLeaseless("AIPI-1");
    const issue = getIssue(db, "AIPI-1");
    ageAllEvents(db, issue.id, 5 * 3600);

    // Simulate a second writer landing between releaseStaleClaims' outer read
    // (which saw needsInput=false and decided to release) and its per-issue
    // UPDATE transaction: the agent escalates right before the release lands.
    const originalTransaction = db.transaction.bind(db);
    const spy = vi
      .spyOn(db, "transaction")
      .mockImplementationOnce((cb: Parameters<typeof db.transaction>[0]) => {
        flagNeedsInput(issue.id);
        return originalTransaction(cb);
      });

    const released = releaseStaleClaims(db);
    spy.mockRestore();

    expect(released).toBe(0);
    const after = getIssue(db, "AIPI-1");
    expect(after.status).toBe("in_progress");
    expect(after.needsInput).toBe(true);
    expect(after.assigneeId).toBe(agent.id);
    const types = listIssueEvents(db, issue.id).map((e) => e.type);
    expect(types).not.toContain("claim_released");
  });

  it("does not release an issue whose status changed between the outer read and the update transaction", () => {
    createIssue(db, human, { projectKey: "AIPI", title: "Ship v1" });
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimLeaseless("AIPI-1");
    const issue = getIssue(db, "AIPI-1");
    ageAllEvents(db, issue.id, 5 * 3600);

    // Simulate a second writer (e.g. src/cli.ts on its own connection) moving
    // the issue to in_review right before releaseStaleClaims' UPDATE lands.
    const originalTransaction = db.transaction.bind(db);
    const spy = vi
      .spyOn(db, "transaction")
      .mockImplementationOnce((cb: Parameters<typeof db.transaction>[0]) => {
        db.update(issues).set({ status: "in_review" }).where(eq(issues.id, issue.id)).run();
        return originalTransaction(cb);
      });

    const released = releaseStaleClaims(db);
    spy.mockRestore();

    expect(released).toBe(0);
    const after = getIssue(db, "AIPI-1");
    expect(after.status).toBe("in_review");
    expect(after.assigneeId).toBe(agent.id);
    const types = listIssueEvents(db, issue.id).map((e) => e.type);
    expect(types).not.toContain("claim_released");
  });

  it("respects a lowered claims.stale_seconds setting (knob bite)", () => {
    createIssue(db, human, { projectKey: "AIPI", title: "Ship v1" });
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimLeaseless("AIPI-1");
    const issue = getIssue(db, "AIPI-1");
    ageAllEvents(db, issue.id, 30); // fresh under the 4h default

    setSetting(db, human, "claims.stale_seconds", 10);
    expect(releaseStaleClaims(db)).toBe(1); // now stale under the lowered setting
    expect(getIssue(db, "AIPI-1").status).toBe("todo");
  });

  it("skips the sweep within the server-uptime grace window after a restart (SYD-210 review)", () => {
    createIssue(db, human, { projectKey: "AIPI", title: "Ship v1" });
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimLeaseless("AIPI-1");
    const id = getIssue(db, "AIPI-1").id;
    ageAllEvents(db, id, 5 * 3600); // stale by the 4h default
    const now = Math.floor(Date.now() / 1000);
    // just restarted (within the 600s heartbeat window): do not release — a
    // correlated restart must not let the legacy stale sweep release either.
    expect(releaseStaleClaims(db, undefined, now - 60)).toBe(0);
    expect(getIssue(db, "AIPI-1").status).toBe("in_progress");
    // past the grace window: the legacy sweep resumes.
    expect(releaseStaleClaims(db, undefined, now - 601)).toBe(1);
    expect(getIssue(db, "AIPI-1").status).toBe("todo");
  });

  it("respects a custom maxIdleSeconds", () => {
    createIssue(db, human, { projectKey: "AIPI", title: "Ship v1" });
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimLeaseless("AIPI-1");
    const issue = getIssue(db, "AIPI-1");
    ageAllEvents(db, issue.id, 30);

    expect(releaseStaleClaims(db, 3600)).toBe(0);
    expect(releaseStaleClaims(db, 10)).toBe(1);
    expect(getIssue(db, "AIPI-1").status).toBe("todo");
  });
});
