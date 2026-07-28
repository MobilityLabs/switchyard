// The OBSERVATION half of declared attribution (SYD-287, under SYD-280).
//
// SYD-280 defined proof-of-landing as a join — a declared `delivers` link ⋈ a
// merged `pr_state` row on (repo, pr_number). It shipped the declaration half
// for every branch and left the observation half gated on `agent/<ref>`, so a
// feat/ PR got no pr_state row ever, and all four readers in pr-status.ts
// INNER JOIN through pr_state. Production held zero non-agent rows, all time.
//
// **Every test here drives handleGithubWebhook.** The SYD-280 suite covered
// this exact case and passed, because each test called upsertPrState directly
// to stand up the observation half; production never does that for a feat/
// branch, so the tests validated the reader while the producer was missing.
// Nothing in this file may construct a pr_state row by hand — a test that
// builds its own precondition proves nothing about whether anything builds it.
//
// The ordering is deliberate too: the webhook is allowed to ingest FIRST in
// the tests that matter, because that is the order production produces (open
// the PR, the poller sees it within a tick, then the session declares).
import { describe, it, expect } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, claimIssue, updateIssue } from "../../src/services/issues.js";
import { addGithubRepo } from "../../src/services/github-repos.js";
import { getActivity } from "../../src/services/comments.js";
import { handleGithubWebhook } from "../../src/services/github-webhook.js";
import { findPrState } from "../../src/services/pr-state.js";
import { getOpenPr, getMergedPr, deliveryPinFor } from "../../src/services/pr-status.js";
import { getAttention } from "../../src/services/attention.js";
import { listPendingDeliveryAuthorizations } from "../../src/services/delivery-attempts.js";
import {
  declarePrLink,
  revokePrLink,
  listLiveLinks,
  backfillPrLinksFromPrState,
} from "../../src/services/pr-links.js";

const REPO = "acme/widgets";
const PR = 226;

function setup() {
  const db = openDb(":memory:");
  const human = createActor(db, { name: "sean", type: "human" }).actor;
  const agent = createActor(db, { name: "claude/dev", type: "agent" }).actor;
  const other = createActor(db, { name: "claude/other", type: "agent" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
  updateIssue(db, human, "SYD-1", { status: "todo" });
  addGithubRepo(db, human, { fullName: REPO, projectKey: "SYD" });
  return { db, human, agent, other };
}

/** An interactive PR: a feat/ branch, which attributedRef can never match.
 * Its title carries the ref the way CLAUDE.md's commit convention produces —
 * that free text is what mints the `references` link the flow trips over. */
function featPr(action: string, pr: Record<string, unknown> = {}) {
  return {
    action,
    repository: { full_name: REPO },
    pull_request: {
      number: PR,
      html_url: `https://github.com/${REPO}/pull/${PR}`,
      head: { ref: "feat/declared-pr-attribution", sha: "a".repeat(40) },
      updated_at: "2026-07-27T10:00:00Z",
      title: "feat: declared issue<->PR attribution (SYD-1)",
      body: null,
      ...pr,
    },
  };
}

const merged = (pr: Record<string, unknown> = {}) =>
  featPr("closed", {
    merged: true,
    merge_commit_sha: "m".repeat(40),
    updated_at: "2026-07-27T12:00:00Z",
    ...pr,
  });

/** Declares SYD-1 -> the PR as a human (auto-confirmed, so proof-bearing). */
function declare(db: Db, human: Parameters<typeof declarePrLink>[1], prNumber = PR) {
  return declarePrLink(db, human, "SYD-1", { repo: REPO, prNumber });
}

describe("a declared feat/ PR gains its observation half (SYD-287)", () => {
  it("writes a pr_state row through the webhook, which is what every reader joins", () => {
    const { db, human } = setup();
    declare(db, human);
    handleGithubWebhook(db, "pull_request", featPr("opened"));

    const row = findPrState(db, REPO, PR)!;
    expect(row).toMatchObject({ status: "open", headSha: "a".repeat(40), repo: REPO });
    expect(getOpenPr(db, 1)).toEqual({
      prNumber: PR,
      url: `https://github.com/${REPO}/pull/${PR}`,
      repo: REPO,
      headSha: "a".repeat(40),
    });
  });

  it("gates a second claim — the SYD-93 double-work gap, still open on interactive work", () => {
    const { db, human, agent } = setup();
    declare(db, human);
    handleGithubWebhook(db, "pull_request", featPr("opened"));
    expect(() => claimIssue(db, agent, "SYD-1")).toThrow(/already has an open PR/i);
  });

  it("proves the work landed once merged, and yields a delivery pin", () => {
    const { db, human } = setup();
    declare(db, human);
    handleGithubWebhook(db, "pull_request", featPr("opened"));
    handleGithubWebhook(db, "pull_request", merged());

    expect(findPrState(db, REPO, PR)!.status).toBe("merged");
    expect(getMergedPr(db, 1)?.prNumber).toBe(PR);
    expect(deliveryPinFor(db, 1)).toEqual({
      repo: REPO,
      prNumber: PR,
      headSha: "a".repeat(40),
      status: "merged",
    });
  });

  it("clears done_without_merged_pr, instead of leaving it lit on work that landed", () => {
    const { db, human } = setup();
    // Stamped done with pr_state showing neither an open nor a merged PR —
    // which, before SYD-287, was every interactive issue, always. The
    // deviation is recorded at the transition (deviation.ts's
    // doneWithoutMergedPr), not recomputed live.
    updateIssue(db, human, "SYD-1", { status: "in_progress" });
    updateIssue(db, human, "SYD-1", { status: "in_review" });
    updateIssue(db, human, "SYD-1", { status: "done" });
    expect(getAttention(db, 1)?.reason).toBe("done_without_merged_pr");

    // The human declares and the merge arrives through the webhook. The link
    // is human-confirmed, so §5a's recency binding does not apply — which is
    // what makes hand-merge-then-update, the dominant interactive flow, able
    // to prove itself at all.
    declare(db, human);
    handleGithubWebhook(db, "pull_request", featPr("opened"));
    handleGithubWebhook(db, "pull_request", merged());
    expect(getAttention(db, 1)).toBeNull();
  });

  it("records the canonical transition on the issue's timeline, exactly once", () => {
    const { db, human } = setup();
    declare(db, human);
    handleGithubWebhook(db, "pull_request", featPr("opened"));
    handleGithubWebhook(db, "pull_request", featPr("opened")); // at-least-once redelivery
    handleGithubWebhook(db, "pull_request", merged());

    const types = getActivity(db, "SYD-1").map((a) => a.type);
    expect(types.filter((t) => t === "gh_pr_opened")).toHaveLength(1);
    expect(types.filter((t) => t === "gh_pr_merged")).toHaveLength(1);
  });

  it("observes a PR that names the issue NOWHERE — the branch and the text are not the attribution", () => {
    const { db, human } = setup();
    declare(db, human);
    const outcome = handleGithubWebhook(
      db,
      "pull_request",
      featPr("opened", { title: "feat: some untitled work", body: null }),
    );
    expect(outcome).toMatchObject({ handled: true, ref: "SYD-1", type: "gh_pr_opened" });
    expect(findPrState(db, REPO, PR)!.status).toBe("open");
    expect(getOpenPr(db, 1)?.prNumber).toBe(PR);
  });
});

describe("declaring after ingestion — the production ordering (SYD-287)", () => {
  it("promotes the references link free-text ingestion already minted", () => {
    const { db, human } = setup();
    // The webhook lands FIRST, as it does in production: the PR title carries
    // the ref, so ingestion mints an unconfirmed `references` suggestion. The
    // observation is recorded regardless; the suggestion attributes nothing.
    handleGithubWebhook(db, "pull_request", featPr("opened"));
    expect(listLiveLinks(db, 1).map((l) => l.role)).toEqual(["references"]);
    expect(findPrState(db, REPO, PR)!.status).toBe("open");
    expect(getOpenPr(db, 1)).toBeNull();

    // The session then declares. Before SYD-287 this threw "already has a live
    // link — revoke it before declaring a different role", which made the
    // observation fix unreachable in the only order production produces.
    const link = declare(db, human);
    expect(link.role).toBe("delivers");
    expect(link.confirmedBy).toBe(human.id);
    expect(listLiveLinks(db, 1).map((l) => l.role)).toEqual(["delivers"]);
    // The row was already waiting, so the declaration alone completes the join
    // — no second observation, no poll tick, no healing step.
    expect(getOpenPr(db, 1)?.prNumber).toBe(PR);
  });

  it("proves a PR that merged BEFORE anyone declared, with no re-observation at all", () => {
    const { db, human } = setup();
    // The order that used to be unrecoverable: merged, then declared. An
    // earlier cut of SYD-287 observed only attributed PRs, so this left no row
    // and depended on the poller re-emitting the PR within its 50-wide window
    // to heal — which a PR that had aged out never would.
    handleGithubWebhook(db, "pull_request", merged());
    expect(findPrState(db, REPO, PR)!.status).toBe("merged");
    expect(getMergedPr(db, 1)).toBeNull(); // observed, not yet attributed

    declare(db, human);
    expect(getMergedPr(db, 1)?.prNumber).toBe(PR);
  });

  it("keeps the promotion revocable, and both statements on the record", () => {
    const { db, human } = setup();
    handleGithubWebhook(db, "pull_request", featPr("opened"));
    declare(db, human);
    revokePrLink(db, human, "SYD-1", { repo: REPO, prNumber: PR, reason: "wrong issue" });
    expect(listLiveLinks(db, 1)).toHaveLength(0);
    // The superseded references row is soft-revoked, never deleted.
    const kinds = getActivity(db, "SYD-1").map((a) => a.type);
    expect(kinds).toContain("pr_link_declared");
    expect(kinds).toContain("pr_link_revoked");
  });
});

describe("what a declaration still cannot do (SYD-287)", () => {
  it("an agent-declared link gates claims but never proves landing", () => {
    const { db, agent, other } = setup();
    const lease = claimIssue(db, agent, "SYD-1").leaseToken as string;
    declarePrLink(db, agent, "SYD-1", { repo: REPO, prNumber: PR }, lease);
    handleGithubWebhook(db, "pull_request", featPr("opened"));
    handleGithubWebhook(db, "pull_request", merged());

    // Observed, and claim-gating...
    expect(findPrState(db, REPO, PR)!.status).toBe("merged");
    expect(deliveryPinFor(db, 1)?.prNumber).toBe(PR);
    // ...but unconfirmed, so it is not evidence. An agent cannot vouch for
    // its own work no matter what the PR did.
    expect(getMergedPr(db, 1)).toBeNull();
    expect(other.id).not.toBe(agent.id);
  });

  it("a references link — the only thing free text can mint — attributes nothing", () => {
    const { db } = setup();
    handleGithubWebhook(db, "pull_request", featPr("opened"));
    handleGithubWebhook(db, "pull_request", merged());
    expect(listLiveLinks(db, 1).map((l) => l.role)).toEqual(["references"]);
    // Observed — a merge is a fact about the PR regardless of who claims it...
    expect(findPrState(db, REPO, PR)!.status).toBe("merged");
    // ...and completely inert, which is the property that matters: a PR body
    // is writable by anyone on a public repo, so free text must never gate a
    // claim or prove a landing.
    expect(getOpenPr(db, 1)).toBeNull();
    expect(getMergedPr(db, 1)).toBeNull();
    expect(getActivity(db, "SYD-1").filter((a) => a.type === "gh_pr_merged")).toHaveLength(1);
  });

  it("a revoked link stops attributing — the row stays, the interpretation goes", () => {
    const { db, human } = setup();
    declare(db, human);
    handleGithubWebhook(db, "pull_request", featPr("opened"));
    revokePrLink(db, human, "SYD-1", { repo: REPO, prNumber: PR, reason: "mis-linked" });

    // The observation survives a revoke — a revoke removes an interpretation,
    // never an observation, and deleting the evidence would be the wrong move.
    expect(findPrState(db, REPO, PR)!.status).toBe("open");
    // Nothing reads it for this issue any more, and a later merge observation
    // is attributed to no one.
    expect(getOpenPr(db, 1)).toBeNull();
    handleGithubWebhook(db, "pull_request", merged());
    expect(findPrState(db, REPO, PR)!.status).toBe("merged");
    expect(getMergedPr(db, 1)).toBeNull();
  });

  it("a PR in an unbound repo is still unobservable — declaring there is refused outright", () => {
    const { db, human } = setup();
    expect(() =>
      declarePrLink(db, human, "SYD-1", { repo: "acme/unrelated", prNumber: PR }),
    ).toThrow(/bound/i);
    handleGithubWebhook(db, "pull_request", {
      ...featPr("opened"),
      repository: { full_name: "acme/unrelated" },
    });
    expect(findPrState(db, "acme/unrelated", PR)).toBeUndefined();
  });
});

describe("the SYD-280 regression fence still holds (SYD-287)", () => {
  const agentPr = (action: string, pr: Record<string, unknown> = {}) => ({
    action,
    repository: { full_name: REPO },
    pull_request: {
      number: 12,
      html_url: `https://github.com/${REPO}/pull/12`,
      head: { ref: "agent/SYD-1", sha: "b".repeat(40) },
      updated_at: "2026-07-27T10:00:00Z",
      title: null,
      body: null,
      ...pr,
    },
  });

  it("an agent/<ref> PR behaves exactly as before — one delivers link, one event, one row", () => {
    const { db } = setup();
    const outcome = handleGithubWebhook(db, "pull_request", agentPr("opened"));
    expect(outcome).toEqual({ handled: true, ref: "SYD-1", type: "gh_pr_opened" });
    expect(findPrState(db, REPO, 12)).toMatchObject({ status: "open", issueRef: "SYD-1" });
    const links = listLiveLinks(db, 1);
    expect(links).toHaveLength(1);
    expect(links[0].role).toBe("delivers");
    expect(getActivity(db, "SYD-1").filter((a) => a.type === "gh_pr_opened")).toHaveLength(1);
  });

  it("an UNDECLARED feat/ PR is observed but gates nothing — over-blocking stays opt-in", () => {
    const { db, agent } = setup();
    handleGithubWebhook(db, "pull_request", featPr("opened"));
    // A row now exists for every PR in a bound repo...
    expect(findPrState(db, REPO, PR)).toMatchObject({ status: "open", issueRef: null });
    // ...and it is inert. This is the claim the SYD-280 design doc corrected
    // itself on: interactive work starts gating claims only when someone
    // DECLARES, which is opt-in per PR — not when a PR merely exists.
    expect(getOpenPr(db, 1)).toBeNull();
    expect(() => claimIssue(db, agent, "SYD-1")).not.toThrow();
  });

  it("leaves an unattributed row out of the cutover backfill (issue_ref IS NOT NULL)", () => {
    const { db, human } = setup();
    handleGithubWebhook(db, "pull_request", merged());
    // backfillPrLinksFromPrState reads `WHERE ps.issue_ref IS NOT NULL`, so
    // observing every PR cannot retroactively mint links for undeclared work.
    expect(backfillPrLinksFromPrState(db, human).created).toBe(0);
    expect(listLiveLinks(db, 1).map((l) => l.role)).toEqual(["references"]);
  });

  // The regression this fence exists for, found by stamping SYD-287 itself
  // done against the deployed fix: making interactive work observable gave it
  // a deliveryPinFor for the first time, so the done stamp wrote a pin,
  // listPendingDeliveryAuthorizations queued it, and deliver.ts — whose whole
  // contract is "fetch, rebase and force-push agent/<ref>" — found no such
  // branch and took SYD-165's dead-PR path, which auto-CLOSED the open PR.
  // That is SYD-283 ("delivery must never close a PR it did not open") going
  // from latent to reachable.
  it("does not queue an interactive PR for delivery — the worker can only rebase agent/<ref>", () => {
    const { db, human } = setup();
    declare(db, human);
    handleGithubWebhook(db, "pull_request", featPr("opened"));
    // The stamp DOES authorize a pin now — getOpenPr sees the declared PR, and
    // demands the head SHA the human reviewed (SYD-208's compare-and-set).
    updateIssue(db, human, "SYD-1", { status: "done", expectedHeadSha: "a".repeat(40) });
    expect(deliveryPinFor(db, 1)?.prNumber).toBe(PR);
    // ...and the queue still refuses it, because nothing can deliver it yet.
    expect(listPendingDeliveryAuthorizations(db)).toEqual([]);
  });

  it("still queues an agent/<ref> PR — the guard bounds the queue, it does not empty it", () => {
    const { db, human } = setup();
    handleGithubWebhook(db, "pull_request", {
      action: "opened",
      repository: { full_name: REPO },
      pull_request: {
        number: 12,
        html_url: `https://github.com/${REPO}/pull/12`,
        head: { ref: "agent/SYD-1", sha: "b".repeat(40) },
        updated_at: "2026-07-27T10:00:00Z",
      },
    });
    updateIssue(db, human, "SYD-1", { status: "done", expectedHeadSha: "b".repeat(40) });
    const pending = listPendingDeliveryAuthorizations(db);
    expect(pending).toHaveLength(1);
    expect(pending[0].pin).toMatchObject({ prNumber: 12, repo: REPO });
  });

  it("never writes issueRef from a link — that column stays branch-derived until it is dropped", () => {
    const { db, human } = setup();
    declare(db, human);
    handleGithubWebhook(db, "pull_request", featPr("opened"));
    // SYD-280 spec §10 step 4 drops pr_state.issue_ref. Writing it from a link
    // would re-couple observation to attribution — the exact thing this work
    // removes — so a link-observed row leaves it null.
    expect(findPrState(db, REPO, PR)!.issueRef).toBeNull();
  });
});
