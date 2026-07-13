import { describe, it, expect, beforeEach, vi } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import {
  createIssue,
  updateIssue,
  claimIssue,
  getIssue,
  SUMMARY_MAX_LENGTH,
} from "../../src/services/issues.js";
import { listIssueEvents } from "../../src/services/events.js";
import { requestHumanInput } from "../../src/services/needs-input.js";
import { recordDeliveryEvent } from "../../src/services/delivery-events.js";
import { addGithubRepo } from "../../src/services/github-repos.js";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "AIPI", name: "aipi" });
  // Bound repo so recordDeliveryEvent's publish writes pr_state — post-SYD-207
  // the claim gate reads pr_state, not events.
  addGithubRepo(db, human, { fullName: "acme/widgets", projectKey: "AIPI" });
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

  it("releases the claim when an issue moves (back) to todo (symmetric with the in_progress auto-claim)", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimIssue(db, agent, "AIPI-1");
    expect(getIssue(db, "AIPI-1").assigneeId).toBe(agent.id);
    expect(getIssue(db, "AIPI-1").status).toBe("in_progress");

    const released = updateIssue(db, agent, "AIPI-1", { status: "todo" });
    expect(released.status).toBe("todo");
    expect(released.assigneeId).toBe(null);
    expect(listIssueEvents(db, released.id).map((e) => e.type)).toContain("claim_released");
  });

  it("keeps an explicit assignee when the same todo patch also sets one", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimIssue(db, agent, "AIPI-1");
    // Explicit reassignment in the same patch wins over the auto-release.
    const r = updateIssue(db, human, "AIPI-1", { status: "todo", assigneeName: "claude/worker" });
    expect(r.status).toBe("todo");
    expect(r.assigneeId).toBe(agent.id);
  });

  it("stores workerPreference on create and records an event only when it changes (SYD-201)", () => {
    const created = createIssue(db, human, {
      projectKey: "AIPI",
      title: "codex task",
      workerPreference: "codex",
    });
    expect(created.workerPreference).toBe("codex");

    const updated = updateIssue(db, human, created.ref, { workerPreference: "claude" });
    expect(updated.workerPreference).toBe("claude");
    expect(listIssueEvents(db, updated.id).map((e) => e.type)).toContain("worker_preference_changed");

    // Re-setting the same value is a no-op (no second event).
    updateIssue(db, human, created.ref, { workerPreference: "claude" });
    const changes = listIssueEvents(db, created.id).filter(
      (e) => e.type === "worker_preference_changed",
    );
    expect(changes).toHaveLength(1);
  });

  it("rejects unknown statuses and assignees legibly", () => {
    expect(() => updateIssue(db, human, "AIPI-1", { status: "doing" as never })).toThrowError(
      /valid statuses/i,
    );
    expect(() => updateIssue(db, human, "AIPI-1", { assigneeName: "ghost" })).toThrowError(
      /no actor named "ghost"/i,
    );
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
    expect(() => updateIssue(db, human, "AIPI-1", { priority: "mega" as never })).toThrowError(
      /valid priorities/i,
    );
  });

  it("agents cannot move issues out of triage; humans can", () => {
    const filed = createIssue(db, agent, {
      projectKey: "AIPI",
      title: "Agent-filed",
      description:
        "Filed while working another task; needs a human to confirm priority before scheduling.",
      provenance: { sourceType: "manual", detail: "x" },
    });
    // non-status edits by agents are still allowed in triage
    expect(updateIssue(db, agent, filed.ref, { priority: "high" }).priority).toBe("high");
    expect(() => updateIssue(db, agent, filed.ref, { status: "todo" })).toThrowError(
      /only humans move issues out of triage/i,
    );
    expect(() => claimIssue(db, agent, filed.ref)).toThrowError(
      /only humans move issues out of triage/i,
    );
    expect(updateIssue(db, human, filed.ref, { status: "todo" }).status).toBe("todo");
  });

  it("agents cannot move issues to done; humans can", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimIssue(db, agent, "AIPI-1");
    updateIssue(db, agent, "AIPI-1", { status: "in_review" });
    expect(() => updateIssue(db, agent, "AIPI-1", { status: "done" })).toThrowError(
      /only humans move issues to done/i,
    );
    expect(getIssue(db, "AIPI-1").status).toBe("in_review");
    expect(updateIssue(db, human, "AIPI-1", { status: "done" }).status).toBe("done");
  });

  it("agents cannot add the auto label, but may remove it or keep it", () => {
    // starting without "auto": agent adding it is rejected
    updateIssue(db, human, "AIPI-1", { labels: ["urgent"] });
    expect(() => updateIssue(db, agent, "AIPI-1", { labels: ["auto", "urgent"] })).toThrowError(
      /only humans apply the "auto" label/i,
    );
    expect(getIssue(db, "AIPI-1").labels).toEqual(["urgent"]);

    // a human adding it is fine
    expect(updateIssue(db, human, "AIPI-1", { labels: ["auto", "urgent"] }).labels.sort()).toEqual([
      "auto",
      "urgent",
    ]);

    // agent removing it is fine
    expect(updateIssue(db, agent, "AIPI-1", { labels: ["urgent"] }).labels).toEqual(["urgent"]);

    // agent keeping an already-present "auto" while changing other labels is fine
    updateIssue(db, human, "AIPI-1", { labels: ["auto", "urgent"] });
    expect(updateIssue(db, agent, "AIPI-1", { labels: ["auto", "other"] }).labels.sort()).toEqual([
      "auto",
      "other",
    ]);
  });

  it("sets, updates, and clears the summary; rejects one over the length cap", () => {
    expect(updateIssue(db, human, "AIPI-1", { summary: "Ship v1 to prod." }).summary).toBe(
      "Ship v1 to prod.",
    );
    expect(updateIssue(db, human, "AIPI-1", { summary: null }).summary).toBeNull();

    const tooLong = "x".repeat(SUMMARY_MAX_LENGTH + 1);
    expect(() => updateIssue(db, human, "AIPI-1", { summary: tooLong })).toThrowError(/summary/i);
    expect(getIssue(db, "AIPI-1").summary).toBeNull();
  });

  it("agents cannot push someone else's todo straight to in_review, skipping claim/PR machinery", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    // not a legal direct transition at all — an agent must claim (in_progress) first
    expect(() => updateIssue(db, agent, "AIPI-1", { status: "in_review" })).toThrowError(
      /can't move.*from "todo" to "in_review".*human-only/i,
    );
    expect(getIssue(db, "AIPI-1").status).toBe("todo");

    const other = createActor(db, { name: "claude/other", type: "agent" }).actor;
    claimIssue(db, agent, "AIPI-1");
    expect(() => updateIssue(db, other, "AIPI-1", { status: "in_review" })).toThrowError(
      /assigned to claude\/worker.*only the assignee/i,
    );
    expect(getIssue(db, "AIPI-1").status).toBe("in_progress");

    // the actual assignee can move it
    expect(updateIssue(db, agent, "AIPI-1", { status: "in_review" }).status).toBe("in_review");
  });

  it("agents cannot reopen a done issue; humans can", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimIssue(db, agent, "AIPI-1");
    updateIssue(db, agent, "AIPI-1", { status: "in_review" });
    updateIssue(db, human, "AIPI-1", { status: "done" });

    expect(() => updateIssue(db, agent, "AIPI-1", { status: "backlog" })).toThrowError(
      /is done — only humans reopen/i,
    );
    expect(getIssue(db, "AIPI-1").status).toBe("done");
    expect(updateIssue(db, human, "AIPI-1", { status: "backlog" }).status).toBe("backlog");
  });

  it("assignee-only transitions: only the assignee can release a claim or reopen for more work", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimIssue(db, agent, "AIPI-1");
    const other = createActor(db, { name: "claude/other", type: "agent" }).actor;

    // a different agent can't release someone else's claim
    expect(() => updateIssue(db, other, "AIPI-1", { status: "todo" })).toThrowError(
      /assigned to claude\/worker.*only the assignee/i,
    );
    // the assignee can release their own claim
    expect(updateIssue(db, agent, "AIPI-1", { status: "todo" }).status).toBe("todo");

    // reclaim and move to in_review, then only the assignee may reopen it
    claimIssue(db, agent, "AIPI-1");
    updateIssue(db, agent, "AIPI-1", { status: "in_review" });
    expect(() => updateIssue(db, other, "AIPI-1", { status: "in_progress" })).toThrowError(
      /assigned to claude\/worker.*only the assignee/i,
    );
    expect(updateIssue(db, agent, "AIPI-1", { status: "in_progress" }).status).toBe("in_progress");
  });

  it("agents are limited to an allow-list of transitions — arbitrary jumps are human-only", () => {
    // backlog is a human-triage state; agents can't self-promote out of it
    const filed = createIssue(db, human, { projectKey: "AIPI", title: "Sits in backlog" });
    expect(getIssue(db, filed.ref).status).toBe("backlog");
    expect(() => updateIssue(db, agent, filed.ref, { status: "todo" })).toThrowError(
      /can't move.*from "backlog" to "todo".*human-only/i,
    );

    // and agents can't cancel issues
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    expect(() => updateIssue(db, agent, "AIPI-1", { status: "canceled" })).toThrowError(
      /can't move.*human-only/i,
    );
  });

  it("needs_input clears only on a status change, not on unrelated field edits", () => {
    const filed = createIssue(db, agent, {
      projectKey: "AIPI",
      title: "Needs a call",
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

  // SYD-147: updatedAt used to be computed from the app's Date.now() rather
  // than the DB's own clock (the schema default's unixepoch()), a second
  // source of "now" that could drift. Fake the app clock to a wildly
  // different time and confirm updatedAt still reflects real time — SQLite's
  // unixepoch() reads the OS clock directly and is unaffected by vi's fake
  // timers, so this only passes if updatedAt is DB-computed.
  it("updatedAt comes from the DB clock, not the app clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2000-01-01T00:00:00Z"));
    try {
      const updated = updateIssue(db, human, "AIPI-1", { priority: "high" });
      expect(updated.updatedAt).toBeGreaterThan(946684800); // year-2000 epoch: proves it ignored the faked app clock
    } finally {
      vi.useRealTimers();
    }
  });
});

// SYD-191: update_issue exposed assigneeName to agent tokens with no actor
// check — an agent could reassign work to another actor or clear an existing
// assignee without claiming the issue, disrupting dispatch coordination and
// bypassing claim-before-work. Agents may only self-assign (the claimIssue
// flow), gated by the same claim rules; any other assignee change is human-only.
describe("agent assignee changes (SYD-191)", () => {
  it("an agent cannot reassign an issue assigned to someone else", () => {
    createActor(db, { name: "claude/other", type: "agent" });
    updateIssue(db, human, "AIPI-1", { status: "todo", assigneeName: "sean" });
    expect(() => updateIssue(db, agent, "AIPI-1", { assigneeName: "claude/other" })).toThrowError(
      /agents.*self-assign|human-only/i,
    );
    expect(getIssue(db, "AIPI-1").assigneeId).toBe(human.id);
  });

  it("an agent cannot assign an unassigned issue to a different actor", () => {
    createActor(db, { name: "claude/other", type: "agent" });
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    expect(() => updateIssue(db, agent, "AIPI-1", { assigneeName: "claude/other" })).toThrowError(
      /agents.*self-assign|human-only/i,
    );
    expect(getIssue(db, "AIPI-1").assigneeId).toBeNull();
  });

  it("an agent cannot clear an existing assignee", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo", assigneeName: "sean" });
    expect(() => updateIssue(db, agent, "AIPI-1", { assigneeName: null })).toThrowError(
      /human-only/i,
    );
    expect(getIssue(db, "AIPI-1").assigneeId).toBe(human.id);
  });

  it("a human can still reassign and clear assignees", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo", assigneeName: "claude/worker" });
    expect(updateIssue(db, human, "AIPI-1", { assigneeName: "sean" }).assigneeId).toBe(human.id);
    expect(updateIssue(db, human, "AIPI-1", { assigneeName: null }).assigneeId).toBeNull();
  });

  it("an agent may self-assign an unassigned issue (the claim_issue flow)", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    const r = updateIssue(db, agent, "AIPI-1", { assigneeName: "claude/worker" });
    expect(r.assigneeId).toBe(agent.id);
  });

  it("an agent cannot steal a claim by self-assigning an issue claimed by someone else", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    const other = createActor(db, { name: "claude/other", type: "agent" }).actor;
    claimIssue(db, other, "AIPI-1");
    expect(() => updateIssue(db, agent, "AIPI-1", { assigneeName: "claude/worker" })).toThrowError(
      /already claimed by claude\/other/i,
    );
    expect(getIssue(db, "AIPI-1").assigneeId).toBe(other.id);
  });

  it("an agent cannot self-assign an issue with an open PR from a prior claim", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimIssue(db, agent, "AIPI-1");
    recordDeliveryEvent(db, human, "AIPI-1", {
      type: "pr_opened",
      prNumber: 7,
      url: "https://github.com/acme/widgets/pull/7",
    });
    // Stale-claim release: back to todo, assignee cleared, PR still open.
    updateIssue(db, human, "AIPI-1", { status: "todo", assigneeName: null });
    const other = createActor(db, { name: "claude/other", type: "agent" }).actor;
    expect(() => updateIssue(db, other, "AIPI-1", { assigneeName: "claude/other" })).toThrowError(
      /open PR \(#7/i,
    );
    expect(getIssue(db, "AIPI-1").assigneeId).toBeNull();
  });

  it("a no-op assignee patch by an agent (already the assignee) still succeeds", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimIssue(db, agent, "AIPI-1");
    const r = updateIssue(db, agent, "AIPI-1", { assigneeName: "claude/worker" });
    expect(r.assigneeId).toBe(agent.id);
  });

  it("claim_issue still works end-to-end for agents (self-assign via updateIssue)", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    const claimed = claimIssue(db, agent, "AIPI-1");
    expect(claimed.assigneeId).toBe(agent.id);
    expect(claimed.status).toBe("in_progress");
  });
});

describe("audit log stays consistent with column state", () => {
  // SYD-127: events is a co-written audit log, not a fold/replay source —
  // nothing enforces agreement between it and the mutable issues columns
  // except that every service-layer mutation writes both. This asserts that
  // convention holds for status/priority/title, whose events do carry a
  // "to" payload (description_changed/summary_changed intentionally don't —
  // see issues.ts — so they're out of scope for this reconstruction check).
  it("replaying the last status/priority/title event matches the current column value", () => {
    updateIssue(db, human, "AIPI-1", {
      status: "todo",
      priority: "high",
      title: "Ship v1 (renamed)",
    });
    claimIssue(db, agent, "AIPI-1");
    updateIssue(db, agent, "AIPI-1", { status: "in_review", priority: "urgent" });

    const current = getIssue(db, "AIPI-1");
    const events = listIssueEvents(db, current.id);

    const lastToPayload = (type: string) =>
      [...events].reverse().find((e) => e.type === type)?.payload as { to?: unknown } | undefined;

    expect(lastToPayload("status_changed")?.to).toBe(current.status);
    expect(lastToPayload("priority_changed")?.to).toBe(current.priority);
    expect(lastToPayload("title_changed")?.to).toBe(current.title);
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
    expect(() => claimIssue(db, other, "AIPI-1")).toThrowError(
      /already claimed by claude\/worker/i,
    );
    expect(getIssue(db, "AIPI-1").assigneeId).toBe(agent.id);
  });

  it("refuses to claim an issue with an open PR, even after the claim was released back to todo", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimIssue(db, agent, "AIPI-1");
    recordDeliveryEvent(db, human, "AIPI-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
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
    expect(() => updateIssue(db, other, "AIPI-1", { status: "in_progress" })).toThrowError(
      /already claimed by claude\/worker/i,
    );
    expect(getIssue(db, "AIPI-1").status).toBe("todo");
  });

  it("a human PATCHing straight to in_progress can still deliberately override an existing claim", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo", assigneeName: "claude/worker" });
    const moved = updateIssue(db, human, "AIPI-1", { status: "in_progress" });
    expect(moved.status).toBe("in_progress");
    expect(moved.assigneeId).toBe(agent.id); // human overrode the gate, didn't reassign
  });

  // SYD-111: a bare PATCH to in_progress skipped assignment entirely, so two
  // agents could both move the same unclaimed issue to in_progress and both
  // believe they owned it — the SYD-93 double-work gap, reachable via
  // update_issue instead of claim_issue.
  it("a direct PATCH to in_progress on an unclaimed issue auto-assigns the caller", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    const moved = updateIssue(db, agent, "AIPI-1", { status: "in_progress" });
    expect(moved.status).toBe("in_progress");
    expect(moved.assigneeId).toBe(agent.id);
    const types = listIssueEvents(db, moved.id).map((e) => e.type);
    expect(types).toContain("assigned");
  });

  it("a second agent's identical PATCH to in_progress is refused, not a silent no-op", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    updateIssue(db, agent, "AIPI-1", { status: "in_progress" });
    const other = createActor(db, { name: "claude/other", type: "agent" }).actor;
    expect(() => updateIssue(db, other, "AIPI-1", { status: "in_progress" })).toThrowError(
      /already claimed by claude\/worker/i,
    );
    expect(getIssue(db, "AIPI-1").assigneeId).toBe(agent.id);
  });

  it("re-PATCHing to in_progress by the same agent that already owns it is a no-op success", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    updateIssue(db, agent, "AIPI-1", { status: "in_progress" });
    const again = updateIssue(db, agent, "AIPI-1", { status: "in_progress" });
    expect(again.status).toBe("in_progress");
    expect(again.assigneeId).toBe(agent.id);
  });

  it("an explicit assigneeName on the in_progress PATCH is respected over auto-assignment", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    const other = createActor(db, { name: "claude/other", type: "agent" }).actor;
    // A human pre-assigning to someone else while moving it to in_progress
    // must not get overwritten by auto-assigning the calling actor.
    const moved = updateIssue(db, human, "AIPI-1", {
      status: "in_progress",
      assigneeName: "claude/other",
    });
    expect(moved.assigneeId).toBe(other.id);
  });
});
