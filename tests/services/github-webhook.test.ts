import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue } from "../../src/services/issues.js";
import { getActivity } from "../../src/services/comments.js";
import { handleGithubWebhook, refFromBranch, refFromText } from "../../src/services/github-webhook.js";

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

describe("handleGithubWebhook / unhandled event types", () => {
  it("accepts push without recording an event", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "push", { ref: "refs/heads/agent/SYD-1" });
    expect(outcome).toEqual({ handled: false, reason: "push events are accepted but not processed yet" });
    expect(getActivity(db, "SYD-1").map((a) => a.type)).toEqual(["created"]);
  });

  it("reports unsupported for anything else", () => {
    const db = setup();
    const outcome = handleGithubWebhook(db, "issues", {});
    expect(outcome).toEqual({ handled: false, reason: 'unsupported event type "issues"' });
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
