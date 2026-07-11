import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue } from "../../src/services/issues.js";
import { getActivity } from "../../src/services/comments.js";
import { handleGithubWebhook, refFromBranch, refFromText, repositoryFullName } from "../../src/services/github-webhook.js";

function setup() {
  const db = openDb(":memory:");
  const human = createActor(db, { name: "sean", type: "human" }).actor;
  createProject(db, { key: "SYD", name: "Switchyard" });
  createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });
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
});

describe("handleGithubWebhook / pull_request", () => {
  it("records gh_pr_opened, matched by the agent/<ref> branch", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "pull_request", {
      action: "opened",
      pull_request: {
        number: 12, html_url: "https://github.com/acme/widgets/pull/12",
        head: { ref: "agent/SYD-1" }, title: "unrelated title", body: null,
      },
    });
    expect(outcome).toEqual({ handled: true, ref: "SYD-1", type: "gh_pr_opened" });
    const activity = getActivity(db, "SYD-1");
    const ev = activity.find((a) => a.type === "gh_pr_opened")!;
    expect(ev.payload).toEqual({ prNumber: 12, url: "https://github.com/acme/widgets/pull/12", branch: "agent/SYD-1" });
    expect(ev.actorName).toBe("github");
  });

  it("falls back to the PR title/body when the branch isn't agent/<ref>", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "pull_request", {
      action: "opened",
      pull_request: {
        number: 3, html_url: "https://github.com/acme/widgets/pull/3",
        head: { ref: "feature/manual-branch" }, title: "SYD-1: manual PR", body: null,
      },
    });
    expect(outcome).toMatchObject({ handled: true, ref: "SYD-1" });
  });

  it("records gh_pr_merged on a merged close, with the merge sha", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "pull_request", {
      action: "closed",
      pull_request: {
        number: 12, html_url: "https://github.com/acme/widgets/pull/12", merged: true,
        merge_commit_sha: "abc123", head: { ref: "agent/SYD-1" },
      },
    });
    expect(outcome).toEqual({ handled: true, ref: "SYD-1", type: "gh_pr_merged" });
    const ev = getActivity(db, "SYD-1").find((a) => a.type === "gh_pr_merged")!;
    expect(ev.payload).toEqual({ prNumber: 12, url: "https://github.com/acme/widgets/pull/12", mergeSha: "abc123" });
  });

  it("records gh_pr_closed on a non-merged close", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "pull_request", {
      action: "closed",
      pull_request: {
        number: 12, html_url: "https://github.com/acme/widgets/pull/12", merged: false,
        head: { ref: "agent/SYD-1" },
      },
    });
    expect(outcome).toEqual({ handled: true, ref: "SYD-1", type: "gh_pr_closed" });
  });

  it("ignores actions it doesn't model, like synchronize", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "pull_request", {
      action: "synchronize",
      pull_request: { number: 12, head: { ref: "agent/SYD-1" } },
    });
    expect(outcome).toEqual({ handled: false, reason: 'ignored pull_request action "synchronize"' });
  });

  it("reports unhandled when no ref can be resolved", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "pull_request", {
      action: "opened",
      pull_request: { number: 12, head: { ref: "main" }, title: "no ref", body: null },
    });
    expect(outcome).toEqual({ handled: false, reason: "no issue ref found in branch, title, or body" });
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
    expect(ev.payload).toEqual({ conclusion: "success", headSha: "deadbeef" });
  });

  it("records gh_checks_failed on a failing conclusion", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "check_suite", {
      action: "completed",
      check_suite: { head_branch: "agent/SYD-1", head_sha: "deadbeef", conclusion: "failure" },
    });
    expect(outcome).toEqual({ handled: true, ref: "SYD-1", type: "gh_checks_failed" });
  });

  it("matches via an associated pull_request's branch when head_branch isn't agent/<ref>", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "check_suite", {
      action: "completed",
      check_suite: {
        head_branch: "some-fork-branch", conclusion: "success",
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
      ref: "refs/heads/agent/SYD-1", deleted: true, after: "0".repeat(40), commits: [],
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
      ref: "refs/heads/main", commits: [{ message: "no ref here" }],
    });
    expect(outcome).toEqual({ handled: false, reason: "no issue ref found in branch or commit messages" });
  });

  it("reports unhandled when the matched ref doesn't exist in Switchyard", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "push", {
      ref: "refs/heads/agent/SYD-999", commits: [{ message: "wip" }],
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
        number: 12, html_url: "https://github.com/acme/widgets/pull/12",
        head: { ref: "agent/SYD-1" }, title: null, body: null,
      },
    };
    const first = handleGithubWebhook(db, "pull_request", payload);
    const redelivery = handleGithubWebhook(db, "pull_request", payload);
    expect(first).toEqual({ handled: true, ref: "SYD-1", type: "gh_pr_opened" });
    expect(redelivery).toEqual({ handled: true, ref: "SYD-1", type: "gh_pr_opened", duplicate: true });
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
      pull_request: { number: 12, html_url: "https://x/12", merged: false, head: { ref: "agent/SYD-1" } },
    });
    expect(outcome).toEqual({ handled: true, ref: "SYD-1", type: "gh_pr_closed" });
  });

  it("ignores a redelivered push with the same head sha", () => {
    const db = setup();
    const payload = {
      ref: "refs/heads/agent/SYD-1", after: "deadbeef", commits: [{ message: "wip" }],
    };
    handleGithubWebhook(db, "push", payload);
    const redelivery = handleGithubWebhook(db, "push", payload);
    expect(redelivery).toMatchObject({ handled: true, duplicate: true });
    expect(getActivity(db, "SYD-1").filter((a) => a.type === "gh_pushed")).toHaveLength(1);
  });

  it("does not inflate the commit count when the same push is redelivered", () => {
    const db = setup();
    const payload = {
      ref: "refs/heads/agent/SYD-1", after: "deadbeef", commits: [{ message: "one" }, { message: "two" }],
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
      action: "opened", pull_request: { number: 1, head: { ref: "agent/SYD-1" } },
    });
    handleGithubWebhook(db, "check_suite", {
      action: "completed", check_suite: { head_branch: "agent/SYD-1", conclusion: "success" },
    });
    const names = getActivity(db, "SYD-1").map((a) => a.actorName);
    expect(names).toEqual(["sean", "github", "github"]);
  });
});
