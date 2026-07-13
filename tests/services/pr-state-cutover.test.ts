// SYD-207 cutover invariants (spec: docs/2026-07-12-sync-simplification-
// assessment.md Step 6): the backfill rides POST /api/github-events →
// handleGithubWebhook, so these tests drive that exact ingestion and assert
// the consumers (search filter, claim gate, open-PR reads) agree with each
// other — one oracle, no fresh disagreement.
import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, getIssue, updateIssue, claimIssue } from "../../src/services/issues.js";
import { addGithubRepo } from "../../src/services/github-repos.js";
import { handleGithubWebhook } from "../../src/services/github-webhook.js";
import { searchIssues } from "../../src/services/search.js";
import { getOpenPr } from "../../src/services/pr-status.js";
import { findPrState } from "../../src/services/pr-state.js";

const REPO = "acme/widgets";
const OTHER_REPO = "acme/other";

function setup() {
  const db = openDb(":memory:");
  const human = createActor(db, { name: "sean", type: "human" }).actor;
  const agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  createProject(db, human, { key: "OTH", name: "Other" });
  addGithubRepo(db, human, { fullName: REPO, projectKey: "SYD" });
  addGithubRepo(db, human, { fullName: OTHER_REPO, projectKey: "OTH" });
  createIssue(db, human, { projectKey: "SYD", title: "Ship it" }); // SYD-1
  createIssue(db, human, { projectKey: "SYD", title: "Next up" }); // SYD-2
  updateIssue(db, human, "SYD-1", { status: "todo" });
  updateIssue(db, human, "SYD-2", { status: "todo" });
  return { db, human, agent };
}

/** The exact pull_request shape the backfill/poller posts (github-poll-lib's
 * prPayload): action "opened" for OPEN, "closed" (+ merged flag) for
 * terminal, "synchronize" from a real webhook push. */
function prPayload(
  action: string,
  o: { prNumber: number; branch: string; sha: string; updatedAt: string; merged?: boolean },
) {
  return {
    action,
    pull_request: {
      number: o.prNumber,
      html_url: `https://github.com/${REPO}/pull/${o.prNumber}`,
      head: { ref: o.branch, sha: o.sha },
      updated_at: o.updatedAt,
      title: `${o.branch} work`,
      body: null,
      merged: o.merged ?? false,
      merge_commit_sha: o.merged ? `merge-${o.prNumber}` : null,
    },
  };
}

describe("search-vs-claim-gate agreement (SYD-207)", () => {
  it("the ?openPr= filter and the claim gate answer from the same oracle", () => {
    const { db, agent } = setup();
    handleGithubWebhook(
      db,
      "pull_request",
      prPayload("opened", {
        prNumber: 41,
        branch: "agent/SYD-1",
        sha: "aaa",
        updatedAt: "2026-07-13T10:00:00Z",
      }),
      REPO,
    );

    const flagged = searchIssues(db, { openPr: true }).map((i) => i.ref);
    expect(flagged).toEqual(["SYD-1"]);

    // Every issue search flags must be refused by the claim gate for the
    // open-PR reason; every issue it clears must be claimable.
    expect(() => claimIssue(db, agent, "SYD-1")).toThrowError(/open PR \(#41/);
    expect(claimIssue(db, agent, "SYD-2").status).toBe("in_progress");

    // Once the PR merges, both flip together.
    handleGithubWebhook(
      db,
      "pull_request",
      prPayload("closed", {
        prNumber: 41,
        branch: "agent/SYD-1",
        sha: "aaa",
        updatedAt: "2026-07-13T11:00:00Z",
        merged: true,
      }),
      REPO,
    );
    expect(searchIssues(db, { openPr: true })).toEqual([]);
    expect(claimIssue(db, agent, "SYD-1").status).toBe("in_progress");
  });
});

describe("backfill refuses out-of-project agent PRs (SYD-207)", () => {
  it("an agent/SYD-1 PR in another project's repo never gates SYD-1", () => {
    const { db, agent } = setup();
    // The backfill enumerates OTHER_REPO (bound to OTH) and finds a stray
    // agent/SYD-1 branch there. Ingestion must keep it display-only.
    const outcome = handleGithubWebhook(
      db,
      "pull_request",
      prPayload("opened", {
        prNumber: 9,
        branch: "agent/SYD-1",
        sha: "bbb",
        updatedAt: "2026-07-13T10:00:00Z",
      }),
      OTHER_REPO,
    );
    expect(outcome.handled).toBe(true);

    const row = findPrState(db, OTHER_REPO, 9);
    expect(row?.issueRef ?? null).toBeNull(); // no attributed row
    expect(getOpenPr(db, getIssue(db, "SYD-1").id)).toBeNull();
    expect(searchIssues(db, { openPr: true })).toEqual([]);
    expect(claimIssue(db, agent, "SYD-1").status).toBe("in_progress");
  });
});

describe("post-backfill synchronize freshness (SYD-207)", () => {
  it("a later synchronize updates headSha over the backfilled observation", () => {
    const { db } = setup();
    // Backfill-shaped observation: GitHub's own updated_at, never wall-clock.
    handleGithubWebhook(
      db,
      "pull_request",
      prPayload("opened", {
        prNumber: 41,
        branch: "agent/SYD-1",
        sha: "backfilled-sha",
        updatedAt: "2026-07-13T10:00:00Z",
      }),
      REPO,
    );
    // A real push after cutover: synchronize with a newer GitHub timestamp
    // must advance the row — this is what a wall-clock-stamped backfill
    // would have frozen out under the monotonic guard.
    handleGithubWebhook(
      db,
      "pull_request",
      prPayload("synchronize", {
        prNumber: 41,
        branch: "agent/SYD-1",
        sha: "fresh-sha",
        updatedAt: "2026-07-13T12:00:00Z",
      }),
      REPO,
    );
    const row = findPrState(db, REPO, 41);
    expect(row?.headSha).toBe("fresh-sha");
    expect(row?.ghUpdatedAt).toBe(Math.floor(Date.parse("2026-07-13T12:00:00Z") / 1000));
  });
});
