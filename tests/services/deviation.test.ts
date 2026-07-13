import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type Db } from "../../src/db/index.js";
import { events } from "../../src/db/schema.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue, getIssue } from "../../src/services/issues.js";
import { recordDeliveryEvent } from "../../src/services/delivery-events.js";
import { requestHumanInput } from "../../src/services/needs-input.js";
import { getDeviation, listDeviationByIssueId } from "../../src/services/deviation.js";
import { listIssueEvents } from "../../src/services/events.js";
import { emitProcessDeviations } from "../../src/services/deviation.js";
import { releaseStaleClaims } from "../../src/services/stale-claims.js";
import { addGithubRepo } from "../../src/services/github-repos.js";
import { upsertPrState } from "../../src/services/pr-state.js";

const REPO = "acme/widgets";

function setup() {
  const db = openDb(":memory:");
  const human = createActor(db, { name: "sean", type: "human" }).actor;
  const agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  // Bound repo so recordDeliveryEvent/upsertPrState write attributed pr_state
  // rows — post-SYD-207 the deviation signal reads pr_state, not raw events.
  addGithubRepo(db, human, { fullName: REPO, projectKey: "SYD" });
  return { db, human, agent };
}

function ageAllEvents(db: Db, issueId: number, secondsAgo: number) {
  const old = Math.floor(Date.now() / 1000) - secondsAgo;
  db.update(events).set({ createdAt: old }).where(eq(events.issueId, issueId)).run();
}


describe("getDeviation — open_pr_not_in_review", () => {
  it("flags an in_progress issue with an open PR", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1"); // -> in_progress
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
    const flag = getDeviation(db, getIssue(db, "SYD-1").id);
    expect(flag?.reason).toBe("open_pr_not_in_review");
    expect(flag?.message).toContain("#41");
  });

  it("flags a todo issue with an open PR", () => {
    const { db, human } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 7,
      url: "https://github.com/acme/widgets/pull/7",
    });
    expect(getDeviation(db, getIssue(db, "SYD-1").id)?.reason).toBe("open_pr_not_in_review");
  });

  it("does NOT flag an in_review issue with an open PR (correct state)", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
    updateIssue(db, human, "SYD-1", { status: "in_review" });
    expect(getDeviation(db, getIssue(db, "SYD-1").id)).toBeNull();
  });

  it("prefers open_pr_not_in_review over stale_claim when both apply", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1"); // -> in_progress
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
    ageAllEvents(db, getIssue(db, "SYD-1").id, 2 * 3600); // idle past the 1h threshold too
    expect(getDeviation(db, getIssue(db, "SYD-1").id)?.reason).toBe("open_pr_not_in_review");
  });
});

describe("getDeviation — merged_pr_not_done", () => {
  it("flags an in_review issue whose PR is merged", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
    updateIssue(db, human, "SYD-1", { status: "in_review" });
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "delivered",
      prNumber: 41,
      mergeSha: "abc",
      deploy: { ran: false },
    });
    const flag = getDeviation(db, getIssue(db, "SYD-1").id);
    expect(flag?.reason).toBe("merged_pr_not_done");
    expect(flag?.message).toContain("#41");
  });

  it("does NOT flag a done issue with a merged PR", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    updateIssue(db, human, "SYD-1", { status: "in_review" });
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "delivered",
      prNumber: 41,
      mergeSha: "abc",
      deploy: { ran: false },
    });
    updateIssue(db, human, "SYD-1", { status: "done" });
    expect(getDeviation(db, getIssue(db, "SYD-1").id)).toBeNull();
  });
});

describe("getDeviation — stale_claim", () => {
  it("flags an in_progress issue idle past claims.deviation_seconds", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    ageAllEvents(db, getIssue(db, "SYD-1").id, 2 * 3600); // 2h > 1h default
    expect(getDeviation(db, getIssue(db, "SYD-1").id)?.reason).toBe("stale_claim");
  });

  it("does NOT flag a fresh in_progress claim", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    expect(getDeviation(db, getIssue(db, "SYD-1").id)).toBeNull();
  });

  it("does NOT flag an idle claim that is waiting on human input", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    requestHumanInput(db, agent, "SYD-1", "which db?");
    ageAllEvents(db, getIssue(db, "SYD-1").id, 2 * 3600);
    expect(getDeviation(db, getIssue(db, "SYD-1").id)).toBeNull();
  });

  it("does NOT flag a stale issue that is not in_progress", () => {
    const { db, human } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    ageAllEvents(db, getIssue(db, "SYD-1").id, 5 * 3600);
    expect(getDeviation(db, getIssue(db, "SYD-1").id)).toBeNull();
  });
});

describe("listDeviationByIssueId", () => {
  it("returns one flag per drifting issue and omits clean ones", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Has PR" }); // SYD-1
    createIssue(db, human, { projectKey: "SYD", title: "Clean" }); // SYD-2
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
    const map = listDeviationByIssueId(db);
    expect(map.get(getIssue(db, "SYD-1").id)?.reason).toBe("open_pr_not_in_review");
    expect(map.has(getIssue(db, "SYD-2").id)).toBe(false);
  });
});

function deviationEvents(db: Db, ref: string) {
  return listIssueEvents(db, getIssue(db, ref).id).filter((e) => e.type === "process_deviation");
}

describe("emitProcessDeviations", () => {
  it("records one event per drifting issue", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
    expect(emitProcessDeviations(db)).toBe(1);
    const evs = deviationEvents(db, "SYD-1");
    expect(evs).toHaveLength(1);
    expect(evs[0].payload).toMatchObject({ reason: "open_pr_not_in_review", prNumber: 41 });
  });

  it("does not re-emit within the same episode", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
    expect(emitProcessDeviations(db)).toBe(1);
    expect(emitProcessDeviations(db)).toBe(0);
    expect(deviationEvents(db, "SYD-1")).toHaveLength(1);
  });

  it("re-arms for a new episode (a new PR after the old one closed)", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
    expect(emitProcessDeviations(db)).toBe(1);
    // PR #41 lands (clears the open-PR episode), then a new PR #42 opens.
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "delivered",
      prNumber: 41,
      mergeSha: "abc",
      deploy: { ran: false },
    });
    expect(emitProcessDeviations(db)).toBe(0); // in_progress, no open PR, fresh -> nothing
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 42,
      url: "https://github.com/acme/widgets/pull/42",
    });
    expect(emitProcessDeviations(db)).toBe(1); // new episode -> re-armed
    expect(deviationEvents(db, "SYD-1")).toHaveLength(2);
  });

  it("re-arms when the same PR reopens after a close (gh_pr_reopened starts a new episode, SYD-205)", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    const observation = {
      repo: REPO,
      prNumber: 41,
      branch: "agent/SYD-1",
      url: `https://github.com/${REPO}/pull/41`,
    };
    upsertPrState(db, human, {
      ...observation,
      status: "open",
      ghUpdatedAt: "2026-07-13T10:00:00Z",
    });
    expect(emitProcessDeviations(db)).toBe(1);
    upsertPrState(db, human, {
      ...observation,
      status: "closed",
      ghUpdatedAt: "2026-07-13T11:00:00Z",
    });
    expect(emitProcessDeviations(db)).toBe(0); // no open PR
    upsertPrState(db, human, {
      ...observation,
      status: "open",
      reopened: true,
      ghUpdatedAt: "2026-07-13T12:00:00Z",
    });
    expect(emitProcessDeviations(db)).toBe(1); // reopen = new episode -> re-armed
    expect(deviationEvents(db, "SYD-1")).toHaveLength(2);
  });

  it("emits nothing when no issue is drifting", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1"); // fresh, no PR
    expect(emitProcessDeviations(db)).toBe(0);
  });
});

describe("process_deviation does not reset the idle clock (SYD-188 seam)", () => {
  it("still flags stale_claim after emitProcessDeviations records its event", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    ageAllEvents(db, getIssue(db, "SYD-1").id, 2 * 3600); // idle 2h > 1h threshold
    expect(emitProcessDeviations(db)).toBe(1); // records a process_deviation at ~now
    // the freshly-recorded process_deviation must NOT reset the idle clock:
    expect(getDeviation(db, getIssue(db, "SYD-1").id)?.reason).toBe("stale_claim");
  });

  it("does not delay releaseStaleClaims", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    ageAllEvents(db, getIssue(db, "SYD-1").id, 5 * 3600); // past both 1h deviation + 4h stale
    expect(emitProcessDeviations(db)).toBe(1); // records a process_deviation at ~now
    // without the fix, that event resets MAX(createdAt) and blocks release:
    expect(releaseStaleClaims(db)).toBe(1);
    expect(getIssue(db, "SYD-1").status).toBe("todo");
  });
});
