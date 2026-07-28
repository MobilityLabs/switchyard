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
import { declarePrLink, listLiveLinks } from "../../src/services/pr-links.js";
import { handleGithubWebhook } from "../../src/services/github-webhook.js";
import { resolveDeliveryFailure } from "../../src/services/triage-actions.js";

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

  // SYD-178: SYD-108's fix merged via a feat/ branch — pr_state's strict
  // agent/<ref> attribution (SYD-206) never picks that up, so neither a
  // `delivered` event nor a pr_state-observed merge ever clears the flag.
  // resolveDeliveryFailure is the human's explicit way out.
  it("stays flagged forever on a merge via a non-agent branch, until a human explicitly resolves it", () => {
    const { db, human, agent } = setup();
    const issue = getIssue(db, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "delivery_failed",
      message: "rebase onto main hit real conflicts",
    });
    // The interactive fix merges via feat/SYD-1, observed by the webhook as a
    // free-text match only — never touches pr_state (attributedRef requires a
    // strict agent/<ref> branch).
    recordEvent(db, {
      issueId: issue.id,
      actorId: agent.id,
      type: "gh_pr_merged",
      payload: { prNumber: 124, url: `https://github.com/${REPO}/pull/124`, mergeSha: "aea0dd6" },
    });
    expect(getAttention(db, issue.id)?.reason).toBe("delivery_failed");

    resolveDeliveryFailure(db, human, "SYD-1", "merged via feat/SYD-1 PR #124");
    expect(getAttention(db, issue.id)).toBeNull();
    expect(listAttentionByIssueId(db).size).toBe(0);
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

  // SYD-262: pr_state attributes strictly by agent/<ref> (SYD-206), so work
  // landed on an interactive feat/ branch never produces the merged row that
  // clears this flag — it stays red forever. A human's explicit
  // deviation_resolved is the escape hatch, mirroring delivery_resolved.
  it("clears once a human records a deviation_resolved for that reason", () => {
    const { db, human, agent } = setup();
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    updateIssue(db, human, "SYD-1", { status: "in_review" });
    updateIssue(db, human, "SYD-1", { status: "done" });
    expect(getAttention(db, getIssue(db, "SYD-1").id)?.reason).toBe("done_without_merged_pr");

    recordEvent(db, {
      issueId: getIssue(db, "SYD-1").id,
      actorId: human.id,
      type: "deviation_resolved",
      payload: { reason: "done_without_merged_pr", note: "landed via PR #197 on a feat/ branch" },
    });

    expect(getAttention(db, getIssue(db, "SYD-1").id)).toBeNull();
  });

  // SYD-274 guard. Widening WHICH refs get a `references` suggestion must not
  // widen what a suggestion is worth. This is the SYD-243/SYD-244 shape: their
  // work landed under SYD-242's PR, so ingestion now links that PR to them —
  // but a link minted from PR prose is exactly what SYD-280 stripped of
  // clearing power, and it must stay inert here. A human confirming it (or
  // SYD-262's resolve) is what clears the flag.
  it("a sibling references link from PR text does not clear the flag (SYD-274)", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "landed under a sibling's PR" });
    updateIssue(db, human, "SYD-2", { status: "todo" });
    claimIssue(db, agent, "SYD-2");
    updateIssue(db, human, "SYD-2", { status: "in_review" });
    updateIssue(db, human, "SYD-2", { status: "done" });
    expect(getAttention(db, getIssue(db, "SYD-2").id)?.reason).toBe("done_without_merged_pr");

    handleGithubWebhook(db, "pull_request", {
      action: "closed",
      repository: { full_name: REPO },
      pull_request: {
        number: 206,
        html_url: `https://github.com/${REPO}/pull/206`,
        head: { ref: "feat/sibling-carrier", sha: "a".repeat(40) },
        updated_at: "2026-07-27T10:00:00Z",
        merged: true,
        merge_commit_sha: "0ae22a9".padEnd(40, "0"),
        title: "feat: the carrier (SYD-1)",
        body: "closes SYD-2",
      },
    });

    // The evidence is now reachable from SYD-2...
    expect(listLiveLinks(db, getIssue(db, "SYD-2").id).map((l) => l.role)).toEqual(["references"]);
    // ...but reachable is not vouched-for. Still lit.
    expect(getAttention(db, getIssue(db, "SYD-2").id)?.reason).toBe("done_without_merged_pr");
  });

  // Guard: keyed on event id, so an earlier resolve can't mask a deviation
  // recorded after it. Dropping `r.id > latest.eventId` would break this.
  it("does not let an earlier deviation_resolved mask a later deviation", () => {
    const { db, human, agent } = setup();
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    updateIssue(db, human, "SYD-1", { status: "in_review" });
    updateIssue(db, human, "SYD-1", { status: "done" });
    const id = getIssue(db, "SYD-1").id;

    recordEvent(db, {
      issueId: id,
      actorId: human.id,
      type: "deviation_resolved",
      payload: { reason: "done_without_merged_pr", note: "verified by hand" },
    });
    expect(getAttention(db, id)).toBeNull();

    // A fresh deviation after the resolve is a new fact, not a cleared one.
    recordEvent(db, {
      issueId: id,
      actorId: human.id,
      type: "process_deviation",
      payload: { reason: "done_without_merged_pr", message: "reopened and re-stamped" },
    });
    expect(getAttention(db, id)?.reason).toBe("done_without_merged_pr");
  });

  // Guard: the resolve is scoped to its reason, so clearing this flag must not
  // silence a different signal on the same issue.
  it("does not clear a delivery_failed flag", () => {
    const { db, human, agent } = setup();
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    updateIssue(db, human, "SYD-1", { status: "in_review" });
    updateIssue(db, human, "SYD-1", { status: "done" });
    recordDeliveryEvent(db, human, "SYD-1", { type: "delivery_failed", message: "boom" });

    recordEvent(db, {
      issueId: getIssue(db, "SYD-1").id,
      actorId: human.id,
      type: "deviation_resolved",
      payload: { reason: "done_without_merged_pr", note: "landed on a feat/ branch" },
    });

    expect(getAttention(db, getIssue(db, "SYD-1").id)?.reason).toBe("delivery_failed");
  });

  // SYD-267: the flag reads pr_state, which strict agent/<ref> attribution
  // (SYD-206) leaves empty for a feat/ branch — but the webhook still records
  // gh_pr_merged as a display event, and the issue page renders it. So the
  // banner claimed "no PR ever recorded" on issues whose merged PR was one
  // click away. Trust that event.
  // SYD-267's intent, re-expressed for SYD-280. It used to be satisfied by ANY
  // gh_pr_merged event, which is why a PR that merely mentioned an issue could
  // clear its warning permanently. The intent — interactive work that really
  // landed should clear — is now carried by a declared, human-confirmed link.
  it("clears when a declared, confirmed link's PR is merged (interactive work)", () => {
    const { db, human, agent } = setup();
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    updateIssue(db, human, "SYD-1", { status: "in_review" });
    updateIssue(db, human, "SYD-1", { status: "done" });
    const id = getIssue(db, "SYD-1").id;
    expect(getAttention(db, id)?.reason).toBe("done_without_merged_pr");

    // A feat/ branch: no agent/<ref> to infer from, so a human states the link.
    declarePrLink(db, human, "SYD-1", { repo: REPO, prNumber: 197 });
    upsertPrState(db, human, {
      repo: REPO,
      prNumber: 197,
      status: "merged",
      branch: "feat/interactive",
      ghUpdatedAt: "2026-07-12T11:00:00Z",
      mergeSha: "d0073fb",
    });

    expect(getAttention(db, id)).toBeNull();
  });

  // The false-clear hole, closed. This is the exact shape of 62763cc in this
  // repo's history: a PR whose title first-mentions an unrelated issue.
  it("does NOT clear on a merge event for a PR that merely mentions the issue", () => {
    const { db, human, agent } = setup();
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    updateIssue(db, human, "SYD-1", { status: "in_review" });
    updateIssue(db, human, "SYD-1", { status: "done" });
    const id = getIssue(db, "SYD-1").id;

    // A bare merge event with no declared link — what free-text ingestion used
    // to produce, and what used to silence this flag forever.
    recordEvent(db, {
      issueId: id,
      actorId: human.id,
      type: "gh_pr_merged",
      payload: { prNumber: 197, mergeSha: "d0073fb", repo: REPO },
    });

    expect(getAttention(db, id)?.reason).toBe("done_without_merged_pr");
  });

  // Deliberately NOT event-id ordered, unlike the pr_state and
  // deviation_resolved arms. Whether the merge event lands before or after the
  // deviation is an accident of poller lag: stamp done before the poller
  // catches up and it's after; wait for the board to show merged and it's
  // before. Both are the same real situation — the work landed — so ordering
  // here would leave half the cases falsely flagged (SYD-267).
  it("clears when the merge predates the deviation", () => {
    const { db, human, agent } = setup();
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    updateIssue(db, human, "SYD-1", { status: "in_review" });
    const id = getIssue(db, "SYD-1").id;

    // Poller observed the merge first; the human stamps done afterwards. This
    // is also the hand-merge-then-update-the-board flow, which is why §5a's
    // recency binding must not apply to a human-confirmed link — under a
    // blanket rule this issue could never prove it landed.
    declarePrLink(db, human, "SYD-1", { repo: REPO, prNumber: 197 });
    upsertPrState(db, human, {
      repo: REPO,
      prNumber: 197,
      status: "merged",
      branch: "feat/interactive",
      ghUpdatedAt: "2020-01-01T00:00:00Z", // deliberately long before declaration
      mergeSha: "d0073fb",
    });
    updateIssue(db, human, "SYD-1", { status: "done" });

    expect(getAttention(db, id)).toBeNull();
  });

  it("still flags a done issue with no merge event at all", () => {
    const { db, human, agent } = setup();
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    updateIssue(db, human, "SYD-1", { status: "in_review" });
    updateIssue(db, human, "SYD-1", { status: "done" });
    // A PR that opened but never merged is not evidence the work landed.
    recordEvent(db, {
      issueId: getIssue(db, "SYD-1").id,
      actorId: human.id,
      type: "gh_pr_opened",
      payload: { prNumber: 197, repo: REPO },
    });
    expect(getAttention(db, getIssue(db, "SYD-1").id)?.reason).toBe("done_without_merged_pr");
  });

  // delivery_failed keeps the strict pr_state-only rule (SYD-206/207): clearing
  // it re-authorizes a real merge+deploy, so a display-only event must not do
  // it. Only done_without_merged_pr relaxes, because it authorizes nothing.
  it("does not clear a delivery_failed flag from a gh_pr_merged event", () => {
    const { db, human, agent } = setup();
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    updateIssue(db, human, "SYD-1", { status: "in_review" });
    updateIssue(db, human, "SYD-1", { status: "done" });
    recordDeliveryEvent(db, human, "SYD-1", { type: "delivery_failed", message: "boom" });

    recordEvent(db, {
      issueId: getIssue(db, "SYD-1").id,
      actorId: human.id,
      type: "gh_pr_merged",
      payload: { prNumber: 197, mergeSha: "d0073fb", repo: REPO },
    });

    expect(getAttention(db, getIssue(db, "SYD-1").id)?.reason).toBe("delivery_failed");
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
