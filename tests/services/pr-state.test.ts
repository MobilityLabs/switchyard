// upsertPrState ordering discipline (SYD-206, spec: docs/2026-07-12-sync-
// simplification-assessment.md Step 1). GitHub webhooks are at-least-once and
// unordered, and the poller reads an eventually-consistent windowed search —
// these tests pin the rules that keep the mutable pr_state table from
// rebuilding the drift bug class the event-log derivation had.

import { describe, it, expect } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue } from "../../src/services/issues.js";
import { getActivity } from "../../src/services/comments.js";
import { addGithubRepo } from "../../src/services/github-repos.js";
import { recordEvent, listIssueEvents } from "../../src/services/events.js";
import {
  upsertPrState,
  findPrState,
  type PrObservation,
} from "../../src/services/pr-state.js";

const REPO = "acme/widgets";
const T1 = "2026-07-12T10:00:00Z";
const T2 = "2026-07-12T11:00:00Z";
const T3 = "2026-07-12T12:00:00Z";

function setup(opts: { bindRepo?: boolean } = {}) {
  const db = openDb(":memory:");
  const human = createActor(db, { name: "sean", type: "human" }).actor;
  const github = createActor(db, { name: "github", type: "agent" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });
  if (opts.bindRepo !== false) addGithubRepo(db, human, { fullName: REPO, projectKey: "SYD" });
  return { db, human, github };
}

function obs(o: Partial<PrObservation> = {}): PrObservation {
  return {
    repo: REPO,
    prNumber: 12,
    status: "open",
    branch: "agent/SYD-1",
    url: "https://github.com/acme/widgets/pull/12",
    headSha: "a".repeat(40),
    ghUpdatedAt: T1,
    ...o,
  };
}

describe("upsertPrState / insert + attribution", () => {
  it("inserts an open row from a first observation, attributed via branch + repo binding, and co-writes gh_pr_opened", () => {
    const { db, github } = setup();
    const outcome = upsertPrState(db, github, obs());
    expect(outcome).toMatchObject({ applied: true, transition: "opened" });

    const row = findPrState(db, REPO, 12)!;
    expect(row).toMatchObject({
      repo: REPO,
      prNumber: 12,
      status: "open",
      branch: "agent/SYD-1",
      issueRef: "SYD-1",
      headSha: "a".repeat(40),
      url: "https://github.com/acme/widgets/pull/12",
    });
    expect(row.ghUpdatedAt).toBe(Math.floor(Date.parse(T1) / 1000));

    const ev = listIssueEvents(db, 1).find((a) => a.type === "gh_pr_opened")!;
    expect(ev.payload).toMatchObject({
      prNumber: 12,
      branch: "agent/SYD-1",
      repo: REPO,
      headSha: "a".repeat(40),
      ghUpdatedAt: T1,
    });
    expect(row.lastTransitionEventId).toBe(ev.id);
  });

  it("refuses attribution for an agent/<ref> PR in a repo not bound to that ref's project (cross-repo), writing a display-only row and no event", () => {
    const { db, human, github } = setup();
    createProject(db, human, { key: "OTH", name: "Other" });
    addGithubRepo(db, human, { fullName: "acme/other", projectKey: "OTH" });

    const outcome = upsertPrState(db, github, obs({ repo: "acme/other" }));
    expect(outcome).toMatchObject({ applied: true, transition: "opened" });
    const row = findPrState(db, "acme/other", 12)!;
    expect(row.issueRef).toBeNull();
    expect(row.lastTransitionEventId).toBeNull();
    expect(getActivity(db, "SYD-1").map((a) => a.type)).toEqual(["created"]);
  });

  it("never attributes from a non-agent branch (free-text scanning stays display-only)", () => {
    const { db, github } = setup();
    upsertPrState(db, github, obs({ branch: "feat/manual-work" }));
    expect(findPrState(db, REPO, 12)!.issueRef).toBeNull();
  });

  it("preserves an existing attribution when a later observation lacks the branch", () => {
    const { db, github } = setup();
    upsertPrState(db, github, obs());
    upsertPrState(db, github, obs({ branch: null, ghUpdatedAt: T2 }));
    expect(findPrState(db, REPO, 12)!.issueRef).toBe("SYD-1");
  });

  it("heals a PR first observed already merged (never-saw-open), co-writing gh_pr_merged", () => {
    const { db, github } = setup();
    const outcome = upsertPrState(
      db,
      github,
      obs({ status: "merged", mergeSha: "m".repeat(40) }),
    );
    expect(outcome).toMatchObject({ applied: true, transition: "merged" });
    expect(findPrState(db, REPO, 12)!.status).toBe("merged");
    const ev = getActivity(db, "SYD-1").find((a) => a.type === "gh_pr_merged")!;
    expect(ev.payload).toMatchObject({ prNumber: 12, mergeSha: "m".repeat(40) });
  });

  it("does not double-write the canonical event when history already has it (pre-cutover events), reusing its id as the transition marker", () => {
    const { db, github } = setup();
    // The old webhook path recorded this merge before pr_state existed.
    recordEvent(db, {
      issueId: 1,
      actorId: github.id,
      type: "gh_pr_merged",
      payload: { prNumber: 12, url: "https://x/12", mergeSha: "old" },
    });
    const before = listIssueEvents(db, 1).filter((a) => a.type === "gh_pr_merged");
    expect(before).toHaveLength(1);

    const outcome = upsertPrState(db, github, obs({ status: "merged" }));
    expect(outcome).toMatchObject({ applied: true, transition: "merged" });
    const after = listIssueEvents(db, 1).filter((a) => a.type === "gh_pr_merged");
    expect(after).toHaveLength(1); // deduped
    expect(findPrState(db, REPO, 12)!.lastTransitionEventId).toBe(before[0].id);
  });
});

describe("upsertPrState / convergence + duplicates", () => {
  it("webhook and poller observations of the same (repo, prNumber) converge to one row and one opened event", () => {
    const { db, github } = setup();
    upsertPrState(db, github, obs()); // webhook
    upsertPrState(db, github, obs({ ghUpdatedAt: T2, headSha: "b".repeat(40) })); // poller, later
    const row = findPrState(db, REPO, 12)!;
    expect(row.headSha).toBe("b".repeat(40));
    expect(getActivity(db, "SYD-1").filter((a) => a.type === "gh_pr_opened")).toHaveLength(1);
  });

  it("a redelivered identical observation is a no-op", () => {
    const { db, github } = setup();
    upsertPrState(db, github, obs());
    const dup = upsertPrState(db, github, obs());
    expect(dup.transition).toBeNull();
    expect(getActivity(db, "SYD-1").filter((a) => a.type === "gh_pr_opened")).toHaveLength(1);
  });
});

describe("upsertPrState / terminal states never regress", () => {
  it("applies open→merged and co-writes gh_pr_merged", () => {
    const { db, github } = setup();
    upsertPrState(db, github, obs());
    const outcome = upsertPrState(
      db,
      github,
      obs({ status: "merged", ghUpdatedAt: T2, mergeSha: "m".repeat(40) }),
    );
    expect(outcome).toMatchObject({ applied: true, transition: "merged" });
    expect(findPrState(db, REPO, 12)!.status).toBe("merged");
  });

  it("ignores an out-of-order opened arriving after merged (no reopened flag)", () => {
    const { db, github } = setup();
    upsertPrState(db, github, obs({ status: "merged", ghUpdatedAt: T2 }));
    const outcome = upsertPrState(db, github, obs({ status: "open", ghUpdatedAt: T1 }));
    expect(outcome.applied).toBe(false);
    expect(findPrState(db, REPO, 12)!.status).toBe("merged");
    expect(getActivity(db, "SYD-1").filter((a) => a.type === "gh_pr_opened")).toHaveLength(0);
  });

  it("even a NEWER plain open observation never reopens a terminal row (stale search results can't resurrect)", () => {
    const { db, github } = setup();
    upsertPrState(db, github, obs({ status: "closed", ghUpdatedAt: T1 }));
    const outcome = upsertPrState(db, github, obs({ status: "open", ghUpdatedAt: T3 }));
    expect(outcome.applied).toBe(false);
    expect(findPrState(db, REPO, 12)!.status).toBe("closed");
  });

  it("allows closed→merged (a merge is more final) but never merged→closed", () => {
    const { db, github } = setup();
    upsertPrState(db, github, obs({ status: "closed", ghUpdatedAt: T1 }));
    expect(
      upsertPrState(db, github, obs({ status: "merged", ghUpdatedAt: T2 })).transition,
    ).toBe("merged");
    expect(upsertPrState(db, github, obs({ status: "closed", ghUpdatedAt: T3 })).applied).toBe(
      false,
    );
    expect(findPrState(db, REPO, 12)!.status).toBe("merged");
  });
});

describe("upsertPrState / reopened recency rule", () => {
  it("reopens a terminal row only via the explicit reopened flag with a strictly newer timestamp, co-writing gh_pr_reopened", () => {
    const { db, github } = setup();
    upsertPrState(db, github, obs({ status: "closed", ghUpdatedAt: T2 }));
    const outcome = upsertPrState(
      db,
      github,
      obs({ status: "open", reopened: true, ghUpdatedAt: T3 }),
    );
    expect(outcome).toMatchObject({ applied: true, transition: "reopened" });
    expect(findPrState(db, REPO, 12)!.status).toBe("open");
    expect(getActivity(db, "SYD-1").filter((a) => a.type === "gh_pr_reopened")).toHaveLength(1);
  });

  it("drops a stale or redelivered reopened whose timestamp is not newer than the stored terminal row", () => {
    const { db, github } = setup();
    upsertPrState(db, github, obs({ status: "closed", ghUpdatedAt: T2 }));
    // Same second — <= fails closed for reopening (never resurrects state).
    expect(
      upsertPrState(db, github, obs({ status: "open", reopened: true, ghUpdatedAt: T2 })).applied,
    ).toBe(false);
    expect(
      upsertPrState(db, github, obs({ status: "open", reopened: true, ghUpdatedAt: T1 })).applied,
    ).toBe(false);
    expect(findPrState(db, REPO, 12)!.status).toBe("closed");
  });

  it("fails closed when the reopened timestamp is missing or unparseable", () => {
    const { db, github } = setup();
    upsertPrState(db, github, obs({ status: "closed", ghUpdatedAt: T2 }));
    expect(
      upsertPrState(db, github, obs({ status: "open", reopened: true, ghUpdatedAt: null }))
        .applied,
    ).toBe(false);
    expect(
      upsertPrState(
        db,
        github,
        obs({ status: "open", reopened: true, ghUpdatedAt: "not-a-time" }),
      ).applied,
    ).toBe(false);
  });
});

describe("upsertPrState / monotonic same-status refresh", () => {
  it("applies a newer refresh (headSha advances) and drops an older one", () => {
    const { db, github } = setup();
    upsertPrState(db, github, obs({ ghUpdatedAt: T2, headSha: "b".repeat(40) }));
    // Older observation from the eventually-consistent poller: no-op.
    expect(upsertPrState(db, github, obs({ ghUpdatedAt: T1, headSha: "a".repeat(40) })).applied).toBe(
      false,
    );
    expect(findPrState(db, REPO, 12)!.headSha).toBe("b".repeat(40));
    // Newer observation applies.
    expect(upsertPrState(db, github, obs({ ghUpdatedAt: T3, headSha: "c".repeat(40) })).applied).toBe(
      true,
    );
    expect(findPrState(db, REPO, 12)!.headSha).toBe("c".repeat(40));
  });

  it("treats a same-second refresh as last-write-wins (documented tie behavior)", () => {
    const { db, github } = setup();
    upsertPrState(db, github, obs({ ghUpdatedAt: T2, headSha: "b".repeat(40) }));
    const tie = upsertPrState(db, github, obs({ ghUpdatedAt: T2, headSha: "d".repeat(40) }));
    expect(tie.applied).toBe(true);
    expect(findPrState(db, REPO, 12)!.headSha).toBe("d".repeat(40));
  });

  it("fails closed on a refresh with a missing timestamp (no freshness evidence, no update)", () => {
    const { db, github } = setup();
    upsertPrState(db, github, obs({ ghUpdatedAt: T2, headSha: "b".repeat(40) }));
    expect(upsertPrState(db, github, obs({ ghUpdatedAt: null, headSha: "e".repeat(40) })).applied).toBe(
      false,
    );
    expect(findPrState(db, REPO, 12)!.headSha).toBe("b".repeat(40));
  });

  it("lets a timestamped refresh land on a row that has no stored timestamp yet", () => {
    const { db, github } = setup();
    upsertPrState(db, github, obs({ ghUpdatedAt: null }));
    expect(upsertPrState(db, github, obs({ ghUpdatedAt: T1, headSha: "f".repeat(40) })).applied).toBe(
      true,
    );
    expect(findPrState(db, REPO, 12)!.headSha).toBe("f".repeat(40));
  });
});

describe("upsertPrState / SYD-202 replay", () => {
  it("a merge arriving under a new PR number yields a merged row and no phantom open row", () => {
    const { db, github } = setup();
    // Original PR opens, then delivery requeues: #12 closes, the merge lands as #15.
    upsertPrState(db, github, obs({ prNumber: 12, ghUpdatedAt: T1 }));
    upsertPrState(db, github, obs({ prNumber: 12, status: "closed", ghUpdatedAt: T2 }));
    upsertPrState(
      db,
      github,
      obs({ prNumber: 15, status: "merged", ghUpdatedAt: T3, mergeSha: "m".repeat(40) }),
    );

    expect(findPrState(db, REPO, 12)!.status).toBe("closed");
    expect(findPrState(db, REPO, 15)!.status).toBe("merged");
    const open = [12, 15].filter((n) => findPrState(db, REPO, n)!.status === "open");
    expect(open).toEqual([]);
  });
});
