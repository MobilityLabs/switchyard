import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, getIssue, updateIssue, claimIssue } from "../../src/services/issues.js";
import { recordDeliveryEvent } from "../../src/services/delivery-events.js";
import { recordEvent } from "../../src/services/events.js";
import { addGithubRepo } from "../../src/services/github-repos.js";
import { upsertPrState } from "../../src/services/pr-state.js";
import { getAttention, listAttentionByIssueId } from "../../src/services/attention.js";

const REPO = "acme/widgets";

function setup() {
  const db = openDb(":memory:");
  const human = createActor(db, { name: "sean", type: "human" }).actor;
  const agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
  // Bound repo so PR-shaped writes land in pr_state — post-SYD-207 both the
  // deviation composition and the merged-PR clearing read pr_state.
  addGithubRepo(db, human, { fullName: REPO, projectKey: "SYD" });
  return { db, human, agent };
}

describe("getAttention", () => {
  it("returns null for an issue with no delivery events", () => {
    const { db } = setup();
    const issue = getIssue(db, "SYD-1");
    expect(getAttention(db, issue.id)).toBeNull();
  });

  it("flags an issue whose latest delivery event is delivery_failed", () => {
    const { db, human, agent } = setup();
    const issue = getIssue(db, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", { type: "delivery_failed", message: "merge conflict" });
    expect(getAttention(db, issue.id)).toEqual({
      reason: "delivery_failed",
      message: "merge conflict",
    });
  });

  it("clears the flag once a later delivered event fires", () => {
    const { db, human, agent } = setup();
    const issue = getIssue(db, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", { type: "delivery_failed", message: "merge conflict" });
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "delivered",
      prNumber: 7,
      mergeSha: "abc123",
      deploy: { ran: false },
    });
    expect(getAttention(db, issue.id)).toBeNull();
  });

  it("clears when the PR merges outside the delivery worker (pr_state observation, replaces SYD-94)", () => {
    const { db, human } = setup();
    const issue = getIssue(db, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", { type: "delivery_failed", message: "merge conflict" });
    // A human merges agent/SYD-1 by hand; the webhook/poller observation
    // lands in pr_state with a co-written transition event newer than the
    // failure — that is what clears the flag now (the deleted SYD-94
    // reconcile pass used to do this with per-ref gh lookups).
    upsertPrState(db, human, {
      repo: REPO,
      prNumber: 7,
      status: "merged",
      branch: "agent/SYD-1",
      url: `https://github.com/${REPO}/pull/7`,
      ghUpdatedAt: "2026-07-13T11:00:00Z",
      mergeSha: "abc123",
    });
    expect(getAttention(db, issue.id)).toBeNull();
    expect(listAttentionByIssueId(db).size).toBe(0);
  });

  it("a legacy raw gh_pr_merged event does NOT clear the flag (audit-only post-SYD-207)", () => {
    const { db, human, agent } = setup();
    const issue = getIssue(db, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", { type: "delivery_failed", message: "merge conflict" });
    recordEvent(db, {
      issueId: issue.id,
      actorId: agent.id,
      type: "gh_pr_merged",
      payload: { prNumber: 7, url: `https://github.com/${REPO}/pull/7`, mergeSha: "abc" },
    });
    expect(getAttention(db, issue.id)?.reason).toBe("delivery_failed");
  });

  it("a merge observed BEFORE the failure does not clear it (deploy-failed-after-merge)", () => {
    const { db, human } = setup();
    const issue = getIssue(db, "SYD-1");
    // Merge lands first (pr_state row + transition event)...
    upsertPrState(db, human, {
      repo: REPO,
      prNumber: 7,
      status: "merged",
      branch: "agent/SYD-1",
      url: `https://github.com/${REPO}/pull/7`,
      ghUpdatedAt: "2026-07-13T10:00:00Z",
      mergeSha: "abc123",
    });
    // ...then the post-merge deploy fails. The stale merged row must not
    // swallow the newer failure.
    recordDeliveryEvent(db, human, "SYD-1", { type: "delivery_failed", message: "deploy broke" });
    expect(getAttention(db, issue.id)?.reason).toBe("delivery_failed");
  });

  it("re-flags if delivery fails again after a successful delivery", () => {
    const { db, human, agent } = setup();
    const issue = getIssue(db, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "delivered",
      prNumber: 7,
      mergeSha: "abc123",
      deploy: { ran: false },
    });
    recordDeliveryEvent(db, human, "SYD-1", { type: "delivery_failed", message: "deploy broke" });
    expect(getAttention(db, issue.id)).toEqual({
      reason: "delivery_failed",
      message: "deploy broke",
    });
  });
});

describe("listAttentionByIssueId", () => {
  it("only includes issues with an unresolved delivery_failed", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Also shipping" }); // SYD-2
    recordDeliveryEvent(db, human, "SYD-1", { type: "delivery_failed", message: "merge conflict" });

    const failing = getIssue(db, "SYD-1");
    const clean = getIssue(db, "SYD-2");
    const flags = listAttentionByIssueId(db);
    expect(flags.get(failing.id)).toEqual({ reason: "delivery_failed", message: "merge conflict" });
    expect(flags.has(clean.id)).toBe(false);
  });

  it("clears once delivered, for the bulk query too", () => {
    const { db, human, agent } = setup();
    recordDeliveryEvent(db, human, "SYD-1", { type: "delivery_failed", message: "merge conflict" });
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "delivered",
      prNumber: 7,
      mergeSha: "abc123",
      deploy: { ran: false },
    });
    expect(listAttentionByIssueId(db).size).toBe(0);
  });
});

describe("getAttention — done_without_merged_pr (SYD-204)", () => {
  it("flags a done issue that reached done from in_review with no PR ever recorded", () => {
    const { db, human, agent } = setup();
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    updateIssue(db, human, "SYD-1", { status: "in_review" });
    updateIssue(db, human, "SYD-1", { status: "done" });
    const flag = getAttention(db, getIssue(db, "SYD-1").id);
    expect(flag?.reason).toBe("done_without_merged_pr");
  });

  it("clears once a human merges the stale branch by hand (a later pr_state 'merged' row)", () => {
    const { db, human, agent } = setup();
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    updateIssue(db, human, "SYD-1", { status: "in_review" });
    updateIssue(db, human, "SYD-1", { status: "done" });
    expect(getAttention(db, getIssue(db, "SYD-1").id)?.reason).toBe("done_without_merged_pr");
    upsertPrState(db, human, {
      repo: REPO,
      prNumber: 9,
      status: "merged",
      branch: "agent/SYD-1",
      url: `https://github.com/${REPO}/pull/9`,
      ghUpdatedAt: "2026-07-14T10:00:00Z",
      mergeSha: "abc123",
    });
    expect(getAttention(db, getIssue(db, "SYD-1").id)).toBeNull();
  });

  it("delivery_failed outranks a co-occurring done_without_merged_pr", () => {
    const { db, human, agent } = setup();
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    updateIssue(db, human, "SYD-1", { status: "in_review" });
    updateIssue(db, human, "SYD-1", { status: "done" });
    recordDeliveryEvent(db, human, "SYD-1", { type: "delivery_failed", message: "boom" });
    expect(getAttention(db, getIssue(db, "SYD-1").id)).toEqual({
      reason: "delivery_failed",
      message: "boom",
    });
  });

  it("includes done_without_merged_pr issues in the bulk map", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Clean" }); // SYD-2
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    updateIssue(db, human, "SYD-1", { status: "in_review" });
    updateIssue(db, human, "SYD-1", { status: "done" });
    const flags = listAttentionByIssueId(db);
    expect(flags.get(getIssue(db, "SYD-1").id)?.reason).toBe("done_without_merged_pr");
    expect(flags.has(getIssue(db, "SYD-2").id)).toBe(false);
  });

  it("does NOT flag a done issue whose PR merged before the stamp", () => {
    const { db, human, agent } = setup();
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "delivered",
      prNumber: 41,
      mergeSha: "abc",
      deploy: { ran: false },
    });
    updateIssue(db, human, "SYD-1", { status: "in_review" });
    updateIssue(db, human, "SYD-1", { status: "done" });
    expect(getAttention(db, getIssue(db, "SYD-1").id)).toBeNull();
  });
});

describe("getAttention — composes process deviations", () => {
  it("surfaces a process deviation as an attention flag", () => {
    const { db, human, agent } = setup();
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
    expect(getAttention(db, getIssue(db, "SYD-1").id)?.reason).toBe("open_pr_not_in_review");
  });

  it("delivery_failed outranks a co-occurring deviation", () => {
    const { db, human, agent } = setup();
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
    recordDeliveryEvent(db, human, "SYD-1", { type: "delivery_failed", message: "merge conflict" });
    const flag = getAttention(db, getIssue(db, "SYD-1").id);
    expect(flag).toEqual({ reason: "delivery_failed", message: "merge conflict" });
  });

  it("includes deviations in the bulk map, delivery_failed winning on collision", () => {
    const { db, human, agent } = setup();
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
    expect(listAttentionByIssueId(db).get(getIssue(db, "SYD-1").id)?.reason).toBe(
      "open_pr_not_in_review",
    );
    recordDeliveryEvent(db, human, "SYD-1", { type: "delivery_failed", message: "boom" });
    expect(listAttentionByIssueId(db).get(getIssue(db, "SYD-1").id)?.reason).toBe(
      "delivery_failed",
    );
  });
});
