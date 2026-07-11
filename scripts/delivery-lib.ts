// Pure logic for the delivery gate (SYD-49): selecting human done-stamps off
// the event feed, building the git/gh argv for publishing and merging
// agent/<ref> PRs, and formatting the comments deliver.ts posts back. I/O-free
// so it's trivially unit-testable; the exec side lives in delivery-exec.ts.

import {
  projectKeyOf,
  stackChecksEnv,
  type WorkerConfig,
  type WorkerProject,
} from "./worker-select.js";

/** The subset of a GET /api/events row the delivery worker needs. */
export type DeliveryFeedEvent = {
  id: number;
  type: string;
  issue: string; // "<PROJECT>-<number>"
  payload: Record<string, unknown>;
};

export const MAIN_BRANCH = "main";

export function agentBranch(ref: string): string {
  return `agent/${ref}`;
}

/**
 * Shared cursor logic for scanning the global event feed for refs matching
 * `matches`, newer than `lastEventId` on configured projects. A null cursor
 * initializes to the newest event id without firing on history (same
 * semantics as findResumeRefs), so a fresh deliver.ts never replays old
 * events.
 */
function findRefsMatching(
  feed: DeliveryFeedEvent[],
  projectKeys: Iterable<string>,
  lastEventId: number | null,
  matches: (e: DeliveryFeedEvent) => boolean,
): { refs: string[]; lastEventId: number | null } {
  if (feed.length === 0) return { refs: [], lastEventId };
  const keys = new Set(projectKeys);
  const newestId = Math.max(...feed.map((e) => e.id));
  if (lastEventId === null) return { refs: [], lastEventId: newestId };

  const refs = new Set<string>();
  for (const e of feed) {
    if (e.id <= lastEventId) continue;
    if (!matches(e)) continue;
    if (!keys.has(projectKeyOf(e.issue))) continue;
    refs.add(e.issue);
  }
  return { refs: [...refs], lastEventId: Math.max(newestId, lastEventId) };
}

/**
 * Scans for done-stamps (status_changed → done) newer than `lastEventId`.
 * Only human actors can move an issue to done (server-enforced), so every
 * match is a human approval — the delivery gate's trigger.
 */
export function findDeliverableRefs(
  feed: DeliveryFeedEvent[],
  projectKeys: Iterable<string>,
  lastEventId: number | null,
): { refs: string[]; lastEventId: number | null } {
  return findRefsMatching(
    feed,
    projectKeys,
    lastEventId,
    (e) => e.type === "status_changed" && e.payload?.to === "done",
  );
}

/**
 * Scans for `redeliver_requested` events newer than `lastEventId` (SYD-102):
 * the explicit "try this delivery again" trigger a human fires from the
 * attention banner's Retry button, distinct from a fresh done-stamp so it
 * works even though the issue is already `done` (a done→done re-stamp emits
 * no event at all — see redeliverIssue in src/services/triage-actions.ts).
 */
export function findRedeliverRefs(
  feed: DeliveryFeedEvent[],
  projectKeys: Iterable<string>,
  lastEventId: number | null,
): { refs: string[]; lastEventId: number | null } {
  return findRefsMatching(feed, projectKeys, lastEventId, (e) => e.type === "redeliver_requested");
}

/**
 * Detects a gap between the persisted cursor and the oldest event the feed
 * window still contains: events in (lastEventId, oldest) are gone from the
 * window and any done-stamps among them will never fire. Returns the missed
 * id range, or null when the window still overlaps the cursor (or there is
 * nothing to compare).
 */
export function feedGap(
  feed: DeliveryFeedEvent[],
  lastEventId: number | null,
): { from: number; to: number } | null {
  if (lastEventId === null || feed.length === 0) return null;
  const oldest = Math.min(...feed.map((e) => e.id));
  return oldest > lastEventId + 1 ? { from: lastEventId + 1, to: oldest - 1 } : null;
}

/** The subset of a GET /api/issues?attention=delivery_failed row the
 * reconciliation pass needs (SYD-94). */
export type AttentionIssueRow = { ref: string; attention: { reason: string } | null };

/**
 * Selects reconciliation candidates: issues flagged `delivery_failed` on a
 * configured project. The server-side `attention` query filter already
 * restricts to that reason, but this stays defensive (and re-checks the
 * project allowlist the same way findDeliverableRefs does) so a future looser
 * query, or a caller that fetches unfiltered, can't sweep in refs the worker
 * doesn't own.
 */
export function selectReconcilableRefs(
  rows: AttentionIssueRow[],
  projectKeys: Iterable<string>,
): string[] {
  const keys = new Set(projectKeys);
  return rows
    .filter((r) => r.attention?.reason === "delivery_failed" && keys.has(projectKeyOf(r.ref)))
    .map((r) => r.ref);
}

export function buildPrTitle(ref: string, issueTitle: string): string {
  return `${ref}: ${issueTitle}`;
}

/**
 * `exitCode` is the dispatched session's own exit code (SYD-118): a
 * containerized session pushes agent/<ref> whenever it produced any commits,
 * independent of whether the session itself errored or was killed by the
 * watchdog, so a non-clean exit can still open a PR carrying partial work.
 * Surfacing that in the PR body itself — rather than only in the worker log —
 * is what makes a reviewer aware without them having to go look; the merge
 * decision stays a human's regardless, this is not a merge gate.
 */
export function buildPrBody(
  ref: string,
  serverUrl: string,
  exitCode: number | null = null,
): string {
  const lines = [
    `Agent work for Switchyard issue **${ref}**.`,
    "",
    `Issue: ${serverUrl.replace(/\/$/, "")}/issue/${ref}`,
    "",
    "Merged automatically by scripts/deliver.ts when a human moves the issue to done.",
  ];
  if (exitCode !== null && exitCode !== 0) {
    lines.push(
      "",
      `⚠️ **Session exited with a non-zero code (${exitCode}).** This branch may carry ` +
        "partial or incomplete work from an errored or killed session — review carefully.",
    );
  }
  return lines.join("\n");
}

// argv builders are pure so tests can assert exact argument vectors; every
// caller passes them to execFile (never a shell), so issue-title content can
// never be interpreted.

// Every gh invocation carries -R <owner>/<repo> and runs from a neutral,
// non-repo cwd (never project.repo, the human's live checkout) — see
// delivery-exec.ts. -R makes gh operate purely against the GitHub API, so a
// human's in-progress checkout of agent/<ref> is never switched or deleted.

export function buildPushArgs(ref: string): string[] {
  return ["push", "origin", agentBranch(ref)];
}

export function buildPrListArgs(ref: string, ownerRepo: string): string[] {
  return [
    "pr",
    "list",
    "-R",
    ownerRepo,
    "--head",
    agentBranch(ref),
    "--state",
    "open",
    "--json",
    "number",
  ];
}

export function buildPrCreateArgs(
  ref: string,
  issueTitle: string,
  serverUrl: string,
  ownerRepo: string,
  exitCode: number | null = null,
): string[] {
  return [
    "pr",
    "create",
    "-R",
    ownerRepo,
    "--base",
    MAIN_BRANCH,
    "--head",
    agentBranch(ref),
    "--title",
    buildPrTitle(ref, issueTitle),
    "--body",
    buildPrBody(ref, serverUrl, exitCode),
  ];
}

export function buildPrMergeArgs(prNumber: number, ownerRepo: string): string[] {
  return ["pr", "merge", String(prNumber), "-R", ownerRepo, "--merge", "--delete-branch"];
}

export function buildPrViewMergeShaArgs(prNumber: number, ownerRepo: string): string[] {
  return [
    "pr",
    "view",
    String(prNumber),
    "-R",
    ownerRepo,
    "--json",
    "mergeCommit",
    "--jq",
    ".mergeCommit.oid",
  ];
}

// Pre-merge mergeability poll (SYD-103, widened by SYD-152): after
// attemptAutoRebase or a SYD-100 resolver session force-pushes agent/<ref>,
// or after publishAgentBranch's own initial push, GitHub recomputes the PR's
// mergeability asynchronously — `mergeable` reads UNKNOWN for several
// seconds. Calling `gh pr merge` in that window fails with "Pull Request is
// not mergeable" even though the branch is fully resolved. Poll `mergeable`
// until it leaves UNKNOWN (or times out) before every merge attempt —
// deliver.ts's first attempt and its post-force-push retries alike.

export type MergeableState = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

export const MERGE_POLL_INTERVAL_MS = 4000;
export const MERGE_POLL_TIMEOUT_MS = 60000;

export function buildPrViewMergeableArgs(prNumber: number, ownerRepo: string): string[] {
  return [
    "pr",
    "view",
    String(prNumber),
    "-R",
    ownerRepo,
    "--json",
    "mergeable",
    "--jq",
    ".mergeable",
  ];
}

/**
 * Whether the merge-retry poll should sleep and check again: only while
 * GitHub's mergeability recompute is still in flight (state UNKNOWN) and the
 * timeout hasn't elapsed. A definitive MERGEABLE or CONFLICTING answer always
 * stops the poll immediately — there's nothing more GitHub is going to tell
 * us by waiting longer. Pure so the stop condition is testable without
 * shelling out to `gh` or a real clock.
 */
export function shouldRetryMergePoll(
  state: MergeableState,
  elapsedMs: number,
  timeoutMs: number = MERGE_POLL_TIMEOUT_MS,
): boolean {
  return state === "UNKNOWN" && elapsedMs < timeoutMs;
}

/** Finds a *merged* PR for agent/<ref> regardless of whether deliver.ts's own
 * merge ever ran (SYD-94 reconciliation) — unlike buildPrListArgs (open only),
 * this looks at closed+merged history so a manually-merged PR is found even
 * though `mergeAgentPr` never touched it. */
export function buildMergedPrForBranchArgs(ref: string, ownerRepo: string): string[] {
  return [
    "pr",
    "list",
    "-R",
    ownerRepo,
    "--head",
    agentBranch(ref),
    "--state",
    "merged",
    "--json",
    "number,mergeCommit",
    "--limit",
    "1",
  ];
}

/** Extracts "owner/repo" from a git remote URL — https, ssh, or scp-like, with or without a .git suffix. */
export function parseOwnerRepo(remoteUrl: string): string {
  const trimmed = remoteUrl.trim().replace(/\.git$/, "");
  const sshMatch = trimmed.match(/^[\w.-]+@[^:/]+[:/](.+)$/);
  if (sshMatch) return sshMatch[1];
  const httpMatch = trimmed.match(/^https?:\/\/[^/]+\/(.+)$/);
  if (httpMatch) return httpMatch[1];
  throw new Error(`cannot parse owner/repo from git remote url: ${remoteUrl}`);
}

export function buildPrViewUrlArgs(prNumber: number, ownerRepo: string): string[] {
  return ["pr", "view", String(prNumber), "--json", "url", "--jq", ".url", "-R", ownerRepo];
}

// Auto-rebase-on-merge-failure argv builders (SYD-85): when `gh pr merge`
// fails, delivery-exec.ts tries a mechanical `git rebase origin/main` of the
// agent branch in the scratch clone before giving up. Kept pure/argv-only for
// the same reason as the builders above — execFile, never a shell.

export function buildFetchAgentBranchArgs(ref: string): string[] {
  return ["fetch", "origin", agentBranch(ref)];
}

export function buildCheckoutRebaseBranchArgs(ref: string): string[] {
  return ["checkout", "-B", agentBranch(ref), "FETCH_HEAD"];
}

export function buildRebaseOntoMainArgs(): string[] {
  return ["rebase", `origin/${MAIN_BRANCH}`];
}

export function buildRebaseAbortArgs(): string[] {
  return ["rebase", "--abort"];
}

export function buildConflictFilesArgs(): string[] {
  return ["diff", "--name-only", "--diff-filter=U"];
}

export function buildForcePushWithLeaseArgs(ref: string): string[] {
  return ["push", "--force-with-lease", "origin", agentBranch(ref)];
}

/** Outcome of an attemptAutoRebase call (delivery-exec.ts) — pure so the
 * comment text for each branch is testable without shelling out. */
export type RebaseOutcome =
  | { status: "no-branch" }
  | { status: "conflict"; files: string[] }
  | { status: "verify-failed"; tail: string }
  | { status: "rebased"; sha: string };

/** Outcome of a publishAgentBranch call (delivery-exec.ts) — pure so the log-line
 * formatting and the decision to emit a pr_opened event are both testable. */
export type PublishOutcome =
  | { status: "no-branch" }
  | { status: "no-commits" }
  | { status: "already-open"; prNumber: number; url: string }
  | { status: "opened"; prNumber: number | null; url: string };

export function formatPublishOutcome(branch: string, outcome: PublishOutcome): string {
  switch (outcome.status) {
    case "no-branch":
      return `no ${branch} branch — nothing to publish`;
    case "no-commits":
      return `${branch} has no commits ahead of ${MAIN_BRANCH} — nothing to publish`;
    case "already-open":
      return `pushed ${branch}; PR #${outcome.prNumber} already open`;
    case "opened":
      return `opened PR for ${branch}: ${outcome.url}`;
  }
}

/** `gh pr create` prints the created PR's URL on stdout — pull the number out
 * of it so callers don't need a second `gh` round-trip just to get the id. */
export function parsePrNumberFromUrl(url: string): number | null {
  const m = /\/pull\/(\d+)/.exec(url);
  return m ? Number(m[1]) : null;
}

/** The subset of a structured delivery event the server records (SYD-54),
 * posted to POST /issues/:ref/delivery-events by deliver.ts and the worker. */
export type DeliveryEventInput =
  | { type: "pr_opened"; prNumber: number; url: string }
  | { type: "delivered"; prNumber: number; mergeSha: string; deploy: DeliveryResult["deploy"] }
  | { type: "delivery_failed"; message: string };

export type DeliveryResult = {
  prNumber: number;
  mergeSha: string;
  deploy: { ran: false } | { ran: true; ok: boolean; tail: string };
};

export function deliveryComment(r: DeliveryResult): string {
  const lines = [`Delivered: merged PR #${r.prNumber} at \`${r.mergeSha}\`.`];
  if (!r.deploy.ran) {
    lines.push("Deploy: skipped (no deploy script in the merged project).");
  } else if (r.deploy.ok) {
    lines.push("Deploy: succeeded.");
  } else {
    lines.push("Deploy: FAILED — output tail:", "```", r.deploy.tail, "```");
  }
  return lines.join("\n");
}

/** Posted when the post-merge verification gate (SYD-78) fails: the PR merged
 * cleanly but merged main no longer typechecks/passes tests, so deploy was
 * skipped. Distinct from deliveryFailureComment, which covers merge-time
 * failures (the PR never landed) — here the merge already happened. */
export function verificationFailureComment(
  prNumber: number,
  mergeSha: string,
  tail: string,
): string {
  return [
    `Merged PR #${prNumber} at \`${mergeSha}\`, but post-merge verification FAILED — deploy skipped.`,
    "main is red; do not build on it until this is fixed. Output tail:",
    "```",
    tail,
    "```",
  ].join("\n");
}

export function deliveryFailureComment(ref: string, message: string): string {
  return (
    `Delivery FAILED for ${ref}: ${message}\n` +
    `The agent PR was not delivered — check scripts/deliver.ts logs, resolve, ` +
    `and click Retry delivery on the attention banner (or merge manually).`
  );
}

/** Posted when the reconciliation pass (SYD-94) finds that a `delivery_failed`
 * PR was actually merged manually (e.g. a human resolved conflicts outside
 * the gate) — distinct from deliveryComment so it's clear the gate never ran
 * the merge or deploy for this one. */
export function reconciledComment(prNumber: number, mergeSha: string): string {
  return (
    `Reconciled: PR #${prNumber} was merged manually at \`${mergeSha}\` (not by this delivery gate) — ` +
    `clearing the stale delivery_failed attention flag. No deploy was run; if this needs deploying, run it by hand.`
  );
}

/** Prepended to deliveryComment's output when the merge only succeeded after
 * an automatic rebase (SYD-85), so "Delivered" doesn't read as a clean
 * first-try merge. */
export function autoRebasedNote(ref: string): string {
  return (
    `Auto-rebased ${agentBranch(ref)} onto ${MAIN_BRANCH} after the initial merge failed ` +
    `(no conflicts; typecheck + tests passed post-rebase) — then merged.`
  );
}

/** gh pr merge failed and the automatic rebase hit real conflict hunks
 * (SYD-85) — never resolved automatically, always escalated with the
 * conflicted file list so the human/coordinator starts with the diagnosis. */
export function autoRebaseConflictComment(
  ref: string,
  mergeFailureMessage: string,
  conflictFiles: string[],
): string {
  const fileList =
    conflictFiles.length > 0
      ? conflictFiles.map((f) => `- ${f}`).join("\n")
      : "(no conflicted files reported)";
  return (
    `Delivery FAILED for ${ref}: merge failed (${mergeFailureMessage})\n` +
    `Attempted an automatic rebase of ${agentBranch(ref)} onto ${MAIN_BRANCH}, but it hit real conflicts:\n` +
    `${fileList}\n` +
    `The agent PR was not delivered — resolve the conflicts, push, and click Retry delivery on the attention banner (or merge manually).`
  );
}

/** gh pr merge failed, the rebase applied cleanly, but the post-rebase verify
 * gate (typecheck + tests) failed — the merged result was never tested, so
 * the rebase is deliberately NOT pushed or retried (SYD-85). */
export function autoRebaseVerifyFailedComment(ref: string, tail: string): string {
  return (
    `Delivery FAILED for ${ref}: auto-rebased ${agentBranch(ref)} onto ${MAIN_BRANCH} with no conflicts, ` +
    `but the post-rebase verify gate (typecheck + tests) failed — NOT pushed, NOT merged.\n` +
    `Output tail:\n\`\`\`\n${tail}\n\`\`\`\n` +
    `The agent PR was not delivered — fix the failure, push, and click Retry delivery on the attention banner (or merge manually).`
  );
}

// Conflict-resolution dispatch (SYD-100): when attemptAutoRebase hits real
// conflict hunks, deliver.ts can dispatch a one-shot worker session — the
// same container image/sandbox as ordinary code dispatch — to resolve them
// inside the pipeline instead of escalating straight to freelance human
// resolution. The resolver session never merges; deliver.ts re-verifies and
// merges through its normal path once the session pushes a rebased branch.

const DEFAULT_RESOLVE_IMAGE = "switchyard-worker";

/** Read-only-ish allowlist for a conflict-resolution session: enough to
 * rebase/resolve/verify/push and comment its diagnosis, but no
 * claim/status-change powers — the resolver session is scoped to conflict
 * resolution only, never to driving the issue itself. */
export const CONFLICT_RESOLUTION_ALLOWED_TOOLS = [
  "Bash",
  "Read",
  "Edit",
  "Grep",
  "Glob",
  "mcp__switchyard__comment",
  "mcp__switchyard__get_issue",
];

/** Whether deliver.ts should dispatch a conflict-resolution session on a real
 * rebase conflict, rather than escalating straight to a human. Requires
 * `containerized` — resolution needs the same clone-in/branch-out sandbox as
 * ordinary code dispatch — and defaults to on unless a human opts out via
 * `delivery.conflictResolution: false`. */
export function shouldDispatchConflictResolution(config: WorkerConfig): boolean {
  return config.containerized === true && config.delivery?.conflictResolution !== false;
}

/** Prompt for a one-shot conflict-resolution session (SYD-100): scoped to
 * rebasing the already-checked-out agent branch onto origin/main, resolving
 * ONLY the listed conflict hunks, staging exactly those files (never `git add
 * -A`), verifying, and pushing with lease — mirrors the design sketch in
 * SYD-100 almost verbatim so the session's contract is explicit rather than
 * implied. */
export function buildConflictResolutionPrompt(ref: string, conflictFiles: string[]): string {
  const branch = agentBranch(ref);
  const fileList =
    conflictFiles.length > 0
      ? conflictFiles.map((f) => `- ${f}`).join("\n")
      : "(no conflicted files reported)";
  return (
    `Switchyard issue ${ref}'s agent branch (${branch}) failed to merge: rebasing it onto ${MAIN_BRANCH} hits real ` +
    `conflicts in:\n${fileList}\n\n` +
    `You are already on ${branch} in a disposable clone. Run \`git fetch origin ${MAIN_BRANCH}\` then ` +
    `\`git rebase origin/${MAIN_BRANCH}\`. Resolve ONLY the conflict hunks in the files listed above, preserving ` +
    `both sides' intent — do not touch any other file. Stage exactly the conflicted files you resolved (never ` +
    `\`git add -A\` or \`git add .\`), then run \`git rebase --continue\`. Once the rebase completes, run ` +
    `\`npm run typecheck\` and \`npx vitest run\`; if either fails, fix your conflict resolution (not unrelated ` +
    `code) and re-run until both pass. Then push with \`git push --force-with-lease origin ${branch}\`. Post a ` +
    `comment on ${ref} using the switchyard MCP comment tool describing exactly what you changed to resolve the ` +
    `conflict. You are scoped to conflict resolution only: never merge the branch, never change the issue's ` +
    `status, and never touch files outside the listed conflicts. If the rebase turns out not to conflict, or you ` +
    `cannot resolve it safely, leave the branch as-is, comment why, and stop.`
  );
}

/** Outcome of a dispatchConflictResolution call (delivery-exec.ts) — pure so
 * deliver.ts's branch on it (retry the merge vs. escalate) is testable
 * without shelling out to docker. */
export type ConflictResolutionOutcome =
  { status: "resolved"; sha: string } | { status: "failed"; tail: string };

/**
 * Builds the `docker run` argv for a conflict-resolution dispatch — same
 * secret-passing convention as buildDockerArgs (worker-select.ts): bare `-e
 * VAR` for secrets so they flow from the caller's env at `docker run` time
 * rather than sitting in argv. Mounts `cloneDir` (deliver.ts's own scratch
 * clone, not a human's checkout) as /origin: the container pushes its
 * resolved branch there, and the host pushes it on to GitHub afterward with
 * its own credentials — the container never sees GitHub auth. Throws under
 * the same condition as buildDockerArgs, for the same reason.
 */
export function buildConflictResolutionDockerArgs(
  ref: string,
  conflictFiles: string[],
  cloneDir: string,
  project: WorkerProject,
  config: WorkerConfig,
  env: NodeJS.ProcessEnv,
): string[] {
  if (!env.CLAUDE_CODE_OAUTH_TOKEN && !env.ANTHROPIC_API_KEY) {
    throw new Error(
      "conflict-resolution dispatch requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in the worker's environment",
    );
  }
  const prompt = buildConflictResolutionPrompt(ref, conflictFiles);
  const image = config.image ?? DEFAULT_RESOLVE_IMAGE;
  const stackChecks = stackChecksEnv(project.stack);

  return [
    "run",
    "--rm",
    "--name",
    `syd-resolve-${ref}`,
    "-v",
    `${cloneDir}:/origin`,
    "-e",
    `ISSUE_REF=${ref}`,
    "-e",
    "MODE=resolve-conflict",
    "-e",
    `AGENT_BRANCH=${agentBranch(ref)}`,
    "-e",
    `SWITCHYARD_URL=${config.url}`,
    "-e",
    "SWITCHYARD_TOKEN",
    "-e",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "-e",
    "ANTHROPIC_API_KEY",
    "-e",
    `WORKER_PROMPT=${prompt}`,
    "-e",
    `ALLOWED_TOOLS=${CONFLICT_RESOLUTION_ALLOWED_TOOLS.join(",")}`,
    ...(stackChecks ? ["-e", `STACK_CHECKS=${stackChecks}`] : []),
    "-e",
    `BASE_BRANCH=${MAIN_BRANCH}`,
    image,
  ];
}

/** Detaches HEAD onto origin/main, off whatever branch is currently checked
 * out — used before mounting a scratch clone into the resolver container:
 * git refuses to push into a non-bare repo's checked-out branch, and the
 * clone is left checked out on agent/<ref> (the branch the container needs
 * to push) right after attemptAutoRebase aborts its own rebase attempt. */
export function buildDetachOntoMainArgs(): string[] {
  return ["checkout", "--detach", `origin/${MAIN_BRANCH}`];
}

/**
 * Force-updates the scratch clone's own LOCAL main branch to match its
 * origin/main. Required before mounting the clone into the resolver
 * container: the container's own "origin" remote is this clone (see
 * buildConflictResolutionDockerArgs), so `git fetch origin main` inside the
 * container reads this clone's *local* refs/heads/main — which is only ever
 * moved by a `reset --hard` while it happens to be the checked-out branch,
 * i.e. frozen at whatever commit it had the first time this clone was ever
 * created. Without this, every resolution after the clone's first use
 * silently rebases the session onto a stale main. Doesn't require checking
 * the branch out, so it's safe to run regardless of what's currently
 * checked out.
 */
export function buildSyncLocalMainArgs(): string[] {
  return ["branch", "-f", MAIN_BRANCH, `origin/${MAIN_BRANCH}`];
}

/** Escalation comment for SYD-100: the mechanical rebase hit real conflicts
 * AND the dispatched conflict-resolution session failed to produce a
 * mergeable branch (session error, or its own verify gate never passed).
 * Distinct from autoRebaseConflictComment, which fires when no resolution
 * session was even attempted (not containerized, or opted out). */
export function conflictResolutionFailedComment(
  ref: string,
  mergeFailureMessage: string,
  conflictFiles: string[],
  tail: string,
): string {
  const fileList =
    conflictFiles.length > 0
      ? conflictFiles.map((f) => `- ${f}`).join("\n")
      : "(no conflicted files reported)";
  return (
    `Delivery FAILED for ${ref}: merge failed (${mergeFailureMessage})\n` +
    `Attempted an automatic rebase of ${agentBranch(ref)} onto ${MAIN_BRANCH}, which hit real conflicts in:\n${fileList}\n` +
    `Dispatched a conflict-resolution worker session to resolve them, but it did not produce a mergeable branch. ` +
    `Output tail:\n\`\`\`\n${tail}\n\`\`\`\n` +
    `The agent PR was not delivered — check the session's own comment on this issue for its diagnosis, resolve ` +
    `the conflicts, push, and click Retry delivery on the attention banner (or merge manually).`
  );
}

// Queue mode (SYD-164): rebase agent/<ref> onto current main and verify the
// REBASED tree before ever attempting the merge, instead of merging first and
// only rebasing as a post-failure fallback (the legacy flow above). A rebase
// conflict or a failing post-rebase verify bounces the ref — comment +
// delivery_failed, main untouched — rather than landing and being caught by
// the post-merge verify gate after the fact. No conflict-resolution session
// is dispatched here: a real conflict always bounces for re-dispatch.

/** Whether `config.delivery.mode` selects the queue flow. Defaults to the
 * legacy (merge-first) flow when unset. */
export function isQueueMode(config: WorkerConfig): boolean {
  return config.delivery?.mode === "queue";
}

/** Bounded retries for the rare race where origin/main moves again between a
 * queue-mode rebase's force-push and the merge attempt that follows it (e.g.
 * a human merges something else by hand in that window) — each retry redoes
 * the full rebase→verify→force-push cycle against the newer main rather than
 * retrying the merge against a tree that was only verified against the old
 * one. Bounded so a persistently contested ref bounces instead of looping
 * forever. */
export const MAX_QUEUE_MERGE_ATTEMPTS = 3;

/** Pure stop condition for the queue-mode rebase/merge retry loop — mirrors
 * shouldRetryMergePoll's shape so it's testable without shelling out. */
export function shouldRetryQueueRebase(
  attempt: number,
  maxAttempts: number = MAX_QUEUE_MERGE_ATTEMPTS,
): boolean {
  return attempt < maxAttempts;
}

/** Queue-mode rebase hit real conflict hunks — bounced rather than merged, and
 * never handed to a conflict-resolution session (unlike the legacy flow's
 * autoRebaseConflictComment/SYD-100 path). */
export function queueRebaseConflictComment(ref: string, conflictFiles: string[]): string {
  const fileList =
    conflictFiles.length > 0
      ? conflictFiles.map((f) => `- ${f}`).join("\n")
      : "(no conflicted files reported)";
  return (
    `Delivery FAILED for ${ref}: rebasing ${agentBranch(ref)} onto ${MAIN_BRANCH} (queue mode) hit real conflicts in:\n` +
    `${fileList}\n` +
    `Queue mode bounces on conflict rather than repairing in place — ${MAIN_BRANCH} was never touched. Resolve the ` +
    `conflicts on ${agentBranch(ref)}, push, and click Retry delivery on the attention banner (or re-dispatch the ` +
    `issue against fresh ${MAIN_BRANCH}).`
  );
}

/** Queue-mode rebase applied with no conflicts, but typecheck/tests failed on
 * the REBASED tree — a semantic conflict with other work already on main,
 * caught before the merge instead of after it (contrast
 * verificationFailureComment, which fires post-merge). */
export function queueVerifyFailedComment(ref: string, tail: string): string {
  return (
    `Delivery FAILED for ${ref}: rebased ${agentBranch(ref)} onto ${MAIN_BRANCH} (queue mode) with no conflicts, but ` +
    `the post-rebase verify gate (typecheck + tests) failed on the rebased tree — a semantic conflict with other ` +
    `work already on ${MAIN_BRANCH}. NOT merged; ${MAIN_BRANCH} stays green.\n` +
    `Output tail:\n\`\`\`\n${tail}\n\`\`\`\n` +
    `Fix the failure on ${agentBranch(ref)}, push, and click Retry delivery on the attention banner.`
  );
}

/** Prepended to deliveryComment's output for a queue-mode delivery, so it
 * reads distinctly from a legacy merge-first "Delivered" (contrast
 * autoRebasedNote/conflictResolvedNote, which mark a legacy-flow fallback). */
export function queueDeliveredNote(ref: string): string {
  return (
    `Queue mode: rebased ${agentBranch(ref)} onto ${MAIN_BRANCH} and verified the rebased tree (typecheck + tests) ` +
    `before merging — a pre-merge gate, not a post-merge check.`
  );
}

/** Prepended to deliveryComment's output when the merge only succeeded after
 * a dispatched conflict-resolution session (SYD-100) — distinct from
 * autoRebasedNote, which covers a clean (no-conflict) auto-rebase, so a
 * "Delivered" comment doesn't understate that real conflicting intent had to
 * be reconciled first. */
export function conflictResolvedNote(ref: string): string {
  return (
    `Merge failed and rebasing ${agentBranch(ref)} onto ${MAIN_BRANCH} hit real conflicts — dispatched a ` +
    `conflict-resolution worker session, which resolved them, staged only the conflicted files, and passed ` +
    `typecheck + tests before pushing — then merged.`
  );
}

/** Contents of .superpowers/deliver-cursor — the last processed event id. */
export function parseCursorText(text: string): number | null {
  const n = Number(text.trim());
  return Number.isInteger(n) && n >= 0 && text.trim() !== "" ? n : null;
}

/**
 * Known-noise line patterns stripped before tailOf takes its slice (SYD-173):
 * during a SYD-148 deploy failure, macOS `tar` emitted dozens of xattr
 * warnings and ssh added a multi-line post-quantum key-exchange banner,
 * filling the entire tail budget and pushing the real error out of the
 * comment. Kept small and documented — add here only for output observed to
 * actually drown a real failure, not speculative noise.
 */
const NOISE_LINE_PATTERNS: RegExp[] = [
  // macOS tar re-packing extended attributes into the deploy tarball, one
  // line per file per xattr.
  /^tar: Ignoring unknown extended header keyword /,
  // OpenSSH's post-quantum key-exchange advisory: every line of the banner
  // is prefixed with `**`, so this strips the whole block regardless of
  // exact wording; the keyword match is a fallback for differently-prefixed
  // variants.
  /^\*\*/,
  /post-quantum/i,
];

/** Drops lines matching `NOISE_LINE_PATTERNS`, keeping tailOf's budget for
 * signal instead of boilerplate warnings. */
function stripNoiseLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !NOISE_LINE_PATTERNS.some((p) => p.test(line)))
    .join("\n");
}

/** Last `maxLines` lines of subprocess output, capped at `maxChars`. */
export function tailOf(text: string, maxLines = 20, maxChars = 2000): string {
  // Vitest/tsc emit ANSI color codes even piped; left in, they render as
  // `[31m` garbage in issue comments (the UI drops the ESC byte).
  // eslint-disable-next-line no-control-regex -- matching the ESC byte is the point
  const plain = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const stripped = stripNoiseLines(plain);
  const tail = stripped.trimEnd().split("\n").slice(-maxLines).join("\n");
  return tail.length > maxChars ? tail.slice(-maxChars) : tail;
}
