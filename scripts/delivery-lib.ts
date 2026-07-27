// Pure logic for the delivery gate (SYD-49, SYD-208): shaping the
// GET /api/delivery-work queue the worker triggers off, building the git/gh
// argv for publishing and merging agent/<ref> PRs, and formatting the
// comments deliver.ts posts back. I/O-free so it's trivially unit-testable;
// the exec side lives in delivery-exec.ts.

import { projectKeyOf } from "./worker-select.js";

export const MAIN_BRANCH = "main";

/**
 * The ssh binary git subprocesses should use, or undefined to leave git's own
 * resolution alone (SYD-266).
 *
 * Two deliveries died at the first `git fetch origin main` — before any rebase,
 * check or merge — with `~/.ssh/config: Bad configuration option: usekeychain`.
 * `UseKeychain` is Apple-OpenSSH-only, so the subprocess had resolved some other
 * ssh off PATH. That is ambient state: on this host `which -a ssh` lists
 * Homebrew's OpenSSH before /usr/bin/ssh, so which one git gets depends on who
 * launched it, and an interactive shell and a launchd service can disagree.
 * Pinning it is the same move as `-c core.hooksPath=/dev/null`: don't inherit
 * an environment the delivery path didn't choose.
 *
 * An operator-set GIT_SSH_COMMAND always wins — someone who configured a jump
 * host or an explicit identity means it. Blank is treated as unset. If the
 * system ssh isn't at the expected path we pin nothing rather than hand git a
 * command that doesn't exist.
 */
export const SYSTEM_SSH = "/usr/bin/ssh";

export function gitSshCommand(
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): string | undefined {
  if (env.GIT_SSH_COMMAND?.trim()) return undefined;
  return exists(SYSTEM_SSH) ? SYSTEM_SSH : undefined;
}

export function agentBranch(ref: string): string {
  return `agent/${ref}`;
}

/**
 * Trusted-infra bearer tokens, one resolver per consumer.
 *
 * These used to share a single `resolveInfraToken` reading
 * `SWITCHYARD_SERVICE_TOKEN || SWITCHYARD_TOKEN`. That was fine while one
 * `service` actor covered both, but delivery and the GitHub poller are now
 * separate least-privilege actors (`deliver-poller`, `github-poller-svc`), so
 * one shared variable can no longer name them both.
 *
 * Precedence per resolver: the **descriptive, per-consumer variable** first,
 * then the legacy shared names for back-compat. The legacy tail matters
 * because these run on the worker host, whose `.env` is deployed separately
 * from the tracker (`npm run deploy` does not touch it) — so a host still
 * carrying the old names keeps working through the rollout rather than dying
 * mid-flight.
 *
 * `||` (not `??`) throughout, so an empty/blank variable falls through instead
 * of authenticating as "".
 *
 * A note on the last fallback, because it is a trap: `SWITCHYARD_TOKEN` is the
 * *dispatch worker's* AGENT token on a normal install, and both of these
 * endpoints refuse agents. So when the descriptive variable is missing, this
 * resolves to a token that authenticates fine and is then rejected by the
 * server — an authorization failure wearing the costume of a config error.
 * That is exactly what happened when SWITCHYARD_SERVICE_TOKEN was renamed out
 * from under these resolvers. The fallback is kept anyway, because a
 * single-token install is legitimate and losing it would break more than it
 * fixes; `init-worker --self-test` names which variable was actually used
 * (tokenSourceName) so the misconfiguration is visible before it bites.
 */
export function resolveDeliveryToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (
    env.SWITCHYARD_DELIVER_POLLER_TOKEN || env.SWITCHYARD_SERVICE_TOKEN || env.SWITCHYARD_TOKEN
  );
}

export function resolvePollerToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.SWITCHYARD_GITHUB_POLLER_TOKEN || env.SWITCHYARD_SERVICE_TOKEN || env.SWITCHYARD_TOKEN;
}

/**
 * @deprecated Use resolveDeliveryToken / resolvePollerToken. Retained so any
 * out-of-tree caller keeps resolving something rather than `undefined`.
 */
export function resolveInfraToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return resolveDeliveryToken(env);
}

/** Which variable a resolver actually used — for doctor output and errors. */
export function tokenSourceName(env: NodeJS.ProcessEnv, preferred: string): string | undefined {
  for (const key of [preferred, "SWITCHYARD_SERVICE_TOKEN", "SWITCHYARD_TOKEN"]) {
    if (env[key]) return key;
  }
  return undefined;
}

// Delivery-work queue shapes (SYD-208): the JSON GET /api/delivery-work
// returns. `pending` are human authorizations (a done-stamp or a
// redeliver_requested) with no attempt row yet; `unfinished` are attempt rows
// started but never finished — crash evidence, resumed against live GitHub;
// `deployRetries` are merged_deploy_failed attempts whose backoff has elapsed.
export type WorkPin = { repo: string; prNumber: number; headSha: string | null };

export type WorkAuthorization = {
  authorizationId: number;
  ref: string;
  kind: "done_stamp" | "redeliver";
  pin: WorkPin | null;
  // SYD-231: rebased heads this worker recorded on prior attempts for the
  // pinned PR. Seeded into the SHA-chain anchor alongside S0 so a branch left
  // at one of the worker's own earlier rebases is re-rebased, not disarmed.
  // Optional so an older server (deploy skew) that omits it still parses.
  priorHeads?: string[];
};

export type WorkAttempt = {
  id: number;
  issueRef: string;
  prNumber: number | null;
  headSha: string | null;
  // SYD-209: the post-rebase head S1 persisted mid-attempt, so crash
  // resumption can re-anchor on the worker's own rebase. null if the crash
  // happened before the first force-push.
  derivedHeadSha: string | null;
  authorizationId: number;
  startedAt: number;
};

export type WorkDeployRetry = {
  authorizationId: number;
  ref: string;
  prNumber: number | null;
  headSha: string | null;
  retryNumber: number;
};

export type DeliveryWork = {
  pending: WorkAuthorization[];
  unfinished: WorkAttempt[];
  deployRetries: WorkDeployRetry[];
};

/** Worker-writable attempt outcomes (a subset of the server's DeliveryOutcome —
 * skipped_rollout is backfill-only). The PATCH that finishes an attempt carries
 * exactly one of these. */
export type AttemptOutcome =
  | "merged_deployed"
  | "merged_deploy_failed"
  | "verify_failed"
  | "conflict_bounced"
  | "merge_failed"
  // SYD-209: CI wait timed out with checks still pending, and the SHA chain
  // broke (a third-party push after the human stamp) — both record
  // delivery_failed and go quiet until a human re-authorizes.
  | "checks_timeout"
  | "sha_chain_disarmed";

/**
 * Drops every work row whose ref sits outside the configured projects — a
 * shared tracker may serve projects this worker host doesn't deliver, so the
 * worker only ever acts on its own. Pure so the scoping is testable without a
 * live tracker.
 */
export function filterWorkToProjects(
  work: DeliveryWork,
  projectKeys: Iterable<string>,
): DeliveryWork {
  const keys = new Set(projectKeys);
  const inScope = (ref: string): boolean => keys.has(projectKeyOf(ref));
  return {
    pending: work.pending.filter((p) => inScope(p.ref)),
    unfinished: work.unfinished.filter((a) => inScope(a.issueRef)),
    deployRetries: work.deployRetries.filter((r) => inScope(r.ref)),
  };
}

export type ResumeAction = "finish-delivery" | "fail-quiet";

/**
 * Crash-resumption decision for an unfinished attempt, off the PR's LIVE
 * GitHub state (never pr_state or the tracker): a MERGED PR means the merge
 * landed before the crash, so run the deploy tail and finish it; OPEN or
 * CLOSED means the merge never happened, so fail quiet and let a human
 * re-authorize. Pure so the branch is testable without shelling out to gh.
 */
export function resumeActionFor(liveState: "OPEN" | "MERGED" | "CLOSED"): ResumeAction {
  return liveState === "MERGED" ? "finish-delivery" : "fail-quiet";
}

/**
 * Posted when an attempt is resumed after a crash but its PR never landed
 * (live OPEN/CLOSED, or no PR was pinned): the merge never happened, so a
 * human re-authorizes with a fresh stamp or the Retry button. Distinct from
 * deliveryFailureComment (a merge-time failure inside a live attempt) — this
 * one explains the crash gap.
 */
export function crashedAttemptComment(ref: string, prNumber: number | null): string {
  const pr =
    prNumber === null ? "no PR was pinned to the attempt" : `PR #${prNumber} was never merged`;
  return (
    `Delivery FAILED for ${ref}: the delivery worker crashed mid-attempt and ${pr}. ` +
    `No merge landed — re-stamp the issue done or click Retry delivery on the attention banner to re-authorize.`
  );
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

/** SYD-232: looks for a PR on this same agent/<ref> branch that already
 * MERGED — checked before bouncing a pinned PR that's CLOSED unmerged, since
 * a fresh dispatch can reuse the branch name and open a replacement PR that
 * delivers the same work under a different number. */
export function buildPrListMergedArgs(ref: string, ownerRepo: string): string[] {
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
    "10",
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

// matchHeadSha (SYD-209) pins the merge to an exact head — `gh pr merge
// --match-head-commit S1` refuses the merge if GitHub's current head has moved
// off S1, so a third-party push landing in the green-on-S1 → merge window
// cannot slot its commit into the merge. The orchestrator always passes S1
// (the head whose required checks it just verified live); the arg is optional
// only so the pin can't be forgotten silently by an un-updated caller.
export function buildPrMergeArgs(
  prNumber: number,
  ownerRepo: string,
  matchHeadSha?: string,
): string[] {
  const args = ["pr", "merge", String(prNumber), "-R", ownerRepo, "--merge", "--delete-branch"];
  if (matchHeadSha) args.push("--match-head-commit", matchHeadSha);
  return args;
}

/**
 * SYD-165: closes a dead agent PR after a conflict/no-branch bounce —
 * `agent/<ref>` is dead by definition in both cases (a real conflict, or the
 * branch no longer existing at all), so regeneration via re-dispatch is the
 * only path forward, not a hand-fix-and-retry on the same branch/PR. Only the
 * conflict case has a live branch worth deleting; the no-branch case has
 * nothing to delete.
 */
export function buildPrCloseArgs(
  prNumber: number,
  ownerRepo: string,
  opts: { deleteBranch?: boolean } = {},
): string[] {
  const args = ["pr", "close", String(prNumber), "-R", ownerRepo];
  if (opts.deleteBranch) args.push("--delete-branch");
  return args;
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

// Wait-for-checks gate (SYD-209): CI is now the sole check authority, so the
// worker no longer re-runs typecheck/build/test in a clean clone. Instead it
// force-pushes the rebased head S1 and waits for GitHub's own required checks
// on S1 to conclude, then reads their conclusion LIVE (never pr_state or
// recorded gh_checks_* events — those are at-least-once webhook replicas; per
// the rev-3 rule, irreversible decisions read live) before merging.

export type ChecksState = "passing" | "failing" | "pending" | "head-moved";

/** How long the worker waits for CI to go green on S1 before recording
 * checks_timeout/delivery_failed and going quiet (a GitHub Actions outage must
 * not stall the sequential per-ref loop forever). */
export const CHECKS_WAIT_TIMEOUT_MS = 15 * 60 * 1000;
export const CHECKS_POLL_INTERVAL_MS = 15000;

/** One rollup entry as GitHub returns it under `--json statusCheckRollup`:
 * either a CheckRun (Actions/apps — status+conclusion) or a StatusContext
 * (legacy commit statuses — state). Fields are optional/defensive because the
 * worker must never crash on an unexpected shape (it would strand a delivery). */
type CheckRollupEntry = {
  __typename?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
  name?: string;
  context?: string;
};

export type ChecksRollup = { headRefOid?: string; statusCheckRollup?: CheckRollupEntry[] };

/** COMPLETED CheckRun conclusions that do NOT block a merge. */
const NON_BLOCKING_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

function checkVerdict(entry: CheckRollupEntry): "pass" | "fail" | "pending" {
  // StatusContext carries `state`; CheckRun carries `status`/`conclusion`.
  if (entry.state !== undefined && entry.status === undefined) {
    if (entry.state === "SUCCESS") return "pass";
    if (entry.state === "PENDING" || entry.state === "EXPECTED") return "pending";
    return "fail";
  }
  if (entry.status !== "COMPLETED") return "pending";
  return NON_BLOCKING_CONCLUSIONS.has(entry.conclusion ?? "") ? "pass" : "fail";
}

/**
 * Classifies the required-check rollup for the head we intend to merge (S1).
 * This is the chain's step-3 comparison in one place: *the head GitHub reports
 * checks for == the head we rebased to == S1*. If GitHub's live head isn't S1,
 * a push slipped in after our force-push and the rollup describes someone
 * else's commit → `head-moved` (disarm). Otherwise: any failed check →
 * `failing`; any still-running → `pending`; all concluded green (and at least
 * one exists) → `passing`; an empty rollup → `pending` (checks not registered
 * yet — the timeout, not a premature pass, resolves a stuck one). Pure so the
 * whole verdict is testable without shelling out to `gh`.
 */
export function evaluateChecks(rollup: ChecksRollup, expectedS1: string): ChecksState {
  if (rollup.headRefOid !== expectedS1) return "head-moved";
  const entries = rollup.statusCheckRollup ?? [];
  const verdicts = entries.map(checkVerdict);
  if (verdicts.includes("fail")) return "failing";
  if (verdicts.includes("pending")) return "pending";
  return verdicts.length > 0 ? "passing" : "pending";
}

/**
 * Whether the wait-for-checks loop should sleep and poll again: only while the
 * verdict is still `pending` and the timeout hasn't elapsed. A definitive
 * `passing`/`failing`/`head-moved` stops the wait immediately. Pure so the
 * stop condition is testable without a real clock.
 */
export function shouldKeepWaitingForChecks(
  state: ChecksState,
  elapsedMs: number,
  timeoutMs: number = CHECKS_WAIT_TIMEOUT_MS,
): boolean {
  return state === "pending" && elapsedMs < timeoutMs;
}

/** SYD-216: how long the wait-for-checks loop waits out a *first* head-moved
 * verdict before re-reading, to absorb GitHub's read-after-write lag right
 * after the S1 force-push — deliberately much shorter than
 * CHECKS_POLL_INTERVAL_MS, since this settles eventual consistency, not CI. */
export const HEAD_MOVED_SETTLE_MS = 3000;

export type ChecksWaitAction = "stop" | "poll" | "settle-head-moved";

/**
 * Next action for the wait-for-checks loop (SYD-216). GitHub's PR API is
 * read-after-write eventually consistent: the very first read right after
 * `attemptAutoRebase` force-pushes S1 can momentarily still report the
 * pre-push head, which `evaluateChecks` reports as `head-moved` — the same
 * verdict a genuine third-party push produces. Give the *first* head-moved
 * one short settle+re-read (`settle-head-moved`) before treating it as
 * definitive; `headMovedSettled` tracks whether that grace read has already
 * happened; if the re-read still shows head-moved (or any occurrence after
 * the first), it's `stop` and the caller disarms — the fail-safe behavior
 * stays intact, it just no longer fires on a one-poll consistency lag. Pure
 * so the state machine is testable without a real clock or shelling out.
 */
export function nextChecksWaitAction(
  state: ChecksState,
  elapsedMs: number,
  timeoutMs: number,
  headMovedSettled: boolean,
): ChecksWaitAction {
  if (state === "head-moved") return headMovedSettled ? "stop" : "settle-head-moved";
  return shouldKeepWaitingForChecks(state, elapsedMs, timeoutMs) ? "poll" : "stop";
}

export function buildPrViewChecksArgs(prNumber: number, ownerRepo: string): string[] {
  return [
    "pr",
    "view",
    String(prNumber),
    "-R",
    ownerRepo,
    "--json",
    "statusCheckRollup,headRefOid",
  ];
}

// Branch-protection health check (SYD-209): CI is the sole check authority, so
// the merge's safety rests on GitHub actually *requiring* those checks on main
// (a rogue/compromised worker is bounded by branch protection + a
// least-privilege credential, not by the SHA chain). A startup/periodic check
// reads the linked repo's protection and alarms loudly if it's relaxed, rather
// than silently trusting an off-box config.

export function buildBranchProtectionArgs(ownerRepo: string, branch = MAIN_BRANCH): string[] {
  return ["api", `repos/${ownerRepo}/branches/${branch}/protection`];
}

type BranchProtection = {
  required_status_checks?: {
    strict?: boolean;
    contexts?: string[];
    checks?: { context: string }[];
  } | null;
  enforce_admins?: { enabled?: boolean } | boolean | null;
};

/**
 * Pure verdict on a branch's protection: `ok` only when main requires at least
 * one status check AND admins can't bypass it. Returns every problem found (not
 * just the first) so the operator alarm names all of them at once. `null`
 * models the API's 404 for an unprotected branch.
 */
export function evaluateBranchProtection(protection: BranchProtection | null): {
  ok: boolean;
  problems: string[];
} {
  const problems: string[] = [];
  if (!protection) {
    return { ok: false, problems: ["no branch protection on main"] };
  }
  const rsc = protection.required_status_checks;
  if (!rsc) {
    problems.push("main has no required status checks (CI is not enforced)");
  } else {
    const count = (rsc.contexts?.length ?? 0) + (rsc.checks?.length ?? 0);
    if (count === 0) {
      problems.push("main's required-status-checks list is empty (no required status check)");
    }
  }
  // enforce_admins is `{enabled}` from the REST API; tolerate a bare boolean.
  const adminsEnforced =
    typeof protection.enforce_admins === "boolean"
      ? protection.enforce_admins
      : (protection.enforce_admins?.enabled ?? false);
  if (!adminsEnforced) {
    problems.push(
      "enforce_admins is off — an admin credential can bypass required checks / push main",
    );
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Whether the SYD-222 startup gate should refuse to run the delivery worker:
 * only when the operator opted in via `delivery.requireBranchProtection` AND
 * at least one linked repo actually failed (or couldn't verify) its branch-
 * protection check. Pure so the gating decision is testable without shelling
 * out to `gh` — see `warnOnRelaxedBranchProtection` in deliver.ts, which
 * still warns unconditionally regardless of this gate.
 */
export function shouldRefuseUnprotectedMain(
  requireBranchProtection: boolean | undefined,
  failingProjectKeys: string[],
): boolean {
  return requireBranchProtection === true && failingProjectKeys.length > 0;
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
  // SYD-209: the fetched remote head wasn't one the worker authorized (S0 or a
  // prior S1) — a third-party push landed on the branch. The caller disarms.
  | { status: "head-moved"; observed: string }
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

/** Freshness lookup for a just-published/just-merged PR (SYD-205): the
 * worker's headSha/ghUpdatedAt must come from GitHub's own record, never the
 * host clock, so clock skew can't out-rank later genuine updates. */
export function buildPrViewFreshnessArgs(prNumber: number, ownerRepo: string): string[] {
  return ["pr", "view", String(prNumber), "-R", ownerRepo, "--json", "headRefOid,updatedAt"];
}

/** Live-state lookup for crash resumption and pin verification (SYD-208): the
 * PR's current GitHub state, head, and (if merged) merge commit. The delivery
 * worker consults this LIVE — never pr_state or the tracker — to decide
 * whether a merge actually landed before acting. */
export function buildPrViewLiveStateArgs(prNumber: number, ownerRepo: string): string[] {
  return [
    "pr",
    "view",
    String(prNumber),
    "-R",
    ownerRepo,
    "--json",
    "state,headRefOid,mergeCommit",
  ];
}

/** The subset of a structured delivery event the server records (SYD-54),
 * posted to POST /issues/:ref/delivery-events by deliver.ts and the worker.
 * repo/headSha/ghUpdatedAt are optional while the tracker and the worker
 * host deploy separately (SYD-205 deploy-skew rule). */
export type DeliveryEventInput =
  | {
      type: "pr_opened";
      prNumber: number;
      url: string;
      repo?: string;
      headSha?: string;
      ghUpdatedAt?: string;
    }
  | {
      type: "delivered";
      prNumber: number;
      mergeSha: string;
      deploy: DeliveryResult["deploy"];
      repo?: string;
      headSha?: string;
      ghUpdatedAt?: string;
    }
  | { type: "delivery_failed"; message: string; repo?: string };

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

export function deliveryFailureComment(ref: string, message: string): string {
  return (
    `Delivery FAILED for ${ref}: ${message}\n` +
    `The agent PR was not delivered — check scripts/deliver.ts logs, resolve, ` +
    `and click Retry delivery on the attention banner (or merge manually).`
  );
}

/**
 * Posted when the host-side publish step (SYD-49: `git push` + `gh pr
 * create`, run by agent-worker.ts right after a containerized session exits)
 * fails (SYD-257). Distinct from deliveryFailureComment (a merge-time
 * failure once a PR already exists) — here the session's work is committed
 * on `agent/<ref>` in the host repo but never reached GitHub, so there is no
 * PR yet for "Retry delivery" to re-authorize; a human has to fix the
 * publish problem (e.g. host git/gh auth) and push/open the PR by hand, or
 * re-dispatch the issue.
 */
export function publishFailureComment(ref: string, message: string): string {
  return (
    `Publish FAILED for ${ref}: ${message}\n` +
    `The session's work is committed on ${agentBranch(ref)} in the host repo, but \`git push\` / ` +
    `\`gh pr create\` did not reach GitHub — there is no PR yet. Check the worker log, fix the ` +
    `underlying problem, then push ${agentBranch(ref)} and open the PR by hand (or re-dispatch the issue).`
  );
}

/**
 * SYD-232: the pinned PR is closed unmerged, but a later PR on the same
 * agent/<ref> branch already merged — the closed pin is a ghost, not a real
 * failure. Reconciles the redeliver instead of bouncing with the same
 * "closed unmerged" failure on every retry.
 */
export function closedPrAlreadyDeliveredComment(
  ref: string,
  closedPrNumber: number,
  mergedPrNumber: number,
  mergeSha: string,
): string {
  return (
    `Redeliver reconciled for ${ref}: PR #${closedPrNumber} was closed unmerged, but ${agentBranch(ref)} was ` +
    `already delivered via PR #${mergedPrNumber} (merged at \`${mergeSha}\`) — treating this as delivered, no ` +
    `merge needed.`
  );
}

/**
 * SYD-232: the pinned PR is closed unmerged AND no later PR on the same
 * branch merged either — a genuine dead pin. Distinct from
 * deliveryFailureComment so a human gets a concrete next step instead of the
 * same generic "closed unmerged" bounce on every retry.
 */
export function closedPrDeadEndComment(ref: string, prNumber: number): string {
  return (
    `Delivery FAILED for ${ref}: PR #${prNumber} is closed unmerged, and no later PR on ${agentBranch(ref)} has ` +
    `merged the work either — this pin is a dead end.\n` +
    `Re-open PR #${prNumber}, or re-run the agent to produce a fresh PR from ${agentBranch(ref)}, then click Retry ` +
    `delivery on the attention banner.`
  );
}

// SYD-209 merge orchestrator (formerly "queue mode", SYD-164): rebase
// agent/<ref> onto current main, force-push, wait for GitHub's required checks
// to go green on the rebased head (CI is the sole check authority — no
// client-side verify), then merge with the head pinned. A rebase conflict, a
// broken SHA chain, a red or timed-out check bounces the ref (comment +
// delivery_failed, main untouched) rather than landing anything unverified.
// The legacy merge-first flow and its SYD-100 conflict-resolution dispatch are
// gone (SYD-209 retired them): a real conflict always bounces for a human /
// re-dispatch.

/** Bounded retries for the rare race where origin/main moves again between the
 * orchestrator's force-push and the merge attempt that follows it (e.g. a
 * human merges something else by hand in that window) — each retry redoes the
 * full rebase→wait-for-green→merge cycle against the newer main. Bounded so a
 * persistently contested ref bounces instead of looping forever. */
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
 * autoRebaseConflictComment/SYD-100 path). SYD-165: `agent/${ref}` is dead by
 * definition once it's conflicted with main — the worker closes PR #prNumber
 * and deletes the branch automatically, so the only remediation left is
 * re-dispatch (there's no branch left to hand-fix and retry). */
export function queueRebaseConflictComment(
  ref: string,
  prNumber: number,
  conflictFiles: string[],
): string {
  const fileList =
    conflictFiles.length > 0
      ? conflictFiles.map((f) => `- ${f}`).join("\n")
      : "(no conflicted files reported)";
  return (
    `Delivery FAILED for ${ref}: rebasing ${agentBranch(ref)} onto ${MAIN_BRANCH} (queue mode) hit real conflicts in:\n` +
    `${fileList}\n` +
    `${MAIN_BRANCH} was never touched. Closing PR #${prNumber} and deleting ${agentBranch(ref)} automatically — ` +
    `re-dispatch the issue against fresh ${MAIN_BRANCH} to regenerate the work.`
  );
}

/** Queue-mode found PR #prNumber open but its ${agentBranch(ref)} branch gone
 * from GitHub (SYD-165) — nothing to rebase, verify, or merge. This is a dead
 * end the same way a real conflict is: the worker closes the PR automatically
 * (there's no branch left to delete) so the duplicate-work guards (nextTask
 * exclusion, dispatch-worker skip, claim refusal) stop treating the issue as
 * "still being worked" and re-dispatch becomes possible again. */
export function noBranchBounceComment(ref: string, prNumber: number): string {
  return (
    `Delivery FAILED for ${ref}: PR #${prNumber} is open, but ${agentBranch(ref)} no longer exists on GitHub — ` +
    `there is nothing to rebase, verify, or merge. ${MAIN_BRANCH} was never touched. Closing PR #${prNumber} ` +
    `automatically — re-dispatch the issue against fresh ${MAIN_BRANCH} to regenerate the work.`
  );
}

/** SYD-209: CI (the sole check authority) reported a FAILED required check on
 * the rebased head S1 — a real test/typecheck/build failure, or a semantic
 * conflict with other work already on main, caught by GitHub before the merge.
 * main is never touched. */
export function checksFailedComment(ref: string): string {
  return (
    `Delivery FAILED for ${ref}: rebased ${agentBranch(ref)} onto ${MAIN_BRANCH} cleanly, but its required GitHub ` +
    `checks (CI) did not pass on the rebased head — NOT merged; ${MAIN_BRANCH} stays green.\n` +
    `Open the PR's Checks tab for the failing job, fix it on ${agentBranch(ref)}, push, and click Retry delivery on ` +
    `the attention banner.`
  );
}

/** SYD-209: CI never concluded within the wait budget (a GitHub Actions
 * backlog/outage), so the attempt goes quiet instead of stalling the
 * sequential per-ref loop. The branch is rebased and pushed; a Retry re-checks. */
export function checksTimeoutComment(ref: string): string {
  return (
    `Delivery FAILED for ${ref}: rebased ${agentBranch(ref)} onto ${MAIN_BRANCH} and pushed, but its required GitHub ` +
    `checks did not conclude within the wait window (likely a CI backlog/outage) — NOT merged.\n` +
    `Once CI is green on the PR, click Retry delivery on the attention banner.`
  );
}

/** SYD-209: the SHA chain broke — the branch head GitHub holds (`observed`)
 * isn't a head the worker authorized (S0, or the S1 it force-pushed): a
 * third-party push landed on the branch after the human stamp. The attempt
 * disarms and surfaces the old→new delta so a reflexive Retry doesn't re-pin
 * the very push the disarm just refused. */
export function shaChainDisarmedComment(ref: string, expected: string, observed: string): string {
  return (
    `Delivery DISARMED for ${ref}: a commit landed on ${agentBranch(ref)} after this delivery was authorized, so ` +
    `the merge was NOT performed — ${MAIN_BRANCH} is untouched.\n` +
    `Authorized head: \`${expected}\`\nCurrent head: \`${observed}\`\n` +
    `Review the new commit, then re-authorize (re-stamp done or click Retry delivery) to deliver the current head.`
  );
}

/** Prepended to deliveryComment's output for a delivered PR, so "Delivered"
 * names how the head was reached (rebased onto main, CI green on that head,
 * then merged with the head pinned). */
export function queueDeliveredNote(ref: string): string {
  return (
    `Rebased ${agentBranch(ref)} onto ${MAIN_BRANCH}, waited for its required GitHub checks to pass on the rebased ` +
    `head, then merged with that head pinned (--match-head-commit).`
  );
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
