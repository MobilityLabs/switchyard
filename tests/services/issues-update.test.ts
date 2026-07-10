import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue, getIssue, SUMMARY_MAX_LENGTH } from "../../src/services/issues.js";
import { listIssueEvents } from "../../src/services/events.js";
import { requestHumanInput } from "../../src/services/needs-input.js";
import { recordDeliveryEvent } from "../../src/services/delivery-events.js";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, { key: "AIPI", name: "aipi" });
  createIssue(db, human, { projectKey: "AIPI", title: "Ship v1" });
});

describe("updateIssue", () => {
  it("applies field changes and records one event per changed field", () => {
    const updated = updateIssue(db, human, "AIPI-1", {
      status: "todo",
      priority: "high",
      assigneeName: "claude/worker",
    });
    expect(updated.status).toBe("todo");
    expect(updated.priority).toBe("high");
    expect(updated.assigneeId).toBe(agent.id);
    const types = listIssueEvents(db, updated.id).map((e) => e.type);
    expect(types).toEqual(["created", "status_changed", "priority_changed", "assigned"]);
  });

  it("rejects unknown statuses and assignees legibly", () => {
    expect(() => updateIssue(db, human, "AIPI-1", { status: "doing" as never }))
      .toThrowError(/valid statuses/i);
    expect(() => updateIssue(db, human, "AIPI-1", { assigneeName: "ghost" }))
      .toThrowError(/no actor named "ghost"/i);
  });

  it("no-op labels update records no event", () => {
    updateIssue(db, human, "AIPI-1", { labels: ["a"] });
    const before = listIssueEvents(db, getIssue(db, "AIPI-1").id).length;
    updateIssue(db, human, "AIPI-1", { labels: ["a"] });
    expect(listIssueEvents(db, getIssue(db, "AIPI-1").id)).toHaveLength(before);
  });

  it("reordered-but-identical labels record no event, but a real change does", () => {
    updateIssue(db, human, "AIPI-1", { labels: ["a", "b"] });
    const afterInitial = listIssueEvents(db, getIssue(db, "AIPI-1").id).length;
    updateIssue(db, human, "AIPI-1", { labels: ["b", "a"] });
    expect(listIssueEvents(db, getIssue(db, "AIPI-1").id)).toHaveLength(afterInitial);
    updateIssue(db, human, "AIPI-1", { labels: ["a", "c"] });
    expect(listIssueEvents(db, getIssue(db, "AIPI-1").id)).toHaveLength(afterInitial + 1);
  });

  it("rejects unknown priorities legibly", () => {
    expect(() => updateIssue(db, human, "AIPI-1", { priority: "mega" as never }))
      .toThrowError(/valid priorities/i);
  });

  it("agents cannot move issues out of triage; humans can", () => {
    const filed = createIssue(db, agent, {
      projectKey: "AIPI", title: "Agent-filed",
      description: "Filed while working another task; needs a human to confirm priority before scheduling.",
      provenance: { sourceType: "manual", detail: "x" },
    });
    // non-status edits by agents are still allowed in triage
    expect(updateIssue(db, agent, filed.ref, { priority: "high" }).priority).toBe("high");
    expect(() => updateIssue(db, agent, filed.ref, { status: "todo" }))
      .toThrowError(/only humans move issues out of triage/i);
    expect(() => claimIssue(db, agent, filed.ref))
      .toThrowError(/only humans move issues out of triage/i);
    expect(updateIssue(db, human, filed.ref, { status: "todo" }).status).toBe("todo");
  });

  it("agents cannot move issues to done; humans can", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimIssue(db, agent, "AIPI-1");
    updateIssue(db, agent, "AIPI-1", { status: "in_review" });
    expect(() => updateIssue(db, agent, "AIPI-1", { status: "done" }))
      .toThrowError(/only humans move issues to done/i);
    expect(getIssue(db, "AIPI-1").status).toBe("in_review");
    expect(updateIssue(db, human, "AIPI-1", { status: "done" }).status).toBe("done");
  });

  it("agents cannot add the auto label, but may remove it or keep it", () => {
    // starting without "auto": agent adding it is rejected
    updateIssue(db, human, "AIPI-1", { labels: ["urgent"] });
    expect(() => updateIssue(db, agent, "AIPI-1", { labels: ["auto", "urgent"] }))
      .toThrowError(/only humans apply the "auto" label/i);
    expect(getIssue(db, "AIPI-1").labels).toEqual(["urgent"]);

    // a human adding it is fine
    expect(updateIssue(db, human, "AIPI-1", { labels: ["auto", "urgent"] }).labels.sort())
      .toEqual(["auto", "urgent"]);

    // agent removing it is fine
    expect(updateIssue(db, agent, "AIPI-1", { labels: ["urgent"] }).labels).toEqual(["urgent"]);

    // agent keeping an already-present "auto" while changing other labels is fine
    updateIssue(db, human, "AIPI-1", { labels: ["auto", "urgent"] });
    expect(updateIssue(db, agent, "AIPI-1", { labels: ["auto", "other"] }).labels.sort())
      .toEqual(["auto", "other"]);
  });

  it("sets, updates, and clears the summary; rejects one over the length cap", () => {
    expect(updateIssue(db, human, "AIPI-1", { summary: "Ship v1 to prod." }).summary)
      .toBe("Ship v1 to prod.");
    expect(updateIssue(db, human, "AIPI-1", { summary: null }).summary).toBeNull();

    const tooLong = "x".repeat(SUMMARY_MAX_LENGTH + 1);
    expect(() => updateIssue(db, human, "AIPI-1", { summary: tooLong })).toThrowError(/summary/i);
    expect(getIssue(db, "AIPI-1").summary).toBeNull();
  });

  it("needs_input clears only on a status change, not on unrelated field edits", () => {
    const filed = createIssue(db, agent, {
      projectKey: "AIPI", title: "Needs a call",
      description: "Blocked on a decision only a human can make about scope.",
      provenance: { sourceType: "manual", detail: "x" },
    });
    updateIssue(db, human, filed.ref, { status: "todo" });
    requestHumanInput(db, agent, filed.ref, "Which scope should this cover?");
    expect(getIssue(db, filed.ref).needsInput).toBe(true);

    // priority/label/title-only edits by a human must NOT clear needsInput
    updateIssue(db, human, filed.ref, { priority: "high" });
    expect(getIssue(db, filed.ref).needsInput).toBe(true);
    updateIssue(db, human, filed.ref, { labels: ["x"] });
    expect(getIssue(db, filed.ref).needsInput).toBe(true);
    updateIssue(db, human, filed.ref, { title: "Needs a call (updated)" });
    expect(getIssue(db, filed.ref).needsInput).toBe(true);

    // a status change by a human does clear it
    updateIssue(db, human, filed.ref, { status: "in_progress" });
    expect(getIssue(db, filed.ref).needsInput).toBe(false);
  });
});

describe("claimIssue", () => {
  it("assigns the caller and moves to in_progress", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    const claimed = claimIssue(db, agent, "AIPI-1");
    expect(claimed.assigneeId).toBe(agent.id);
    expect(claimed.status).toBe("in_progress");
    expect(getIssue(db, "AIPI-1").status).toBe("in_progress");
  });

  it("re-claiming your own issue is a no-op success, not a collision", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimIssue(db, agent, "AIPI-1");
    expect(claimIssue(db, agent, "AIPI-1").assigneeId).toBe(agent.id);
  });

  // SYD-99: SYD-93 got fixed twice in parallel (worker PR #41 vs a
  // coordinating session's PR #42) because nothing stopped a second claim on
  // an issue already spoken for. These are the regression tests for the fix.
  it("refuses to claim an issue already claimed by a different actor", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    const other = createActor(db, { name: "claude/other", type: "agent" }).actor;
    claimIssue(db, agent, "AIPI-1");
    expect(() => claimIssue(db, other, "AIPI-1")).toThrowError(/already claimed by claude\/worker/i);
    expect(getIssue(db, "AIPI-1").assigneeId).toBe(agent.id);
  });

  it("refuses to claim an issue with an open PR, even after the claim was released back to todo", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimIssue(db, agent, "AIPI-1");
    recordDeliveryEvent(db, agent, "AIPI-1", {
      type: "pr_opened", prNumber: 41, url: "https://github.com/acme/widgets/pull/41",
    });
    // Simulate a stale-claim release: back to todo, assignee cleared, PR still open.
    updateIssue(db, human, "AIPI-1", { status: "todo", assigneeName: null });

    const other = createActor(db, { name: "claude/other", type: "agent" }).actor;
    expect(() => claimIssue(db, other, "AIPI-1")).toThrowError(/open PR \(#41/i);
    expect(getIssue(db, "AIPI-1").status).toBe("todo");
  });

  it("a direct PATCH to in_progress by an agent is refused the same way claim_issue is", () => {
    // Assigned but still `todo` — e.g. a human pre-assigned it directly — so
    // the in_progress transition below is what actually exercises the gate.
    updateIssue(db, human, "AIPI-1", { status: "todo", assigneeName: "claude/worker" });
    const other = createActor(db, { name: "claude/other", type: "agent" }).actor;
    expect(() => updateIssue(db, other, "AIPI-1", { status: "in_progress" }))
      .toThrowError(/already claimed by claude\/worker/i);
    expect(getIssue(db, "AIPI-1").status).toBe("todo");
  });

  it("a human PATCHing straight to in_progress can still deliberately override an existing claim", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo", assigneeName: "claude/worker" });
    const moved = updateIssue(db, human, "AIPI-1", { status: "in_progress" });
    expect(moved.status).toBe("in_progress");
    expect(moved.assigneeId).toBe(agent.id); // human overrode the gate, didn't reassign
  });
});
