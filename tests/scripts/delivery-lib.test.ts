import { describe, it, expect } from "vitest";
import {
  agentBranch,
  resolveInfraToken,
  resolveDeliveryToken,
  resolvePollerToken,
  tokenSourceName,
  filterWorkToProjects,
  resumeActionFor,
  crashedAttemptComment,
  buildPushArgs,
  buildPrListArgs,
  buildPrCreateArgs,
  buildPrMergeArgs,
  buildPrViewUrlArgs,
  buildPrViewFreshnessArgs,
  buildPrViewLiveStateArgs,
  buildPrViewMergeShaArgs,
  parseOwnerRepo,
  buildPrTitle,
  buildPrBody,
  buildFetchAgentBranchArgs,
  buildCheckoutRebaseBranchArgs,
  buildRebaseOntoMainArgs,
  buildRebaseAbortArgs,
  buildConflictFilesArgs,
  buildForcePushWithLeaseArgs,
  buildPrViewMergeableArgs,
  shouldRetryMergePoll,
  MERGE_POLL_TIMEOUT_MS,
  buildPrViewChecksArgs,
  evaluateChecks,
  shouldKeepWaitingForChecks,
  nextChecksWaitAction,
  HEAD_MOVED_SETTLE_MS,
  CHECKS_WAIT_TIMEOUT_MS,
  deliveryComment,
  deliveryFailureComment,
  publishFailureComment,
  checksFailedComment,
  checksTimeoutComment,
  shaChainDisarmedComment,
  formatPublishOutcome,
  parsePrNumberFromUrl,
  tailOf,
  shouldRetryQueueRebase,
  MAX_QUEUE_MERGE_ATTEMPTS,
  queueRebaseConflictComment,
  noBranchBounceComment,
  queueDeliveredNote,
  buildBranchProtectionArgs,
  evaluateBranchProtection,
  deliverableProjectKeys,
  refsHeldBackByProtection,
  buildPrListMergedArgs,
  closedPrAlreadyDeliveredComment,
  closedPrDeadEndComment,
  gitSshCommand,
  buildPrCloseArgs,
  type DeliveryWork,
} from "../../scripts/delivery-lib.js";

// Delivery and the GitHub poller are separate least-privilege `service`
// actors (deliver-poller / github-poller-svc), so they resolve their own
// tokens. The legacy tail exists because the worker host's .env is deployed
// separately from the tracker, so a host still carrying the old shared names
// must keep working through the rollout.
describe("resolveDeliveryToken / resolvePollerToken", () => {
  const legacy = { SWITCHYARD_SERVICE_TOKEN: "svc", SWITCHYARD_TOKEN: "gen" };

  it("each prefers its own descriptive variable", () => {
    expect(resolveDeliveryToken({ ...legacy, SWITCHYARD_DELIVER_POLLER_TOKEN: "deliver" })).toBe(
      "deliver",
    );
    expect(resolvePollerToken({ ...legacy, SWITCHYARD_GITHUB_POLLER_TOKEN: "poll" })).toBe("poll");
  });

  it("does not read the other consumer's variable", () => {
    expect(resolveDeliveryToken({ SWITCHYARD_GITHUB_POLLER_TOKEN: "poll" })).toBeUndefined();
    expect(resolvePollerToken({ SWITCHYARD_DELIVER_POLLER_TOKEN: "deliver" })).toBeUndefined();
  });

  it("falls back to the legacy shared names, in order", () => {
    expect(resolveDeliveryToken(legacy)).toBe("svc");
    expect(resolvePollerToken(legacy)).toBe("svc");
    expect(resolveDeliveryToken({ SWITCHYARD_TOKEN: "gen" })).toBe("gen");
    expect(resolvePollerToken({ SWITCHYARD_TOKEN: "gen" })).toBe("gen");
  });

  it('falls through blank values rather than authenticating as "" (|| not ??)', () => {
    expect(resolveDeliveryToken({ SWITCHYARD_DELIVER_POLLER_TOKEN: "", ...legacy })).toBe("svc");
    expect(
      resolvePollerToken({ SWITCHYARD_GITHUB_POLLER_TOKEN: "", SWITCHYARD_TOKEN: "gen" }),
    ).toBe("gen");
  });

  it("is undefined when nothing is set", () => {
    expect(resolveDeliveryToken({})).toBeUndefined();
    expect(resolvePollerToken({})).toBeUndefined();
  });

  it("keeps resolveInfraToken working as a deprecated alias for delivery", () => {
    expect(resolveInfraToken({ SWITCHYARD_DELIVER_POLLER_TOKEN: "deliver" })).toBe("deliver");
  });
});

describe("tokenSourceName", () => {
  it("names the preferred variable when it is set", () => {
    expect(
      tokenSourceName({ SWITCHYARD_GITHUB_POLLER_TOKEN: "p" }, "SWITCHYARD_GITHUB_POLLER_TOKEN"),
    ).toBe("SWITCHYARD_GITHUB_POLLER_TOKEN");
  });
  it("names the legacy variable actually in use, so the doctor can nag precisely", () => {
    expect(tokenSourceName({ SWITCHYARD_TOKEN: "g" }, "SWITCHYARD_GITHUB_POLLER_TOKEN")).toBe(
      "SWITCHYARD_TOKEN",
    );
  });
  it("is undefined when nothing is set", () => {
    expect(tokenSourceName({}, "SWITCHYARD_GITHUB_POLLER_TOKEN")).toBeUndefined();
  });
});

describe("filterWorkToProjects", () => {
  const work: DeliveryWork = {
    pending: [
      { authorizationId: 1, ref: "SYD-9", kind: "done_stamp", pin: null },
      { authorizationId: 2, ref: "OTHER-1", kind: "done_stamp", pin: null },
    ],
    unfinished: [
      {
        id: 10,
        issueRef: "SYD-8",
        prNumber: 42,
        headSha: null,
        derivedHeadSha: null,
        authorizationId: 3,
        startedAt: 0,
      },
      {
        id: 11,
        issueRef: "OTHER-2",
        prNumber: 7,
        headSha: null,
        derivedHeadSha: null,
        authorizationId: 4,
        startedAt: 0,
      },
    ],
    deployRetries: [
      { authorizationId: 5, ref: "SYD-7", prNumber: 1, headSha: null, retryNumber: 1 },
      { authorizationId: 6, ref: "OTHER-3", prNumber: 2, headSha: null, retryNumber: 1 },
    ],
  };

  it("drops pending/unfinished/deployRetries rows whose ref is outside the configured projects", () => {
    const filtered = filterWorkToProjects(work, ["SYD"]);
    expect(filtered.pending.map((p) => p.ref)).toEqual(["SYD-9"]);
    expect(filtered.unfinished.map((a) => a.issueRef)).toEqual(["SYD-8"]);
    expect(filtered.deployRetries.map((r) => r.ref)).toEqual(["SYD-7"]);
  });

  it("keeps every row when all refs are configured", () => {
    const filtered = filterWorkToProjects(work, ["SYD", "OTHER"]);
    expect(filtered.pending).toHaveLength(2);
    expect(filtered.unfinished).toHaveLength(2);
    expect(filtered.deployRetries).toHaveLength(2);
  });
});

describe("resumeActionFor", () => {
  it("finishes delivery only for MERGED; OPEN and CLOSED fail quiet", () => {
    expect(resumeActionFor("MERGED")).toBe("finish-delivery");
    expect(resumeActionFor("OPEN")).toBe("fail-quiet");
    expect(resumeActionFor("CLOSED")).toBe("fail-quiet");
  });
});

describe("crashedAttemptComment", () => {
  it("names the PR when one was pinned and says the merge never landed", () => {
    const body = crashedAttemptComment("SYD-9", 42);
    expect(body).toContain("SYD-9");
    expect(body).toContain("PR #42");
    expect(body).toContain("No merge landed");
    expect(body).toContain("Retry delivery");
  });

  it("handles a crash with no PR pinned", () => {
    expect(crashedAttemptComment("SYD-9", null)).toContain("no PR was pinned");
  });
});

describe("argv builders", () => {
  it("agentBranch", () => {
    expect(agentBranch("SYD-9")).toBe("agent/SYD-9");
  });

  it("buildPushArgs", () => {
    expect(buildPushArgs("SYD-9")).toEqual(["push", "origin", "agent/SYD-9"]);
  });

  it("buildPrListArgs carries -R so gh never needs to be run inside the repo", () => {
    expect(buildPrListArgs("SYD-9", "MobilityLabs/switchyard")).toEqual([
      "pr",
      "list",
      "-R",
      "MobilityLabs/switchyard",
      "--head",
      "agent/SYD-9",
      "--state",
      "open",
      "--json",
      "number",
    ]);
  });

  it("buildPrCreateArgs embeds title, body, and -R as discrete argv entries", () => {
    const args = buildPrCreateArgs(
      "SYD-9",
      "Fix the; thing `rm -rf`",
      "http://host:3300/",
      "MobilityLabs/switchyard",
    );
    expect(args.slice(0, 5)).toEqual(["pr", "create", "-R", "MobilityLabs/switchyard", "--base"]);
    expect(args).toContain("agent/SYD-9");
    expect(args).toContain("SYD-9: Fix the; thing `rm -rf`");
    expect(args.join(" ")).toContain("http://host:3300/issue/SYD-9");
  });

  it("buildPrMergeArgs", () => {
    expect(buildPrMergeArgs(41, "MobilityLabs/switchyard")).toEqual([
      "pr",
      "merge",
      "41",
      "-R",
      "MobilityLabs/switchyard",
      "--merge",
      "--delete-branch",
    ]);
  });

  it("buildPrMergeArgs pins the head with --match-head-commit when given S1 (SYD-209)", () => {
    expect(buildPrMergeArgs(41, "MobilityLabs/switchyard", "s1deadbeef")).toEqual([
      "pr",
      "merge",
      "41",
      "-R",
      "MobilityLabs/switchyard",
      "--merge",
      "--delete-branch",
      "--match-head-commit",
      "s1deadbeef",
    ]);
  });

  it("buildPrViewChecksArgs asks for the rollup bound to the current head (SYD-209)", () => {
    expect(buildPrViewChecksArgs(41, "MobilityLabs/switchyard")).toEqual([
      "pr",
      "view",
      "41",
      "-R",
      "MobilityLabs/switchyard",
      "--json",
      "statusCheckRollup,headRefOid",
    ]);
  });

  it("buildPrViewMergeShaArgs", () => {
    expect(buildPrViewMergeShaArgs(41, "MobilityLabs/switchyard")).toEqual([
      "pr",
      "view",
      "41",
      "-R",
      "MobilityLabs/switchyard",
      "--json",
      "mergeCommit",
      "--jq",
      ".mergeCommit.oid",
    ]);
  });

  it("buildPrViewMergeableArgs", () => {
    expect(buildPrViewMergeableArgs(41, "MobilityLabs/switchyard")).toEqual([
      "pr",
      "view",
      "41",
      "-R",
      "MobilityLabs/switchyard",
      "--json",
      "mergeable",
      "--jq",
      ".mergeable",
    ]);
  });

  it("buildPrViewUrlArgs", () => {
    expect(buildPrViewUrlArgs(41, "acme/widgets")).toEqual([
      "pr",
      "view",
      "41",
      "--json",
      "url",
      "--jq",
      ".url",
      "-R",
      "acme/widgets",
    ]);
  });

  it("buildPrViewFreshnessArgs", () => {
    expect(buildPrViewFreshnessArgs(41, "acme/widgets")).toEqual([
      "pr",
      "view",
      "41",
      "-R",
      "acme/widgets",
      "--json",
      "headRefOid,updatedAt",
    ]);
  });

  it("buildPrViewLiveStateArgs asks gh for state, head, and merge commit", () => {
    expect(buildPrViewLiveStateArgs(41, "acme/widgets")).toEqual([
      "pr",
      "view",
      "41",
      "-R",
      "acme/widgets",
      "--json",
      "state,headRefOid,mergeCommit",
    ]);
  });

  it("buildPrTitle / buildPrBody", () => {
    expect(buildPrTitle("SYD-9", "A title")).toBe("SYD-9: A title");
    expect(buildPrBody("SYD-9", "http://host:3300")).toContain("http://host:3300/issue/SYD-9");
  });

  it("buildPrBody omits the exit-code warning on a clean exit or when the code is unknown", () => {
    expect(buildPrBody("SYD-9", "http://host:3300")).not.toContain("non-zero");
    expect(buildPrBody("SYD-9", "http://host:3300", null)).not.toContain("non-zero");
    expect(buildPrBody("SYD-9", "http://host:3300", 0)).not.toContain("non-zero");
  });

  it("buildPrBody flags a non-clean exit (SYD-118)", () => {
    const body = buildPrBody("SYD-9", "http://host:3300", 1);
    expect(body).toContain("non-zero code (1)");
    expect(body).toContain("review carefully");
  });

  it("buildPrCreateArgs threads the exit code into the PR body", () => {
    const args = buildPrCreateArgs(
      "SYD-9",
      "A title",
      "http://host:3300",
      "MobilityLabs/switchyard",
      1,
    );
    const bodyArg = args[args.indexOf("--body") + 1];
    expect(bodyArg).toContain("non-zero code (1)");
  });

  it("buildPrCreateArgs defaults to no exit-code warning when omitted", () => {
    const args = buildPrCreateArgs(
      "SYD-9",
      "A title",
      "http://host:3300",
      "MobilityLabs/switchyard",
    );
    const bodyArg = args[args.indexOf("--body") + 1];
    expect(bodyArg).not.toContain("non-zero");
  });
});

describe("auto-rebase argv builders (SYD-85)", () => {
  it("buildFetchAgentBranchArgs", () => {
    expect(buildFetchAgentBranchArgs("SYD-9")).toEqual(["fetch", "origin", "agent/SYD-9"]);
  });

  it("buildCheckoutRebaseBranchArgs", () => {
    expect(buildCheckoutRebaseBranchArgs("SYD-9")).toEqual([
      "checkout",
      "-B",
      "agent/SYD-9",
      "FETCH_HEAD",
    ]);
  });

  it("buildRebaseOntoMainArgs", () => {
    expect(buildRebaseOntoMainArgs()).toEqual(["rebase", "origin/main"]);
  });

  it("buildRebaseAbortArgs", () => {
    expect(buildRebaseAbortArgs()).toEqual(["rebase", "--abort"]);
  });

  it("buildConflictFilesArgs", () => {
    expect(buildConflictFilesArgs()).toEqual(["diff", "--name-only", "--diff-filter=U"]);
  });

  it("buildForcePushWithLeaseArgs — only ever targets the agent/<ref> branch", () => {
    expect(buildForcePushWithLeaseArgs("SYD-9")).toEqual([
      "push",
      "--force-with-lease",
      "origin",
      "agent/SYD-9",
    ]);
  });
});

describe("shouldRetryMergePoll (SYD-103)", () => {
  it("keeps polling while UNKNOWN and under the timeout", () => {
    expect(shouldRetryMergePoll("UNKNOWN", 0, 60000)).toBe(true);
    expect(shouldRetryMergePoll("UNKNOWN", 59999, 60000)).toBe(true);
  });

  it("stops once the timeout elapses, even if still UNKNOWN", () => {
    expect(shouldRetryMergePoll("UNKNOWN", 60000, 60000)).toBe(false);
    expect(shouldRetryMergePoll("UNKNOWN", 70000, 60000)).toBe(false);
  });

  it("stops immediately on a definitive MERGEABLE answer", () => {
    expect(shouldRetryMergePoll("MERGEABLE", 0, 60000)).toBe(false);
  });

  it("stops immediately on a definitive CONFLICTING answer", () => {
    expect(shouldRetryMergePoll("CONFLICTING", 0, 60000)).toBe(false);
  });

  it("defaults the timeout to MERGE_POLL_TIMEOUT_MS", () => {
    expect(shouldRetryMergePoll("UNKNOWN", MERGE_POLL_TIMEOUT_MS - 1)).toBe(true);
    expect(shouldRetryMergePoll("UNKNOWN", MERGE_POLL_TIMEOUT_MS)).toBe(false);
  });
});

describe("evaluateChecks (SYD-209 wait-for-checks / live check verification)", () => {
  const S1 = "s1".repeat(20);

  it("is head-moved when the live head is not S1 (a push slipped in)", () => {
    // The required checks GitHub reports describe whatever head it currently
    // has; if that isn't the head we rebased to, the chain is broken — disarm.
    const rollup = { headRefOid: "someoneelse", statusCheckRollup: [] };
    expect(evaluateChecks(rollup, S1)).toBe("head-moved");
  });

  it("is passing when every required check on S1 concluded success", () => {
    const rollup = {
      headRefOid: S1,
      statusCheckRollup: [
        { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS" },
      ],
    };
    expect(evaluateChecks(rollup, S1)).toBe("passing");
  });

  it("is failing when any required check on S1 failed", () => {
    const rollup = {
      headRefOid: S1,
      statusCheckRollup: [
        { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
      ],
    };
    expect(evaluateChecks(rollup, S1)).toBe("failing");
  });

  it("is pending while a check on S1 is still running", () => {
    const rollup = {
      headRefOid: S1,
      statusCheckRollup: [
        { __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: null },
      ],
    };
    expect(evaluateChecks(rollup, S1)).toBe("pending");
  });

  it("is pending when the rollup on S1 is still empty (checks not registered yet)", () => {
    expect(evaluateChecks({ headRefOid: S1, statusCheckRollup: [] }, S1)).toBe("pending");
  });

  it("treats NEUTRAL/SKIPPED CheckRun conclusions as non-blocking passes", () => {
    const rollup = {
      headRefOid: S1,
      statusCheckRollup: [
        { __typename: "CheckRun", name: "optional", status: "COMPLETED", conclusion: "SKIPPED" },
        { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
      ],
    };
    expect(evaluateChecks(rollup, S1)).toBe("passing");
  });
});

describe("shouldKeepWaitingForChecks (SYD-209)", () => {
  it("keeps waiting only while pending and under the timeout", () => {
    expect(shouldKeepWaitingForChecks("pending", 0, 1000)).toBe(true);
    expect(shouldKeepWaitingForChecks("pending", 999, 1000)).toBe(true);
    expect(shouldKeepWaitingForChecks("pending", 1000, 1000)).toBe(false);
  });

  it("stops immediately on a definitive passing / failing / head-moved verdict", () => {
    expect(shouldKeepWaitingForChecks("passing", 0, 1000)).toBe(false);
    expect(shouldKeepWaitingForChecks("failing", 0, 1000)).toBe(false);
    expect(shouldKeepWaitingForChecks("head-moved", 0, 1000)).toBe(false);
  });

  it("defaults the timeout to CHECKS_WAIT_TIMEOUT_MS", () => {
    expect(shouldKeepWaitingForChecks("pending", CHECKS_WAIT_TIMEOUT_MS - 1)).toBe(true);
    expect(shouldKeepWaitingForChecks("pending", CHECKS_WAIT_TIMEOUT_MS)).toBe(false);
  });
});

describe("nextChecksWaitAction (SYD-216 head-moved settle)", () => {
  it("gives a first head-moved a settle+re-read instead of stopping immediately", () => {
    expect(nextChecksWaitAction("head-moved", 0, 1000, false)).toBe("settle-head-moved");
  });

  it("stops on head-moved once the one grace read has already happened", () => {
    expect(nextChecksWaitAction("head-moved", 0, 1000, true)).toBe("stop");
  });

  it("still stops on head-moved even if the timeout has otherwise elapsed", () => {
    // head-moved is never subject to the pending/timeout clock — only whether
    // it's had its one settle read.
    expect(nextChecksWaitAction("head-moved", 999999, 1000, true)).toBe("stop");
  });

  it("keeps polling on pending regardless of headMovedSettled", () => {
    expect(nextChecksWaitAction("pending", 0, 1000, false)).toBe("poll");
    expect(nextChecksWaitAction("pending", 0, 1000, true)).toBe("poll");
  });

  it("stops immediately on a definitive passing/failing verdict", () => {
    expect(nextChecksWaitAction("passing", 0, 1000, false)).toBe("stop");
    expect(nextChecksWaitAction("failing", 0, 1000, false)).toBe("stop");
  });

  it("stops on pending once the timeout has elapsed", () => {
    expect(nextChecksWaitAction("pending", 1000, 1000, false)).toBe("stop");
  });
});

describe("HEAD_MOVED_SETTLE_MS (SYD-216)", () => {
  it("is a short settle window, well under the CI checks poll interval", () => {
    expect(HEAD_MOVED_SETTLE_MS).toBeGreaterThan(0);
    expect(HEAD_MOVED_SETTLE_MS).toBeLessThan(CHECKS_WAIT_TIMEOUT_MS);
  });
});

describe("parsePrNumberFromUrl", () => {
  it("extracts the number from a PR url", () => {
    expect(parsePrNumberFromUrl("https://github.com/acme/widgets/pull/123")).toBe(123);
  });

  it("returns null for a non-PR url", () => {
    expect(parsePrNumberFromUrl("https://github.com/acme/widgets")).toBeNull();
  });
});

describe("formatPublishOutcome", () => {
  it("formats each outcome status (SYD-54)", () => {
    expect(formatPublishOutcome("agent/SYD-9", { status: "no-branch" })).toBe(
      "no agent/SYD-9 branch — nothing to publish",
    );
    expect(formatPublishOutcome("agent/SYD-9", { status: "no-commits" })).toBe(
      "agent/SYD-9 has no commits ahead of main — nothing to publish",
    );
    expect(
      formatPublishOutcome("agent/SYD-9", {
        status: "already-open",
        prNumber: 5,
        url: "https://x/pull/5",
      }),
    ).toBe("pushed agent/SYD-9; PR #5 already open");
    expect(
      formatPublishOutcome("agent/SYD-9", {
        status: "opened",
        prNumber: 6,
        url: "https://x/pull/6",
      }),
    ).toBe("opened PR for agent/SYD-9: https://x/pull/6");
  });
});

describe("parseOwnerRepo", () => {
  it("parses an ssh-style remote url", () => {
    expect(parseOwnerRepo("git@github.com:MobilityLabs/switchyard.git")).toBe(
      "MobilityLabs/switchyard",
    );
  });

  it("parses an https remote url with a .git suffix", () => {
    expect(parseOwnerRepo("https://github.com/MobilityLabs/switchyard.git")).toBe(
      "MobilityLabs/switchyard",
    );
  });

  it("parses an https remote url without a .git suffix", () => {
    expect(parseOwnerRepo("https://github.com/MobilityLabs/switchyard")).toBe(
      "MobilityLabs/switchyard",
    );
  });

  it("throws on an unparseable url", () => {
    expect(() => parseOwnerRepo("not-a-url")).toThrow(/cannot parse/);
  });
});

describe("comment bodies", () => {
  it("success with deploy", () => {
    const body = deliveryComment({
      prNumber: 41,
      mergeSha: "abc123",
      deploy: { ran: true, ok: true, tail: "done" },
    });
    expect(body).toContain("PR #41");
    expect(body).toContain("abc123");
    expect(body).toContain("Deploy: succeeded");
  });

  it("deploy failure includes the output tail", () => {
    const body = deliveryComment({
      prNumber: 41,
      mergeSha: "abc123",
      deploy: { ran: true, ok: false, tail: "boom" },
    });
    expect(body).toContain("Deploy: FAILED");
    expect(body).toContain("boom");
  });

  it("deploy skipped", () => {
    expect(deliveryComment({ prNumber: 41, mergeSha: "abc123", deploy: { ran: false } })).toContain(
      "Deploy: skipped",
    );
  });

  it("failure comment names the ref and reason", () => {
    const body = deliveryFailureComment("SYD-9", "merge conflict");
    expect(body).toContain("SYD-9");
    expect(body).toContain("merge conflict");
  });
});

describe("publish-failure comment (SYD-257)", () => {
  it("names the ref, the agent branch, and the git/gh error", () => {
    const body = publishFailureComment("SYD-9", "ssh: connect to host github.com: config error");
    expect(body).toContain("SYD-9");
    expect(body).toContain("agent/SYD-9");
    expect(body).toContain("ssh: connect to host github.com: config error");
  });

  it("says there is no PR yet, unlike a merge-time delivery failure", () => {
    const body = publishFailureComment("SYD-9", "boom");
    expect(body).toContain("no PR yet");
  });
});

describe("closed-unmerged-pin redeliver dead end (SYD-232)", () => {
  it("buildPrListMergedArgs carries -R and filters to the merged state for the issue's branch", () => {
    expect(buildPrListMergedArgs("SYD-9", "MobilityLabs/switchyard")).toEqual([
      "pr",
      "list",
      "-R",
      "MobilityLabs/switchyard",
      "--head",
      "agent/SYD-9",
      "--state",
      "merged",
      "--json",
      "number,mergeCommit",
      "--limit",
      "10",
    ]);
  });

  it("closedPrAlreadyDeliveredComment names both PRs and the merge SHA, distinct from a failure", () => {
    const body = closedPrAlreadyDeliveredComment("SYD-9", 61, 124, "abc1234");
    expect(body).toContain("SYD-9");
    expect(body).toContain("PR #61");
    expect(body).toContain("PR #124");
    expect(body).toContain("abc1234");
    expect(body).not.toContain("Delivery FAILED");
  });

  it("closedPrDeadEndComment gives an actionable next step instead of a generic bounce", () => {
    const body = closedPrDeadEndComment("SYD-9", 61);
    expect(body).toContain("SYD-9");
    expect(body).toContain("PR #61");
    expect(body).toMatch(/re-open|re-run the agent/i);
  });
});

describe("branch-protection health check (SYD-209)", () => {
  it("buildBranchProtectionArgs targets the repo's main protection API", () => {
    expect(buildBranchProtectionArgs("MobilityLabs/switchyard")).toEqual([
      "api",
      "repos/MobilityLabs/switchyard/branches/main/protection",
    ]);
  });

  it("is ok when main requires at least one status check", () => {
    const res = evaluateBranchProtection({
      required_status_checks: { strict: true, contexts: ["test"] },
      enforce_admins: { enabled: true },
    });
    expect(res.ok).toBe(true);
    expect(res.problems).toEqual([]);
  });

  it("reads the newer checks[] shape too", () => {
    const res = evaluateBranchProtection({
      required_status_checks: { strict: true, checks: [{ context: "test" }] },
      enforce_admins: { enabled: true },
    });
    expect(res.ok).toBe(true);
  });

  it("alarms when the branch has no protection at all (null / 404)", () => {
    const res = evaluateBranchProtection(null);
    expect(res.ok).toBe(false);
    expect(res.problems.join(" ")).toMatch(/no branch protection/i);
  });

  it("alarms when required status checks are absent", () => {
    const res = evaluateBranchProtection({ enforce_admins: { enabled: true } });
    expect(res.ok).toBe(false);
    expect(res.problems.join(" ")).toMatch(/required status check/i);
  });

  it("alarms when the required-checks list is empty (protection present but toothless)", () => {
    const res = evaluateBranchProtection({
      required_status_checks: { strict: true, contexts: [] },
      enforce_admins: { enabled: true },
    });
    expect(res.ok).toBe(false);
    expect(res.problems.join(" ")).toMatch(/no required status check/i);
  });

  it("flags admin bypass (enforce_admins disabled) as a problem so a privileged worker cred is caught", () => {
    const res = evaluateBranchProtection({
      required_status_checks: { strict: true, contexts: ["test"] },
      enforce_admins: { enabled: false },
    });
    expect(res.ok).toBe(false);
    expect(res.problems.join(" ")).toMatch(/admin/i);
  });
});

describe("deliverableProjectKeys (SYD-222, narrowed per-repo by SYD-284)", () => {
  const ALL = ["SYD", "NOC", "HEX"];

  it("delivers for everything when the operator hasn't opted in, even with failing repos", () => {
    expect(deliverableProjectKeys(ALL, undefined, ["SYD"])).toEqual(ALL);
    expect(deliverableProjectKeys(ALL, false, ["SYD"])).toEqual(ALL);
  });

  it("delivers for everything when opted in but nothing is failing", () => {
    expect(deliverableProjectKeys(ALL, true, [])).toEqual(ALL);
  });

  // The SYD-284 change: SYD-222's gate exited the process, so ONE unprotected
  // repo stopped delivery for every project on the host. The risk is per-repo,
  // so the refusal is too.
  it("withholds ONLY the failing repo, leaving the others deliverable", () => {
    expect(deliverableProjectKeys(ALL, true, ["NOC"])).toEqual(["SYD", "HEX"]);
  });

  it("can withhold everything when every repo fails, without special-casing", () => {
    expect(deliverableProjectKeys(ALL, true, ALL)).toEqual([]);
  });
});

describe("refsHeldBackByProtection (SYD-284)", () => {
  const work = {
    pending: [{ ref: "NOC-1" }, { ref: "SYD-2" }],
    unfinished: [{ issueRef: "NOC-3" }],
    deployRetries: [{ ref: "NOC-1" }, { ref: "HEX-9" }],
  } as unknown as Parameters<typeof refsHeldBackByProtection>[0];

  it("names every withheld ref across all three work kinds, deduped and sorted", () => {
    expect(refsHeldBackByProtection(work, ["NOC"])).toEqual(["NOC-1", "NOC-3"]);
  });

  it("is empty when nothing is withheld — no noise on the happy path", () => {
    expect(refsHeldBackByProtection(work, [])).toEqual([]);
  });

  it("reports nothing for a withheld project that happens to have no work owed", () => {
    expect(refsHeldBackByProtection(work, ["OTHER"])).toEqual([]);
  });
});

describe("SHA-chain failure comments (SYD-209)", () => {
  it("checksFailedComment says CI failed on the rebased head and main stays green", () => {
    const body = checksFailedComment("SYD-9");
    expect(body).toContain("SYD-9");
    expect(body).toContain("agent/SYD-9");
    expect(body).toContain("checks");
    expect(body).toContain("stays green");
    expect(body).toContain("Retry delivery");
  });

  it("checksTimeoutComment says checks didn't conclude and Retry re-checks", () => {
    const body = checksTimeoutComment("SYD-9");
    expect(body).toContain("SYD-9");
    expect(body).toContain("did not conclude");
    expect(body).toContain("Retry delivery");
  });

  it("shaChainDisarmedComment surfaces the authorized→current head delta", () => {
    const body = shaChainDisarmedComment("SYD-9", "s0aaa", "s1bbb");
    expect(body).toContain("SYD-9");
    expect(body).toContain("DISARMED");
    expect(body).toContain("s0aaa");
    expect(body).toContain("s1bbb");
    expect(body).toContain("re-authorize");
  });
});

describe("merge orchestrator (SYD-209, formerly queue mode SYD-164)", () => {
  describe("shouldRetryQueueRebase", () => {
    it("retries while under the max attempts", () => {
      expect(shouldRetryQueueRebase(1, 3)).toBe(true);
      expect(shouldRetryQueueRebase(2, 3)).toBe(true);
    });

    it("stops once the max attempts is reached", () => {
      expect(shouldRetryQueueRebase(3, 3)).toBe(false);
      expect(shouldRetryQueueRebase(4, 3)).toBe(false);
    });

    it("defaults the max to MAX_QUEUE_MERGE_ATTEMPTS", () => {
      expect(shouldRetryQueueRebase(MAX_QUEUE_MERGE_ATTEMPTS - 1)).toBe(true);
      expect(shouldRetryQueueRebase(MAX_QUEUE_MERGE_ATTEMPTS)).toBe(false);
    });
  });

  describe("queueRebaseConflictComment", () => {
    it("names the ref, branch, conflicted files, and says main was never touched", () => {
      const body = queueRebaseConflictComment("SYD-9", 41, ["src/a.ts", "src/b.ts"]);
      expect(body).toContain("SYD-9");
      expect(body).toContain("agent/SYD-9");
      expect(body).toContain("- src/a.ts");
      expect(body).toContain("- src/b.ts");
      expect(body).toContain("never touched");
    });

    it("never mentions dispatching a conflict-resolution session", () => {
      const body = queueRebaseConflictComment("SYD-9", 41, ["src/a.ts"]);
      expect(body).not.toContain("conflict-resolution worker session");
    });

    it("handles an empty file list", () => {
      expect(queueRebaseConflictComment("SYD-9", 41, [])).toContain("no conflicted files reported");
    });

    it("names the closed PR and says re-dispatch is the path (SYD-165)", () => {
      const body = queueRebaseConflictComment("SYD-9", 41, ["src/a.ts"]);
      expect(body).toContain("PR #41");
      expect(body).toContain("Closing PR #41");
      expect(body).toContain("re-dispatch");
    });
  });

  describe("noBranchBounceComment (SYD-165)", () => {
    it("names the ref, PR, and says re-dispatch is the path", () => {
      const body = noBranchBounceComment("SYD-9", 41);
      expect(body).toContain("SYD-9");
      expect(body).toContain("PR #41");
      expect(body).toContain("agent/SYD-9");
      expect(body).toContain("no longer exists");
      expect(body).toContain("never touched");
      expect(body).toContain("Closing PR #41");
      expect(body).toContain("re-dispatch");
    });
  });

  describe("buildPrCloseArgs (SYD-165)", () => {
    it("closes without deleting the branch by default", () => {
      expect(buildPrCloseArgs(41, "MobilityLabs/switchyard")).toEqual([
        "pr",
        "close",
        "41",
        "-R",
        "MobilityLabs/switchyard",
      ]);
    });

    it("adds --delete-branch when asked", () => {
      expect(buildPrCloseArgs(41, "MobilityLabs/switchyard", { deleteBranch: true })).toEqual([
        "pr",
        "close",
        "41",
        "-R",
        "MobilityLabs/switchyard",
        "--delete-branch",
      ]);
    });
  });

  describe("queueDeliveredNote", () => {
    it("names the branch, the CI wait on the rebased head, and the pinned merge", () => {
      const note = queueDeliveredNote("SYD-9");
      expect(note).toContain("agent/SYD-9");
      expect(note).toContain("main");
      expect(note).toContain("checks");
      expect(note).toContain("match-head-commit");
    });
  });
});

describe("tailOf", () => {
  it("keeps the last N lines", () => {
    const text = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    const tail = tailOf(text, 20);
    expect(tail.startsWith("line10")).toBe(true);
    expect(tail.endsWith("line29")).toBe(true);
  });
  it("caps total characters", () => {
    expect(tailOf("x".repeat(5000), 20, 2000).length).toBe(2000);
  });
  it("strips ANSI escape sequences so issue comments stay readable", () => {
    const colored =
      "\x1b[31mFAIL\x1b[39m \x1b[2mtests/foo.test.ts\x1b[22m > \x1b[1mbar\x1b[0m\n\x1b[32m- Expected\x1b[39m false";
    expect(tailOf(colored)).toBe("FAIL tests/foo.test.ts > bar\n- Expected false");
  });

  it("strips tar xattr noise so a real error surviving 20 lines of it still surfaces (SYD-173)", () => {
    const noise = Array.from(
      { length: 30 },
      (_, i) =>
        `tar: Ignoring unknown extended header keyword 'LIBARCHIVE.xattr.com.apple.provenance' for entry file${i}.txt`,
    );
    const text = [...noise, "Error: health check failed after deploy"].join("\n");
    const tail = tailOf(text, 20);
    expect(tail).toBe("Error: health check failed after deploy");
  });

  it("strips the ssh post-quantum key-exchange warning block", () => {
    const text = [
      "** WARNING: connection is not using a post-quantum key exchange algorithm.",
      "** This session may be vulnerable to a store-now-decrypt-later attack.",
      "** See https://openssh.com/pq.html for more information.",
      "Error: rsync exited with code 23",
    ].join("\n");
    expect(tailOf(text, 20)).toBe("Error: rsync exited with code 23");
  });

  it("strips a mix of noise so it doesn't drown a real error under the line budget", () => {
    const tarNoise = Array.from(
      { length: 15 },
      (_, i) =>
        `tar: Ignoring unknown extended header keyword 'LIBARCHIVE.xattr.com.apple.provenance' for entry file${i}.txt`,
    );
    const sshNoise = [
      "** WARNING: connection is not using a post-quantum key exchange algorithm.",
      "** This session may be vulnerable to a store-now-decrypt-later attack.",
    ];
    const text = [...tarNoise, ...sshNoise, "FATAL: migration crashed on issues.parentId"].join(
      "\n",
    );
    const tail = tailOf(text, 20);
    expect(tail).toBe("FATAL: migration crashed on issues.parentId");
  });

  it("keeps non-noise lines that merely resemble noise in ordinary output", () => {
    const text = "Running deploy...\nAll good.";
    expect(tailOf(text, 20)).toBe(text);
  });
});

// SYD-266: two deliveries died at `git fetch origin main` because the poller's
// PATH resolved a non-Apple ssh that rejects ~/.ssh/config's UseKeychain. The
// host's `which -a ssh` puts Homebrew's OpenSSH ahead of Apple's, so which ssh
// git gets depends on who launched it — an interactive shell and a launchd
// service can disagree. Pin it, same reasoning as core.hooksPath.
describe("gitSshCommand (SYD-266)", () => {
  const present = (p: string) => p === "/usr/bin/ssh";
  const absent = () => false;

  it("pins the system ssh when it exists and nothing is configured", () => {
    expect(gitSshCommand({}, present)).toBe("/usr/bin/ssh");
  });

  it("defers to an operator-set GIT_SSH_COMMAND rather than overriding it", () => {
    expect(gitSshCommand({ GIT_SSH_COMMAND: "ssh -i /custom/key" }, present)).toBeUndefined();
  });

  it("ignores a blank GIT_SSH_COMMAND and still pins", () => {
    expect(gitSshCommand({ GIT_SSH_COMMAND: "   " }, present)).toBe("/usr/bin/ssh");
  });

  it("pins nothing when the system ssh is absent, rather than breaking git", () => {
    expect(gitSshCommand({}, absent)).toBeUndefined();
  });
});
