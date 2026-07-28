import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, getIssue } from "../../src/services/issues.js";
import { getActivity } from "../../src/services/comments.js";
import { addGithubRepo } from "../../src/services/github-repos.js";
import { findPrState } from "../../src/services/pr-state.js";
import { getOpenPr } from "../../src/services/pr-status.js";
import {
  handleGithubWebhook,
  refFromBranch,
  refFromText,
  refsFromText,
  repositoryFullName,
} from "../../src/services/github-webhook.js";
import { listLiveLinks } from "../../src/services/pr-links.js";

function setup(boundRepos: string[] = []) {
  const db = openDb(":memory:");
  const human = createActor(db, { name: "sean", type: "human" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });
  for (const fullName of boundRepos) {
    addGithubRepo(db, human, { fullName, projectKey: "SYD" });
  }
  return db;
}

describe("refFromBranch / refFromText", () => {
  it("extracts a ref from an agent/<ref> branch and rejects other shapes", () => {
    expect(refFromBranch("agent/SYD-64")).toBe("SYD-64");
    expect(refFromBranch("main")).toBeNull();
    expect(refFromBranch("feat/agent-thing")).toBeNull();
    expect(refFromBranch(null)).toBeNull();
    expect(refFromBranch(42)).toBeNull();
  });

  it("scans free text for a bare ref", () => {
    expect(refFromText("SYD-64: add github integration")).toBe("SYD-64");
    expect(refFromText("fixes issue related to SYD-64 delivery")).toBe("SYD-64");
    expect(refFromText("no ref here")).toBeNull();
    expect(refFromText(null)).toBeNull();
  });

  // SYD-274: refFromText stops at the first match because one ref owns the
  // activity-feed line. refsFromText is for the rest of them.
  it("refsFromText returns every ref across the given strings, deduped in order", () => {
    expect(refsFromText(["feat: a thing (SYD-242)", "closes SYD-243, SYD-244"])).toEqual([
      "SYD-242",
      "SYD-243",
      "SYD-244",
    ]);
    expect(refsFromText(["SYD-1 and SYD-1 again", null, 42, "SYD-2"])).toEqual(["SYD-1", "SYD-2"]);
    expect(refsFromText(["no ref here"])).toEqual([]);
    expect(refsFromText([])).toEqual([]);
  });
});

describe("handleGithubWebhook / pull_request", () => {
  it("records gh_pr_opened, matched by the agent/<ref> branch", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "pull_request", {
      action: "opened",
      pull_request: {
        number: 12,
        html_url: "https://github.com/acme/widgets/pull/12",
        head: { ref: "agent/SYD-1" },
        title: "unrelated title",
        body: null,
      },
    });
    expect(outcome).toEqual({ handled: true, ref: "SYD-1", type: "gh_pr_opened" });
    const activity = getActivity(db, "SYD-1");
    const ev = activity.find((a) => a.type === "gh_pr_opened")!;
    expect(ev.payload).toEqual({
      prNumber: 12,
      url: "https://github.com/acme/widgets/pull/12",
      branch: "agent/SYD-1",
      repo: null,
      headSha: null,
      ghUpdatedAt: null,
    });
    expect(ev.actorName).toBe("github");
  });

  it("falls back to the PR title/body when the branch isn't agent/<ref>", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "pull_request", {
      action: "opened",
      pull_request: {
        number: 3,
        html_url: "https://github.com/acme/widgets/pull/3",
        head: { ref: "feature/manual-branch" },
        title: "SYD-1: manual PR",
        body: null,
      },
    });
    expect(outcome).toMatchObject({ handled: true, ref: "SYD-1" });
  });

  it("records gh_pr_merged on a merged close, with the merge sha", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "pull_request", {
      action: "closed",
      pull_request: {
        number: 12,
        html_url: "https://github.com/acme/widgets/pull/12",
        merged: true,
        merge_commit_sha: "abc123",
        head: { ref: "agent/SYD-1" },
      },
    });
    expect(outcome).toEqual({ handled: true, ref: "SYD-1", type: "gh_pr_merged" });
    const ev = getActivity(db, "SYD-1").find((a) => a.type === "gh_pr_merged")!;
    expect(ev.payload).toEqual({
      prNumber: 12,
      url: "https://github.com/acme/widgets/pull/12",
      mergeSha: "abc123",
      repo: null,
      headSha: null,
      ghUpdatedAt: null,
    });
  });

  it("records gh_pr_closed on a non-merged close", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "pull_request", {
      action: "closed",
      pull_request: {
        number: 12,
        html_url: "https://github.com/acme/widgets/pull/12",
        merged: false,
        head: { ref: "agent/SYD-1" },
      },
    });
    expect(outcome).toEqual({ handled: true, ref: "SYD-1", type: "gh_pr_closed" });
  });

  it("ignores actions it doesn't model, like assigned", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "pull_request", {
      action: "assigned",
      pull_request: { number: 12, head: { ref: "agent/SYD-1" } },
    });
    expect(outcome).toEqual({
      handled: false,
      reason: 'ignored pull_request action "assigned"',
    });
  });

  it("reports unhandled when no ref can be resolved", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "pull_request", {
      action: "opened",
      pull_request: { number: 12, head: { ref: "main" }, title: "no ref", body: null },
    });
    expect(outcome).toEqual({
      handled: false,
      reason: "no issue ref found in branch, title, or body",
    });
  });

  it("reports unhandled when the matched ref doesn't exist in Switchyard", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "pull_request", {
      action: "opened",
      pull_request: { number: 12, head: { ref: "agent/SYD-999" } },
    });
    expect(outcome).toEqual({ handled: false, reason: "no Switchyard issue matches ref SYD-999" });
  });
});

describe("handleGithubWebhook / check_suite", () => {
  it("records gh_checks_passed on a successful completed suite", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "check_suite", {
      action: "completed",
      check_suite: { head_branch: "agent/SYD-1", head_sha: "deadbeef", conclusion: "success" },
    });
    expect(outcome).toEqual({ handled: true, ref: "SYD-1", type: "gh_checks_passed" });
    const ev = getActivity(db, "SYD-1").find((a) => a.type === "gh_checks_passed")!;
    expect(ev.payload).toEqual({ conclusion: "success", headSha: "deadbeef", repo: null });
  });

  it("records gh_checks_failed on a failing conclusion", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "check_suite", {
      action: "completed",
      check_suite: { head_branch: "agent/SYD-1", head_sha: "deadbeef", conclusion: "failure" },
    });
    expect(outcome).toEqual({ handled: true, ref: "SYD-1", type: "gh_checks_failed" });
  });

  it.each(["timed_out", "action_required", "startup_failure"])(
    "records gh_checks_failed on conclusion %s",
    (conclusion) => {
      const db = setup();
      const outcome = handleGithubWebhook(db, "check_suite", {
        action: "completed",
        check_suite: { head_branch: "agent/SYD-1", head_sha: "deadbeef", conclusion },
      });
      expect(outcome).toEqual({ handled: true, ref: "SYD-1", type: "gh_checks_failed" });
    },
  );

  it.each(["neutral", "skipped", "cancelled", "stale"])(
    "does not record gh_checks_failed for the non-failure conclusion %s",
    (conclusion) => {
      const db = setup();
      const outcome = handleGithubWebhook(db, "check_suite", {
        action: "completed",
        check_suite: { head_branch: "agent/SYD-1", head_sha: "deadbeef", conclusion },
      });
      expect(outcome).toEqual({
        handled: false,
        reason: `ignored check_suite conclusion "${conclusion}"`,
      });
      expect(
        getActivity(db, "SYD-1").filter(
          (a) => a.type === "gh_checks_passed" || a.type === "gh_checks_failed",
        ),
      ).toHaveLength(0);
    },
  );

  it("matches via an associated pull_request's branch when head_branch isn't agent/<ref>", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "check_suite", {
      action: "completed",
      check_suite: {
        head_branch: "some-fork-branch",
        conclusion: "success",
        pull_requests: [{ head: { ref: "agent/SYD-1" } }],
      },
    });
    expect(outcome).toMatchObject({ handled: true, ref: "SYD-1" });
  });

  it("ignores non-completed actions", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "check_suite", {
      action: "requested",
      check_suite: { head_branch: "agent/SYD-1" },
    });
    expect(outcome).toEqual({ handled: false, reason: 'ignored check_suite action "requested"' });
  });
});

describe("handleGithubWebhook / push", () => {
  it("records gh_pushed, matched by the agent/<ref> branch", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "push", {
      ref: "refs/heads/agent/SYD-1",
      after: "deadbeefcafe",
      compare: "https://github.com/acme/widgets/compare/abc...deadbeefcafe",
      commits: [{ message: "wip" }, { message: "more wip" }],
    });
    expect(outcome).toEqual({ handled: true, ref: "SYD-1", type: "gh_pushed" });
    const ev = getActivity(db, "SYD-1").find((a) => a.type === "gh_pushed")!;
    expect(ev.payload).toEqual({
      commitCount: 2,
      headSha: "deadbeefcafe",
      branch: "agent/SYD-1",
      url: "https://github.com/acme/widgets/compare/abc...deadbeefcafe",
      repo: null,
    });
    expect(ev.actorName).toBe("github");
  });

  it("falls back to a commit message when the branch isn't agent/<ref>", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "push", {
      ref: "refs/heads/feature/manual-branch",
      after: "sha1",
      commits: [{ message: "unrelated" }, { message: "SYD-1: fix thing" }],
    });
    expect(outcome).toMatchObject({ handled: true, ref: "SYD-1", type: "gh_pushed" });
  });

  it("ignores a branch-deletion push", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "push", {
      ref: "refs/heads/agent/SYD-1",
      deleted: true,
      after: "0".repeat(40),
      commits: [],
    });
    expect(outcome).toEqual({ handled: false, reason: "ignored branch-deletion push" });
    expect(getActivity(db, "SYD-1").map((a) => a.type)).toEqual(["created"]);
  });

  it("ignores a push with no commits", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "push", { ref: "refs/heads/agent/SYD-1", commits: [] });
    expect(outcome).toEqual({ handled: false, reason: "push has no commits" });
    expect(getActivity(db, "SYD-1").map((a) => a.type)).toEqual(["created"]);
  });

  it("reports unhandled when no ref can be resolved", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "push", {
      ref: "refs/heads/main",
      commits: [{ message: "no ref here" }],
    });
    expect(outcome).toEqual({
      handled: false,
      reason: "no issue ref found in branch or commit messages",
    });
  });

  it("reports unhandled when the matched ref doesn't exist in Switchyard", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "push", {
      ref: "refs/heads/agent/SYD-999",
      commits: [{ message: "wip" }],
    });
    expect(outcome).toEqual({ handled: false, reason: "no Switchyard issue matches ref SYD-999" });
  });
});

describe("handleGithubWebhook / idempotency (SYD-125)", () => {
  it("ignores a redelivered gh_pr_opened for the same PR number", () => {
    const db = setup();
    const payload = {
      action: "opened",
      pull_request: {
        number: 12,
        html_url: "https://github.com/acme/widgets/pull/12",
        head: { ref: "agent/SYD-1" },
        title: null,
        body: null,
      },
    };
    const first = handleGithubWebhook(db, "pull_request", payload);
    const redelivery = handleGithubWebhook(db, "pull_request", payload);
    expect(first).toEqual({ handled: true, ref: "SYD-1", type: "gh_pr_opened" });
    expect(redelivery).toEqual({
      handled: true,
      ref: "SYD-1",
      type: "gh_pr_opened",
      duplicate: true,
    });
    expect(getActivity(db, "SYD-1").filter((a) => a.type === "gh_pr_opened")).toHaveLength(1);
  });

  it("still records a close for a different PR number after an open was recorded", () => {
    const db = setup();
    handleGithubWebhook(db, "pull_request", {
      action: "opened",
      pull_request: { number: 12, html_url: "https://x/12", head: { ref: "agent/SYD-1" } },
    });
    const outcome = handleGithubWebhook(db, "pull_request", {
      action: "closed",
      pull_request: {
        number: 12,
        html_url: "https://x/12",
        merged: false,
        head: { ref: "agent/SYD-1" },
      },
    });
    expect(outcome).toEqual({ handled: true, ref: "SYD-1", type: "gh_pr_closed" });
  });

  it("ignores a redelivered push with the same head sha", () => {
    const db = setup();
    const payload = {
      ref: "refs/heads/agent/SYD-1",
      after: "deadbeef",
      commits: [{ message: "wip" }],
    };
    handleGithubWebhook(db, "push", payload);
    const redelivery = handleGithubWebhook(db, "push", payload);
    expect(redelivery).toMatchObject({ handled: true, duplicate: true });
    expect(getActivity(db, "SYD-1").filter((a) => a.type === "gh_pushed")).toHaveLength(1);
  });

  it("does not inflate the commit count when the same push is redelivered", () => {
    const db = setup();
    const payload = {
      ref: "refs/heads/agent/SYD-1",
      after: "deadbeef",
      commits: [{ message: "one" }, { message: "two" }],
    };
    handleGithubWebhook(db, "push", payload);
    handleGithubWebhook(db, "push", payload);
    const events = getActivity(db, "SYD-1").filter((a) => a.type === "gh_pushed");
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ commitCount: 2 });
  });

  it("ignores a redelivered check_suite with the same head sha and conclusion", () => {
    const db = setup();
    const payload = {
      action: "completed",
      check_suite: { head_branch: "agent/SYD-1", head_sha: "deadbeef", conclusion: "success" },
    };
    handleGithubWebhook(db, "check_suite", payload);
    const redelivery = handleGithubWebhook(db, "check_suite", payload);
    expect(redelivery).toMatchObject({ handled: true, duplicate: true });
    expect(getActivity(db, "SYD-1").filter((a) => a.type === "gh_checks_passed")).toHaveLength(1);
  });

  it("records a failure and a later success for the same head sha as distinct events", () => {
    const db = setup();
    handleGithubWebhook(db, "check_suite", {
      action: "completed",
      check_suite: { head_branch: "agent/SYD-1", head_sha: "deadbeef", conclusion: "failure" },
    });
    const outcome = handleGithubWebhook(db, "check_suite", {
      action: "completed",
      check_suite: { head_branch: "agent/SYD-1", head_sha: "deadbeef", conclusion: "success" },
    });
    expect(outcome).toEqual({ handled: true, ref: "SYD-1", type: "gh_checks_passed" });
  });
});

describe("handleGithubWebhook / ingestion groundwork (SYD-205)", () => {
  const opened = (extra: Record<string, unknown> = {}, pr: Record<string, unknown> = {}) => ({
    action: "opened",
    pull_request: {
      number: 12,
      html_url: "https://github.com/acme/widgets/pull/12",
      head: { ref: "agent/SYD-1", sha: "a".repeat(40) },
      updated_at: "2026-07-12T10:00:00Z",
      title: null,
      body: null,
      ...pr,
    },
    ...extra,
  });

  it("records repo, headSha, and ghUpdatedAt from a full webhook payload", () => {
    const db = setup();
    handleGithubWebhook(db, "pull_request", opened({ repository: { full_name: "acme/widgets" } }));
    const ev = getActivity(db, "SYD-1").find((a) => a.type === "gh_pr_opened")!;
    expect(ev.payload).toEqual({
      prNumber: 12,
      url: "https://github.com/acme/widgets/pull/12",
      branch: "agent/SYD-1",
      repo: "acme/widgets",
      headSha: "a".repeat(40),
      ghUpdatedAt: "2026-07-12T10:00:00Z",
    });
  });

  it("prefers an explicitly passed repo (the /github-events top-level field) over inference", () => {
    const db = setup(["acme/bound"]);
    handleGithubWebhook(db, "pull_request", opened(), "acme/explicit");
    const ev = getActivity(db, "SYD-1").find((a) => a.type === "gh_pr_opened")!;
    expect(ev.payload).toMatchObject({ repo: "acme/explicit" });
  });

  it("infers repo from the issue's project's sole bound repo when the payload has none", () => {
    const db = setup(["acme/bound"]);
    handleGithubWebhook(db, "pull_request", opened());
    const ev = getActivity(db, "SYD-1").find((a) => a.type === "gh_pr_opened")!;
    expect(ev.payload).toMatchObject({ repo: "acme/bound" });
  });

  it("rejects instead of guessing when the project has several bound repos and no repo is named", () => {
    const db = setup(["acme/one", "acme/two"]);
    const outcome = handleGithubWebhook(db, "pull_request", opened());
    expect(outcome).toEqual({
      handled: false,
      reason:
        "repo is ambiguous — the issue's project has multiple bound repos and the delivery does not name one",
    });
    expect(getActivity(db, "SYD-1").map((a) => a.type)).toEqual(["created"]);
  });

  it("parses a malformed updated_at fail-closed to null", () => {
    const db = setup();
    handleGithubWebhook(db, "pull_request", opened({}, { updated_at: "not-a-timestamp" }));
    const ev = getActivity(db, "SYD-1").find((a) => a.type === "gh_pr_opened")!;
    expect(ev.payload).toMatchObject({ ghUpdatedAt: null });
  });

  it("acknowledges synchronize without recording an event (upsertPrState hooks in at SYD-206)", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "pull_request", {
      ...opened(),
      action: "synchronize",
    });
    expect(outcome).toEqual({
      handled: true,
      ref: "SYD-1",
      type: "synchronize",
      recorded: false,
    });
    expect(getActivity(db, "SYD-1").map((a) => a.type)).toEqual(["created"]);
  });

  it("records gh_pr_reopened with repo/headSha/ghUpdatedAt on a reopened action", () => {
    const db = setup(["acme/bound"]);
    const outcome = handleGithubWebhook(db, "pull_request", {
      ...opened(),
      action: "reopened",
    });
    expect(outcome).toEqual({ handled: true, ref: "SYD-1", type: "gh_pr_reopened" });
    const ev = getActivity(db, "SYD-1").find((a) => a.type === "gh_pr_reopened")!;
    expect(ev.payload).toEqual({
      prNumber: 12,
      url: "https://github.com/acme/widgets/pull/12",
      branch: "agent/SYD-1",
      repo: "acme/bound",
      headSha: "a".repeat(40),
      ghUpdatedAt: "2026-07-12T10:00:00Z",
    });
  });

  it("dedupes a redelivered reopened by its GitHub timestamp, but records a genuinely newer reopen", () => {
    const db = setup();
    const payload = { ...opened(), action: "reopened" };
    handleGithubWebhook(db, "pull_request", payload);
    const redelivery = handleGithubWebhook(db, "pull_request", payload);
    expect(redelivery).toMatchObject({ handled: true, duplicate: true });
    const later = handleGithubWebhook(db, "pull_request", {
      ...opened({}, { updated_at: "2026-07-12T11:30:00Z" }),
      action: "reopened",
    });
    expect(later).toEqual({ handled: true, ref: "SYD-1", type: "gh_pr_reopened" });
    expect(getActivity(db, "SYD-1").filter((a) => a.type === "gh_pr_reopened")).toHaveLength(2);
  });

  it("threads repo into check_suite and push payloads too", () => {
    const db = setup();
    handleGithubWebhook(
      db,
      "check_suite",
      {
        action: "completed",
        check_suite: { head_branch: "agent/SYD-1", head_sha: "deadbeef", conclusion: "success" },
      },
      "acme/widgets",
    );
    handleGithubWebhook(
      db,
      "push",
      { ref: "refs/heads/agent/SYD-1", after: "cafe1234", commits: [{ message: "wip" }] },
      "acme/widgets",
    );
    const activity = getActivity(db, "SYD-1");
    expect(activity.find((a) => a.type === "gh_checks_passed")!.payload).toMatchObject({
      repo: "acme/widgets",
    });
    expect(activity.find((a) => a.type === "gh_pushed")!.payload).toMatchObject({
      repo: "acme/widgets",
    });
  });
});

describe("handleGithubWebhook / pr_state integration (SYD-206)", () => {
  const opened = (action: string, pr: Record<string, unknown> = {}) => ({
    action,
    repository: { full_name: "acme/bound" },
    pull_request: {
      number: 12,
      html_url: "https://github.com/acme/bound/pull/12",
      head: { ref: "agent/SYD-1", sha: "a".repeat(40) },
      updated_at: "2026-07-12T10:00:00Z",
      title: null,
      body: null,
      ...pr,
    },
  });

  it("writes an attributed pr_state row on opened, with exactly one gh_pr_opened event (co-write, no double record)", () => {
    const db = setup(["acme/bound"]);
    const outcome = handleGithubWebhook(db, "pull_request", opened("opened"));
    expect(outcome).toEqual({ handled: true, ref: "SYD-1", type: "gh_pr_opened" });
    const row = findPrState(db, "acme/bound", 12)!;
    expect(row).toMatchObject({ status: "open", issueRef: "SYD-1", headSha: "a".repeat(40) });
    expect(getActivity(db, "SYD-1").filter((a) => a.type === "gh_pr_opened")).toHaveLength(1);
  });

  it("transitions the row to merged on a merged close", () => {
    const db = setup(["acme/bound"]);
    handleGithubWebhook(db, "pull_request", opened("opened"));
    handleGithubWebhook(db, "pull_request", {
      ...opened("closed", {
        merged: true,
        merge_commit_sha: "m".repeat(40),
        updated_at: "2026-07-12T11:00:00Z",
      }),
    });
    expect(findPrState(db, "acme/bound", 12)!.status).toBe("merged");
    expect(getActivity(db, "SYD-1").filter((a) => a.type === "gh_pr_merged")).toHaveLength(1);
  });

  it("synchronize refreshes headSha/ghUpdatedAt on the row without recording an event", () => {
    const db = setup(["acme/bound"]);
    handleGithubWebhook(db, "pull_request", opened("opened"));
    const outcome = handleGithubWebhook(
      db,
      "pull_request",
      opened("synchronize", {
        head: { ref: "agent/SYD-1", sha: "b".repeat(40) },
        updated_at: "2026-07-12T11:00:00Z",
      }),
    );
    expect(outcome).toEqual({ handled: true, ref: "SYD-1", type: "synchronize", recorded: false });
    const row = findPrState(db, "acme/bound", 12)!;
    expect(row.headSha).toBe("b".repeat(40));
    expect(row.ghUpdatedAt).toBe(Math.floor(Date.parse("2026-07-12T11:00:00Z") / 1000));
    expect(getActivity(db, "SYD-1").map((a) => a.type)).toEqual(["created", "gh_pr_opened"]);
  });

  it("an out-of-order stale synchronize does not regress the stored headSha", () => {
    const db = setup(["acme/bound"]);
    handleGithubWebhook(
      db,
      "pull_request",
      opened("opened", {
        head: { ref: "agent/SYD-1", sha: "b".repeat(40) },
        updated_at: "2026-07-12T11:00:00Z",
      }),
    );
    handleGithubWebhook(
      db,
      "pull_request",
      opened("synchronize", {
        head: { ref: "agent/SYD-1", sha: "a".repeat(40) },
        updated_at: "2026-07-12T09:00:00Z",
      }),
    );
    expect(findPrState(db, "acme/bound", 12)!.headSha).toBe("b".repeat(40));
  });

  it("reopened after close makes the row open again", () => {
    const db = setup(["acme/bound"]);
    handleGithubWebhook(db, "pull_request", opened("opened"));
    handleGithubWebhook(
      db,
      "pull_request",
      opened("closed", { merged: false, updated_at: "2026-07-12T11:00:00Z" }),
    );
    expect(findPrState(db, "acme/bound", 12)!.status).toBe("closed");
    handleGithubWebhook(
      db,
      "pull_request",
      opened("reopened", { updated_at: "2026-07-12T12:00:00Z" }),
    );
    expect(findPrState(db, "acme/bound", 12)!.status).toBe("open");
    expect(getActivity(db, "SYD-1").filter((a) => a.type === "gh_pr_reopened")).toHaveLength(1);
  });

  it("a late redelivered opened after a close leaves the row closed and adds no event", () => {
    const db = setup(["acme/bound"]);
    handleGithubWebhook(db, "pull_request", opened("opened"));
    handleGithubWebhook(
      db,
      "pull_request",
      opened("closed", { merged: false, updated_at: "2026-07-12T11:00:00Z" }),
    );
    const redelivery = handleGithubWebhook(db, "pull_request", opened("opened"));
    expect(redelivery).toMatchObject({ handled: true, duplicate: true });
    expect(findPrState(db, "acme/bound", 12)!.status).toBe("closed");
    expect(getActivity(db, "SYD-1").filter((a) => a.type === "gh_pr_opened")).toHaveLength(1);
  });

  it("a text-matched PR (non-agent branch) records display events and an UNATTRIBUTED pr_state row", () => {
    const db = setup(["acme/bound"]);
    handleGithubWebhook(db, "pull_request", {
      action: "opened",
      repository: { full_name: "acme/bound" },
      pull_request: {
        number: 33,
        html_url: "https://github.com/acme/bound/pull/33",
        head: { ref: "feat/manual", sha: "c".repeat(40) },
        updated_at: "2026-07-12T10:00:00Z",
        title: "SYD-1: manual fix",
        body: null,
      },
    });
    // SYD-287: every PR in a bound repo is observed, because pr_state records
    // what GitHub did and never whose work it is. The row carries no
    // attribution — issueRef null, no delivers link — so it gates nothing.
    // Attribution is tested through pr-status.ts in pr-observation.test.ts.
    expect(findPrState(db, "acme/bound", 33)).toMatchObject({ status: "open", issueRef: null });
    expect(getActivity(db, "SYD-1").filter((a) => a.type === "gh_pr_opened")).toHaveLength(1);
  });

  it("attributes and writes pr_state despite a casing mismatch between the linked repo and the payload's repository.full_name (SYD-212)", () => {
    // Repo linked with a hand-typed lowercase full name...
    const db = setup(["acme/bound"]);
    // ...but the real webhook delivery carries GitHub's canonical case.
    const outcome = handleGithubWebhook(db, "pull_request", {
      ...opened("opened"),
      repository: { full_name: "Acme/Bound" },
    });
    expect(outcome).toEqual({ handled: true, ref: "SYD-1", type: "gh_pr_opened" });
    const row = findPrState(db, "acme/bound", 12)!;
    expect(row).toMatchObject({ status: "open", issueRef: "SYD-1", repo: "acme/bound" });
    // The stored row itself is normalized, not left as the canonical-case
    // string the payload happened to carry.
    expect(findPrState(db, "Acme/Bound", 12)?.repo).toBe("acme/bound");
  });

  it("an agent/SYD-1 PR in a repo bound to another project is never attributed to SYD-1 (cross-repo)", () => {
    const db = setup(["acme/bound"]);
    const human = createActor(db, { name: "sean2", type: "human" }).actor;
    createProject(db, human, { key: "OTH", name: "Other" });
    addGithubRepo(db, human, { fullName: "acme/other", projectKey: "OTH" });

    handleGithubWebhook(db, "pull_request", {
      ...opened("opened"),
      repository: { full_name: "acme/other" },
    });
    // acme/other is bound (to OTH), so the PR is observed — but the branch
    // says SYD-1 while the repo belongs to OTH, so attributedRef refuses and
    // the row stays unattributed. This is the cross-project hole SYD-206
    // closed, and observing everything must not reopen it.
    expect(findPrState(db, "acme/other", 12)).toMatchObject({ issueRef: null });
    expect(getOpenPr(db, getIssue(db, "SYD-1").id)).toBeNull();
    expect(getActivity(db, "SYD-1").filter((a) => a.type === "gh_pr_opened")).toHaveLength(1);
  });

  it("a PR in a linked-but-UNBOUND repo is not observed at all", () => {
    const db = setup(["acme/bound"]);
    const human = createActor(db, { name: "sean3", type: "human" }).actor;
    // Linked with no projectKey — the SYD-207 preflight's warning case.
    addGithubRepo(db, human, { fullName: "acme/unbound" });

    handleGithubWebhook(db, "pull_request", {
      ...opened("opened"),
      repository: { full_name: "acme/unbound" },
    });
    // Bound-to-a-project is the line SYD-287 draws: an unbound repo silently
    // accruing rows would paper over exactly the misconfiguration the
    // preflight exists to surface.
    expect(findPrState(db, "acme/unbound", 12)).toBeUndefined();
  });
});

describe("handleGithubWebhook / unhandled event types", () => {
  it("reports unsupported for anything else", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "issues", {});
    expect(outcome).toEqual({ handled: false, reason: 'unsupported event type "issues"' });
  });
});

describe("handleGithubWebhook / malformed payloads", () => {
  it("reports unhandled instead of throwing when pull_request is the wrong shape", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "pull_request", {
      action: "opened",
      pull_request: "not-an-object",
    });
    expect(outcome).toEqual({ handled: false, reason: "malformed pull_request payload" });
  });

  it("reports unhandled instead of throwing when a push commit isn't an object", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "push", {
      ref: "refs/heads/agent/SYD-1",
      commits: ["not-an-object"],
    });
    expect(outcome).toEqual({ handled: false, reason: "malformed push payload" });
  });

  it("reports unhandled instead of throwing when check_suite.pull_requests is the wrong shape", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "check_suite", {
      action: "completed",
      check_suite: { head_branch: "agent/SYD-1", pull_requests: "not-an-array" },
    });
    expect(outcome).toEqual({ handled: false, reason: "malformed check_suite payload" });
  });

  it("reports unhandled instead of throwing when the top-level payload isn't an object", () => {
    const db = setup();
    expect(handleGithubWebhook(db, "pull_request", null)).toEqual({
      handled: false,
      reason: "malformed pull_request payload",
    });
    expect(handleGithubWebhook(db, "push", "oops")).toEqual({
      handled: false,
      reason: "malformed push payload",
    });
  });
});

describe("repositoryFullName", () => {
  it("extracts repository.full_name from a well-shaped payload", () => {
    expect(repositoryFullName({ repository: { full_name: "acme/widgets" } })).toBe("acme/widgets");
  });

  it("returns undefined for missing or malformed repository fields", () => {
    expect(repositoryFullName({})).toBeUndefined();
    expect(repositoryFullName({ repository: {} })).toBeUndefined();
    expect(repositoryFullName({ repository: { full_name: 42 } })).toBeUndefined();
    expect(repositoryFullName(null)).toBeUndefined();
    expect(repositoryFullName("oops")).toBeUndefined();
  });
});

describe("handleGithubWebhook / actor reuse", () => {
  it("reuses the same github actor across deliveries instead of erroring on the second create", () => {
    const db = setup();
    handleGithubWebhook(db, "pull_request", {
      action: "opened",
      pull_request: { number: 1, head: { ref: "agent/SYD-1" } },
    });
    handleGithubWebhook(db, "check_suite", {
      action: "completed",
      check_suite: { head_branch: "agent/SYD-1", conclusion: "success" },
    });
    const names = getActivity(db, "SYD-1").map((a) => a.actorName);
    expect(names).toEqual(["sean", "github", "github"]);
  });
});

// SYD-274: one PR routinely carries several issues' work — 0ae22a9 closed
// SYD-243 and SYD-244 under SYD-242's PR. Before this, only the first ref the
// text named got anything; the siblings held no event, no link, no trace the
// PR existed, so their done_without_merged_pr warnings had no evidence to
// reach and stayed lit with no path out but archaeology.
describe("handleGithubWebhook / sibling refs named in PR text (SYD-274)", () => {
  function multiIssueSetup() {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    createProject(db, human, { key: "SYD", name: "Switchyard" });
    createProject(db, human, { key: "NOC", name: "Piano" });
    createIssue(db, human, { projectKey: "SYD", title: "parent" }); // SYD-1
    createIssue(db, human, { projectKey: "SYD", title: "sibling a" }); // SYD-2
    createIssue(db, human, { projectKey: "SYD", title: "sibling b" }); // SYD-3
    createIssue(db, human, { projectKey: "NOC", title: "other project" }); // NOC-1
    addGithubRepo(db, human, { fullName: "acme/widgets", projectKey: "SYD" });
    return { db, human };
  }

  const closingPr = (body: string) => ({
    action: "closed",
    repository: { full_name: "acme/widgets" },
    pull_request: {
      number: 206,
      html_url: "https://github.com/acme/widgets/pull/206",
      head: { ref: "feat/multi", sha: "a".repeat(40) },
      updated_at: "2026-07-27T10:00:00Z",
      merged: true,
      merge_commit_sha: "0ae22a9".padEnd(40, "0"),
      title: "feat: a thing (SYD-1)",
      body,
    },
  });

  it("mints a references link on every sibling the text names, not just the first", () => {
    const { db } = multiIssueSetup();
    handleGithubWebhook(db, "pull_request", closingPr("closes SYD-2, SYD-3"));
    for (const ref of ["SYD-1", "SYD-2", "SYD-3"]) {
      const links = listLiveLinks(db, getIssue(db, ref).id);
      expect(
        links.map((l) => l.prNumber),
        `${ref} should link PR 206`,
      ).toEqual([206]);
    }
  });

  // The load-bearing half. SYD-280 removed free-text clearing precisely so a
  // passing mention could not silence a safety net; widening WHICH refs get a
  // suggestion must not widen what a suggestion is worth.
  it("mints them as inert references suggestions — never delivers, never confirmed", () => {
    const { db } = multiIssueSetup();
    handleGithubWebhook(db, "pull_request", closingPr("closes SYD-2, SYD-3"));
    for (const ref of ["SYD-2", "SYD-3"]) {
      const [link] = listLiveLinks(db, getIssue(db, ref).id);
      expect(link.role, `${ref} role`).toBe("references");
      expect(link.confirmedBy, `${ref} confirmedBy`).toBeNull();
    }
  });

  it("ignores refs from another project — a cross-project link would be a guess", () => {
    const { db } = multiIssueSetup();
    handleGithubWebhook(db, "pull_request", closingPr("also mentions NOC-1"));
    expect(listLiveLinks(db, getIssue(db, "NOC-1").id)).toEqual([]);
  });

  it("ignores refs naming no issue", () => {
    const { db } = multiIssueSetup();
    const outcome = handleGithubWebhook(db, "pull_request", closingPr("closes SYD-2, SYD-999"));
    expect(outcome.handled).toBe(true);
    expect(listLiveLinks(db, getIssue(db, "SYD-2").id)).toHaveLength(1);
  });
});
