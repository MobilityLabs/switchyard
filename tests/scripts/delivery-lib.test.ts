import { describe, it, expect } from "vitest";
import {
  agentBranch,
  findDeliverableRefs,
  findRedeliverRefs,
  feedGap,
  buildPushArgs,
  buildPrListArgs,
  buildPrCreateArgs,
  buildPrMergeArgs,
  buildPrViewUrlArgs,
  buildPrViewMergeShaArgs,
  buildMergedPrForBranchArgs,
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
  deliveryComment,
  deliveryFailureComment,
  verificationFailureComment,
  autoRebasedNote,
  autoRebaseConflictComment,
  autoRebaseVerifyFailedComment,
  reconciledComment,
  selectReconcilableRefs,
  shouldDispatchConflictResolution,
  buildConflictResolutionPrompt,
  buildConflictResolutionDockerArgs,
  buildDetachOntoMainArgs,
  buildSyncLocalMainArgs,
  conflictResolutionFailedComment,
  conflictResolvedNote,
  CONFLICT_RESOLUTION_ALLOWED_TOOLS,
  formatPublishOutcome,
  parsePrNumberFromUrl,
  parseCursorText,
  tailOf,
  type DeliveryFeedEvent,
} from "../../scripts/delivery-lib.js";
import type { WorkerConfig, WorkerProject } from "../../scripts/worker-select.js";

const ev = (o: Partial<DeliveryFeedEvent>): DeliveryFeedEvent => ({
  id: 1,
  type: "status_changed",
  issue: "SYD-9",
  payload: { from: "in_review", to: "done" },
  ...o,
});

describe("findDeliverableRefs", () => {
  const keys = ["SYD"];

  it("null cursor initializes to newest id without firing on history", () => {
    const feed = [ev({ id: 7 }), ev({ id: 3 })];
    expect(findDeliverableRefs(feed, keys, null)).toEqual({ refs: [], lastEventId: 7 });
  });

  it("empty feed leaves the cursor untouched", () => {
    expect(findDeliverableRefs([], keys, null)).toEqual({ refs: [], lastEventId: null });
    expect(findDeliverableRefs([], keys, 5)).toEqual({ refs: [], lastEventId: 5 });
  });

  it("fires on status_changed→done newer than the cursor", () => {
    const feed = [ev({ id: 10 })];
    expect(findDeliverableRefs(feed, keys, 5)).toEqual({ refs: ["SYD-9"], lastEventId: 10 });
  });

  it("ignores events at or below the cursor", () => {
    expect(findDeliverableRefs([ev({ id: 5 })], keys, 5).refs).toEqual([]);
  });

  it("ignores non-done transitions and other event types", () => {
    const feed = [
      ev({ id: 11, payload: { from: "todo", to: "in_progress" } }),
      ev({ id: 12, type: "commented", payload: {} }),
    ];
    expect(findDeliverableRefs(feed, keys, 5).refs).toEqual([]);
  });

  it("ignores unconfigured projects and dedupes refs", () => {
    const feed = [ev({ id: 11, issue: "OTHER-1" }), ev({ id: 12 }), ev({ id: 13 })];
    expect(findDeliverableRefs(feed, keys, 5).refs).toEqual(["SYD-9"]);
  });

  it("never moves the cursor backwards", () => {
    expect(findDeliverableRefs([ev({ id: 3 })], keys, 9).lastEventId).toBe(9);
  });
});

describe("findRedeliverRefs", () => {
  const keys = ["SYD"];
  const redeliver = (o: Partial<DeliveryFeedEvent>): DeliveryFeedEvent =>
    ev({ type: "redeliver_requested", payload: {}, ...o });

  it("null cursor initializes to newest id without firing on history", () => {
    const feed = [redeliver({ id: 7 }), redeliver({ id: 3 })];
    expect(findRedeliverRefs(feed, keys, null)).toEqual({ refs: [], lastEventId: 7 });
  });

  it("fires on redeliver_requested newer than the cursor", () => {
    const feed = [redeliver({ id: 10 })];
    expect(findRedeliverRefs(feed, keys, 5)).toEqual({ refs: ["SYD-9"], lastEventId: 10 });
  });

  it("ignores events at or below the cursor", () => {
    expect(findRedeliverRefs([redeliver({ id: 5 })], keys, 5).refs).toEqual([]);
  });

  it("ignores a done-stamp (that's findDeliverableRefs's job, not this one's)", () => {
    const feed = [
      ev({ id: 11, type: "status_changed", payload: { from: "in_review", to: "done" } }),
    ];
    expect(findRedeliverRefs(feed, keys, 5).refs).toEqual([]);
  });

  it("ignores unconfigured projects and dedupes refs", () => {
    const feed = [
      redeliver({ id: 11, issue: "OTHER-1" }),
      redeliver({ id: 12 }),
      redeliver({ id: 13 }),
    ];
    expect(findRedeliverRefs(feed, keys, 5).refs).toEqual(["SYD-9"]);
  });
});

describe("feedGap", () => {
  it("null cursor ⇒ null", () => {
    expect(feedGap([ev({ id: 9 })], null)).toBeNull();
  });

  it("empty feed ⇒ null", () => {
    expect(feedGap([], 5)).toBeNull();
  });

  it("contiguous window (oldest === cursor + 1) ⇒ null", () => {
    expect(feedGap([ev({ id: 6 }), ev({ id: 10 })], 5)).toBeNull();
  });

  it("overlapping window (oldest <= cursor) ⇒ null", () => {
    expect(feedGap([ev({ id: 3 }), ev({ id: 10 })], 5)).toBeNull();
  });

  it("gap between cursor and window's oldest id", () => {
    expect(feedGap([ev({ id: 9 }), ev({ id: 15 })], 5)).toEqual({ from: 6, to: 8 });
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

describe("auto-rebase comment bodies (SYD-85)", () => {
  it("autoRebasedNote names the branch and main", () => {
    const note = autoRebasedNote("SYD-9");
    expect(note).toContain("agent/SYD-9");
    expect(note).toContain("main");
  });

  it("autoRebaseConflictComment lists conflicted files and the original failure", () => {
    const body = autoRebaseConflictComment("SYD-9", "gh: not mergeable", ["src/a.ts", "src/b.ts"]);
    expect(body).toContain("SYD-9");
    expect(body).toContain("not mergeable");
    expect(body).toContain("agent/SYD-9");
    expect(body).toContain("- src/a.ts");
    expect(body).toContain("- src/b.ts");
    expect(body).toContain("resolve the conflicts");
  });

  it("autoRebaseConflictComment handles an empty file list", () => {
    const body = autoRebaseConflictComment("SYD-9", "gh: not mergeable", []);
    expect(body).toContain("no conflicted files reported");
  });

  it("autoRebaseVerifyFailedComment includes the output tail and says NOT pushed/merged", () => {
    const body = autoRebaseVerifyFailedComment("SYD-9", "TypeError: boom");
    expect(body).toContain("SYD-9");
    expect(body).toContain("agent/SYD-9");
    expect(body).toContain("TypeError: boom");
    expect(body).toContain("NOT pushed, NOT merged");
  });
});

describe("buildMergedPrForBranchArgs (SYD-94)", () => {
  it("looks up merged PRs for the branch, not open ones", () => {
    expect(buildMergedPrForBranchArgs("SYD-9", "MobilityLabs/switchyard")).toEqual([
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
      "1",
    ]);
  });
});

describe("reconciledComment (SYD-94)", () => {
  it("names the PR and merge sha, and notes no deploy ran", () => {
    const body = reconciledComment(41, "abc123");
    expect(body).toContain("PR #41");
    expect(body).toContain("abc123");
    expect(body).toContain("merged manually");
    expect(body).toContain("No deploy was run");
  });
});

describe("selectReconcilableRefs (SYD-94)", () => {
  const keys = ["SYD"];

  it("selects refs flagged delivery_failed on a configured project", () => {
    const rows = [
      { ref: "SYD-9", attention: { reason: "delivery_failed" } },
      { ref: "SYD-10", attention: null },
    ];
    expect(selectReconcilableRefs(rows, keys)).toEqual(["SYD-9"]);
  });

  it("ignores unconfigured projects even if flagged", () => {
    const rows = [{ ref: "OTHER-1", attention: { reason: "delivery_failed" } }];
    expect(selectReconcilableRefs(rows, keys)).toEqual([]);
  });

  it("ignores other attention reasons", () => {
    const rows = [{ ref: "SYD-9", attention: { reason: "something_else" } }];
    expect(selectReconcilableRefs(rows, keys)).toEqual([]);
  });

  it("empty input yields no candidates", () => {
    expect(selectReconcilableRefs([], keys)).toEqual([]);
  });
});

describe("conflict-resolution dispatch (SYD-100)", () => {
  const baseConfig: WorkerConfig = {
    url: "http://localhost:3300",
    label: "auto",
    intervalSeconds: 300,
    maxConcurrent: 1,
    projects: { SYD: { repo: "/repo/syd" } },
  };
  const project: WorkerProject = { repo: "/repo/syd" };
  const oauthEnv = { CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret" };

  describe("shouldDispatchConflictResolution", () => {
    it("is false when not containerized, regardless of the conflictResolution flag", () => {
      expect(shouldDispatchConflictResolution(baseConfig)).toBe(false);
      expect(
        shouldDispatchConflictResolution({ ...baseConfig, delivery: { conflictResolution: true } }),
      ).toBe(false);
    });

    it("defaults to true when containerized", () => {
      expect(shouldDispatchConflictResolution({ ...baseConfig, containerized: true })).toBe(true);
    });

    it("respects an explicit opt-out", () => {
      expect(
        shouldDispatchConflictResolution({
          ...baseConfig,
          containerized: true,
          delivery: { conflictResolution: false },
        }),
      ).toBe(false);
    });
  });

  describe("buildConflictResolutionPrompt", () => {
    it("names the branch, main, and the listed conflict files", () => {
      const prompt = buildConflictResolutionPrompt("SYD-9", ["src/a.ts", "src/b.ts"]);
      expect(prompt).toContain("agent/SYD-9");
      expect(prompt).toContain("main");
      expect(prompt).toContain("- src/a.ts");
      expect(prompt).toContain("- src/b.ts");
    });

    it("instructs never git add -A, run typecheck+tests, and push with lease", () => {
      const prompt = buildConflictResolutionPrompt("SYD-9", ["src/a.ts"]);
      expect(prompt).toContain("never");
      expect(prompt).toContain("git add -A");
      expect(prompt).toContain("npm run typecheck");
      expect(prompt).toContain("npx vitest run");
      expect(prompt).toContain("--force-with-lease");
    });

    it("scopes the session to conflict resolution only — never merge or change status", () => {
      const prompt = buildConflictResolutionPrompt("SYD-9", ["src/a.ts"]);
      expect(prompt).toContain("never merge");
      expect(prompt).toMatch(/never change the issue's status/);
    });

    it("handles an empty file list", () => {
      const prompt = buildConflictResolutionPrompt("SYD-9", []);
      expect(prompt).toContain("no conflicted files reported");
    });
  });

  describe("buildConflictResolutionDockerArgs", () => {
    it("mounts the scratch clone (not the human's live checkout)", () => {
      const args = buildConflictResolutionDockerArgs(
        "SYD-9",
        ["src/a.ts"],
        "/tmp/clones/SYD",
        project,
        baseConfig,
        oauthEnv,
      );
      const vIndex = args.indexOf("-v");
      expect(args[vIndex + 1]).toBe("/tmp/clones/SYD:/origin");
    });

    it("sets MODE=resolve-conflict and AGENT_BRANCH", () => {
      const args = buildConflictResolutionDockerArgs(
        "SYD-9",
        ["src/a.ts"],
        "/tmp/clones/SYD",
        project,
        baseConfig,
        oauthEnv,
      );
      expect(args).toContain("MODE=resolve-conflict");
      expect(args).toContain("AGENT_BRANCH=agent/SYD-9");
    });

    it("scopes ALLOWED_TOOLS to the conflict-resolution allowlist, not the full work allowlist", () => {
      const args = buildConflictResolutionDockerArgs(
        "SYD-9",
        ["src/a.ts"],
        "/tmp/clones/SYD",
        project,
        baseConfig,
        oauthEnv,
      );
      const allowedToolsArg = args.find((a) => a.startsWith("ALLOWED_TOOLS="));
      expect(allowedToolsArg).toBe(`ALLOWED_TOOLS=${CONFLICT_RESOLUTION_ALLOWED_TOOLS.join(",")}`);
      expect(CONFLICT_RESOLUTION_ALLOWED_TOOLS).not.toContain("mcp__switchyard__claim_issue");
      expect(CONFLICT_RESOLUTION_ALLOWED_TOOLS).not.toContain("mcp__switchyard__update_issue");
    });

    it("passes secret vars using the bare -e form, never embedding their values", () => {
      const args = buildConflictResolutionDockerArgs(
        "SYD-9",
        ["src/a.ts"],
        "/tmp/clones/SYD",
        project,
        baseConfig,
        oauthEnv,
      );
      for (const secretVar of [
        "SWITCHYARD_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "ANTHROPIC_API_KEY",
      ]) {
        expect(args).toContain(secretVar);
        expect(args.some((a) => a.startsWith(`${secretVar}=`))).toBe(false);
      }
      expect(args.join(" ")).not.toContain("oauth-secret");
    });

    it("throws without an auth env var, the same as buildDockerArgs", () => {
      expect(() =>
        buildConflictResolutionDockerArgs(
          "SYD-9",
          ["src/a.ts"],
          "/tmp/clones/SYD",
          project,
          baseConfig,
          {},
        ),
      ).toThrow(/CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY/);
    });

    it("respects a custom image", () => {
      const args = buildConflictResolutionDockerArgs(
        "SYD-9",
        ["src/a.ts"],
        "/tmp/clones/SYD",
        project,
        { ...baseConfig, image: "custom/worker-image" },
        oauthEnv,
      );
      expect(args[args.length - 1]).toBe("custom/worker-image");
    });
  });

  it("buildDetachOntoMainArgs detaches HEAD onto origin/main", () => {
    expect(buildDetachOntoMainArgs()).toEqual(["checkout", "--detach", "origin/main"]);
  });

  it("buildSyncLocalMainArgs force-updates local main to origin/main without requiring a checkout", () => {
    expect(buildSyncLocalMainArgs()).toEqual(["branch", "-f", "main", "origin/main"]);
  });

  it("conflictResolutionFailedComment lists conflicted files, the original failure, and the session's output tail", () => {
    const body = conflictResolutionFailedComment(
      "SYD-9",
      "gh: not mergeable",
      ["src/a.ts"],
      "TypeError: boom",
    );
    expect(body).toContain("SYD-9");
    expect(body).toContain("not mergeable");
    expect(body).toContain("agent/SYD-9");
    expect(body).toContain("- src/a.ts");
    expect(body).toContain("TypeError: boom");
    expect(body).toContain("conflict-resolution worker session");
  });

  it("conflictResolutionFailedComment handles an empty file list", () => {
    const body = conflictResolutionFailedComment("SYD-9", "gh: not mergeable", [], "boom");
    expect(body).toContain("no conflicted files reported");
  });

  it("conflictResolvedNote names the branch and main and says it resolved real conflicts", () => {
    const note = conflictResolvedNote("SYD-9");
    expect(note).toContain("agent/SYD-9");
    expect(note).toContain("main");
    expect(note).toContain("conflicts");
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

  it("verification failure comment names the merged PR/SHA, says deploy was skipped, and includes the tail (SYD-78)", () => {
    const body = verificationFailureComment(41, "abc123", "Shell.test.tsx(15,19): error TS2352");
    expect(body).toContain("PR #41");
    expect(body).toContain("abc123");
    expect(body).toContain("deploy skipped");
    expect(body).toContain("main is red");
    expect(body).toContain("Shell.test.tsx(15,19): error TS2352");
  });
});

describe("parseCursorText", () => {
  it("parses a plain integer", () => {
    expect(parseCursorText("42\n")).toBe(42);
  });
  it("rejects junk", () => {
    expect(parseCursorText("")).toBeNull();
    expect(parseCursorText("abc")).toBeNull();
    expect(parseCursorText("-3")).toBeNull();
    expect(parseCursorText("1.5")).toBeNull();
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
});
