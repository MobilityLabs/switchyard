import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, getIssue } from "../../src/services/issues.js";
import { addGithubRepo } from "../../src/services/github-repos.js";
import { recordDeliveryEvent } from "../../src/services/delivery-events.js";
import { recordEvent } from "../../src/services/events.js";
import { upsertPrState } from "../../src/services/pr-state.js";
import {
  getOpenPr,
  listOpenPrByIssueId,
  getMergedPr,
  deliveryPinFor,
} from "../../src/services/pr-status.js";

const REPO = "acme/widgets";

function setup() {
  const db = openDb(":memory:");
  const human = createActor(db, { name: "sean", type: "human" }).actor;
  const agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
  addGithubRepo(db, human, { fullName: REPO, projectKey: "SYD" });
  return { db, human, agent };
}

/** An attributed observation for agent/<ref> — the shape every pr_state
 * writer (webhook, poller, publish, delivery, backfill) converges on. */
function observe(
  ref: string,
  prNumber: number,
  status: "open" | "merged" | "closed",
  ghUpdatedAt: string,
  extra: { reopened?: boolean } = {},
) {
  return {
    repo: REPO,
    prNumber,
    status,
    branch: `agent/${ref}`,
    url: `https://github.com/${REPO}/pull/${prNumber}`,
    ghUpdatedAt,
    ...extra,
  };
}

describe("getOpenPr (pr_state-derived, SYD-207)", () => {
  it("returns null for an issue with no pr_state rows", () => {
    const { db } = setup();
    expect(getOpenPr(db, getIssue(db, "SYD-1").id)).toBeNull();
  });

  it("flags an issue with an open attributed row", () => {
    const { db, human } = setup();
    upsertPrState(db, human, observe("SYD-1", 41, "open", "2026-07-13T10:00:00Z"));
    expect(getOpenPr(db, getIssue(db, "SYD-1").id)).toEqual({
      prNumber: 41,
      url: `https://github.com/${REPO}/pull/41`,
      repo: REPO,
      headSha: null,
    });
  });

  it("carries repo and headSha (SYD-208)", () => {
    const { db, human } = setup();
    upsertPrState(db, human, {
      ...observe("SYD-1", 41, "open", "2026-07-13T10:00:00Z"),
      headSha: "abc123",
    });
    expect(getOpenPr(db, getIssue(db, "SYD-1").id)).toEqual({
      prNumber: 41,
      url: `https://github.com/${REPO}/pull/41`,
      repo: REPO,
      headSha: "abc123",
    });
  });

  it("clears when the row goes merged or closed", () => {
    const { db, human } = setup();
    const issueId = getIssue(db, "SYD-1").id;
    upsertPrState(db, human, observe("SYD-1", 41, "open", "2026-07-13T10:00:00Z"));
    upsertPrState(db, human, observe("SYD-1", 41, "merged", "2026-07-13T11:00:00Z"));
    expect(getOpenPr(db, issueId)).toBeNull();
  });

  it("flags again after a genuine reopen", () => {
    const { db, human } = setup();
    const issueId = getIssue(db, "SYD-1").id;
    upsertPrState(db, human, observe("SYD-1", 41, "open", "2026-07-13T10:00:00Z"));
    upsertPrState(db, human, observe("SYD-1", 41, "closed", "2026-07-13T11:00:00Z"));
    expect(getOpenPr(db, issueId)).toBeNull();
    upsertPrState(
      db,
      human,
      observe("SYD-1", 41, "open", "2026-07-13T12:00:00Z", { reopened: true }),
    );
    expect(getOpenPr(db, issueId)?.prNumber).toBe(41);
  });

  it("ignores legacy event-log-only PRs with no pr_state row (SYD-178 free-text class)", () => {
    const { db, agent } = setup();
    const issue = getIssue(db, "SYD-1");
    // Pre-cutover, the old direct-write path recorded gh_pr_opened straight to
    // the event log (including free-text title matches). Post-cutover these
    // are audit history, never claim-gating state.
    recordEvent(db, {
      issueId: issue.id,
      actorId: agent.id,
      type: "gh_pr_opened",
      payload: { prNumber: 90, url: `https://github.com/${REPO}/pull/90` },
    });
    expect(getOpenPr(db, issue.id)).toBeNull();
    expect(listOpenPrByIssueId(db).has(issue.id)).toBe(false);
  });

  it("never flags from a display-only row (non-agent branch)", () => {
    const { db, human } = setup();
    upsertPrState(db, human, {
      repo: REPO,
      prNumber: 90,
      status: "open",
      branch: "fix/syd-1-something",
      url: `https://github.com/${REPO}/pull/90`,
      ghUpdatedAt: "2026-07-13T10:00:00Z",
    });
    expect(getOpenPr(db, getIssue(db, "SYD-1").id)).toBeNull();
  });

  it("a belated close for an old PR can't hide a newer still-open PR (SYD-125 shape)", () => {
    const { db, human } = setup();
    const issueId = getIssue(db, "SYD-1").id;
    upsertPrState(db, human, observe("SYD-1", 1, "open", "2026-07-13T09:00:00Z"));
    upsertPrState(db, human, observe("SYD-1", 2, "open", "2026-07-13T10:00:00Z"));
    upsertPrState(db, human, observe("SYD-1", 1, "closed", "2026-07-13T11:00:00Z"));
    expect(getOpenPr(db, issueId)).toEqual({
      prNumber: 2,
      url: `https://github.com/${REPO}/pull/2`,
      repo: REPO,
      headSha: null,
    });
  });

  it("the worker publish path (recordDeliveryEvent) still closes the claim gate", () => {
    const { db, human } = setup();
    const issueId = getIssue(db, "SYD-1").id;
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: `https://github.com/${REPO}/pull/41`,
      headSha: "abc",
      ghUpdatedAt: "2026-07-13T10:00:00Z",
    });
    expect(getOpenPr(db, issueId)?.prNumber).toBe(41);
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "delivered",
      prNumber: 41,
      mergeSha: "def",
      deploy: { ran: false },
      ghUpdatedAt: "2026-07-13T11:00:00Z",
    });
    expect(getOpenPr(db, issueId)).toBeNull();
  });
});

describe("listOpenPrByIssueId (pr_state-derived, SYD-207)", () => {
  it("only includes issues with an open attributed row", () => {
    const { db, human } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Also shipping" }); // SYD-2
    upsertPrState(db, human, observe("SYD-1", 41, "open", "2026-07-13T10:00:00Z"));

    const open = getIssue(db, "SYD-1");
    const clean = getIssue(db, "SYD-2");
    const flags = listOpenPrByIssueId(db);
    expect(flags.get(open.id)).toEqual({
      prNumber: 41,
      url: `https://github.com/${REPO}/pull/41`,
      repo: REPO,
      headSha: null,
    });
    expect(flags.has(clean.id)).toBe(false);
  });

  it("keeps the newest PR when an issue somehow has two open rows", () => {
    const { db, human } = setup();
    upsertPrState(db, human, observe("SYD-1", 41, "open", "2026-07-13T10:00:00Z"));
    upsertPrState(db, human, observe("SYD-1", 55, "open", "2026-07-13T09:00:00Z"));
    expect(listOpenPrByIssueId(db).get(getIssue(db, "SYD-1").id)?.prNumber).toBe(55);
  });
});

describe("getMergedPr (pr_state-derived, SYD-207)", () => {
  it("returns null when the issue has no merged row", () => {
    const { db } = setup();
    expect(getMergedPr(db, getIssue(db, "SYD-1").id)).toBeNull();
  });

  it("returns prNumber + the co-written transition event id", () => {
    const { db, human } = setup();
    const issueId = getIssue(db, "SYD-1").id;
    upsertPrState(db, human, observe("SYD-1", 41, "open", "2026-07-13T10:00:00Z"));
    upsertPrState(db, human, {
      ...observe("SYD-1", 41, "merged", "2026-07-13T11:00:00Z"),
      mergeSha: "abc123",
    });
    const merged = getMergedPr(db, issueId);
    expect(merged?.prNumber).toBe(41);
    expect(merged?.eventId).toBeGreaterThan(0);
  });

  it("returns the most recently merged PR when several exist", () => {
    const { db, human } = setup();
    const issueId = getIssue(db, "SYD-1").id;
    upsertPrState(db, human, observe("SYD-1", 41, "merged", "2026-07-13T10:00:00Z"));
    upsertPrState(db, human, observe("SYD-1", 42, "merged", "2026-07-13T12:00:00Z"));
    expect(getMergedPr(db, issueId)?.prNumber).toBe(42);
  });

  it("the delivery worker's merge (recordDeliveryEvent delivered) is visible", () => {
    const { db, human } = setup();
    const issueId = getIssue(db, "SYD-1").id;
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "delivered",
      prNumber: 41,
      mergeSha: "abc123",
      deploy: { ran: false },
      ghUpdatedAt: "2026-07-13T11:00:00Z",
    });
    expect(getMergedPr(db, issueId)?.prNumber).toBe(41);
  });
});

describe("deliveryPinFor (SYD-208)", () => {
  it("returns null when the issue has no pr_state rows", () => {
    const { db } = setup();
    expect(deliveryPinFor(db, getIssue(db, "SYD-1").id)).toBeNull();
  });

  it("prefers an open row over merged or closed rows", () => {
    const { db, human } = setup();
    const issueId = getIssue(db, "SYD-1").id;
    upsertPrState(db, human, {
      ...observe("SYD-1", 40, "closed", "2026-07-13T09:00:00Z"),
      headSha: "sha-closed",
    });
    upsertPrState(db, human, {
      ...observe("SYD-1", 41, "merged", "2026-07-13T10:00:00Z"),
      headSha: "sha-merged",
    });
    upsertPrState(db, human, {
      ...observe("SYD-1", 42, "open", "2026-07-13T08:00:00Z"),
      headSha: "sha-open",
    });
    expect(deliveryPinFor(db, issueId)).toEqual({
      repo: REPO,
      prNumber: 42,
      headSha: "sha-open",
      status: "open",
    });
  });

  it("prefers merged over closed when no open row exists", () => {
    const { db, human } = setup();
    const issueId = getIssue(db, "SYD-1").id;
    upsertPrState(db, human, {
      ...observe("SYD-1", 40, "closed", "2026-07-13T09:00:00Z"),
      headSha: "sha-closed",
    });
    upsertPrState(db, human, {
      ...observe("SYD-1", 41, "merged", "2026-07-13T10:00:00Z"),
      headSha: "sha-merged",
    });
    expect(deliveryPinFor(db, issueId)).toEqual({
      repo: REPO,
      prNumber: 41,
      headSha: "sha-merged",
      status: "merged",
    });
  });

  it("falls back to a closed row when nothing else exists", () => {
    const { db, human } = setup();
    const issueId = getIssue(db, "SYD-1").id;
    upsertPrState(db, human, {
      ...observe("SYD-1", 40, "closed", "2026-07-13T09:00:00Z"),
      headSha: "sha-closed",
    });
    expect(deliveryPinFor(db, issueId)).toEqual({
      repo: REPO,
      prNumber: 40,
      headSha: "sha-closed",
      status: "closed",
    });
  });
});
