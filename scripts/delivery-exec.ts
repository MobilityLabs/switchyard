// Thin subprocess wrappers for the delivery gate. All decision logic (which
// events fire, exact argv, comment text) lives in delivery-lib.ts and is
// unit-tested there; this file only sequences git/gh/npm calls. Everything
// uses execFile — never a shell — so issue-title content is inert.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentBranch,
  buildPushArgs,
  buildPrListArgs,
  buildPrCreateArgs,
  buildPrMergeArgs,
  buildPrViewMergeShaArgs,
  buildPrViewUrlArgs,
  buildMergedPrForBranchArgs,
  parseOwnerRepo,
  buildFetchAgentBranchArgs,
  buildCheckoutRebaseBranchArgs,
  buildRebaseOntoMainArgs,
  buildRebaseAbortArgs,
  buildConflictFilesArgs,
  buildForcePushWithLeaseArgs,
  buildConflictResolutionDockerArgs,
  buildDetachOntoMainArgs,
  buildSyncLocalMainArgs,
  buildPrViewMergeableArgs,
  shouldRetryMergePoll,
  parsePrNumberFromUrl,
  tailOf,
  MAIN_BRANCH,
  MERGE_POLL_INTERVAL_MS,
  type PublishOutcome,
  type RebaseOutcome,
  type ConflictResolutionOutcome,
  type MergeableState,
} from "./delivery-lib.js";
import type { WorkerConfig, WorkerProject } from "./worker-select.js";

const execFileP = promisify(execFile);

export async function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<string> {
  const { stdout } = await execFileP(cmd, args, { cwd: opts.cwd, env: opts.env, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Runs git with repo hooks disabled (`-c core.hooksPath=/dev/null`). Every
 * git invocation in this file targets a directory a containerized dispatch
 * session mounts read-write as /origin — project.repo for ordinary work
 * dispatch (buildDockerArgs, worker-select.ts) or the shared deliver.ts
 * cloneDir for conflict-resolution dispatch (buildConflictResolutionDockerArgs,
 * delivery-lib.ts). A prompt-injected session has Bash+Write in there and can
 * plant e.g. .git/hooks/pre-push directly on the mount; without this flag a
 * later host-side git command against that same directory (push, checkout,
 * rebase, ...) would execute the planted hook as the host/worker user, which
 * holds GitHub push credentials — container-to-host RCE (SYD-109).
 */
export async function runGit(args: string[], opts: { cwd?: string } = {}): Promise<string> {
  return run("git", ["-c", "core.hooksPath=/dev/null", ...args], opts);
}

// Every gh call below runs with -R <owner>/<repo> from GH_CWD — a directory
// with no .git of its own — instead of `cwd: repo` (the human's live
// checkout). gh then talks to the GitHub API only: it never has a local
// checkout of agent/<ref> to switch off of or delete, so `gh pr merge
// --delete-branch` can't yank a working tree out from under a human who has
// that branch checked out for review.
const GH_CWD = os.tmpdir();

async function originOwnerRepo(repo: string): Promise<string> {
  const url = await runGit(["-C", repo, "remote", "get-url", "origin"]);
  return parseOwnerRepo(url);
}

/**
 * Host-side publish step after a containerized session exits: if the session
 * pushed agent/<ref> into the host repo with commits ahead of main, push the
 * branch to GitHub and open a PR (unless one is already open). Returns a
 * structured outcome — formatPublishOutcome (delivery-lib.ts) renders it for
 * the worker log, and the caller uses the PR number/url to record a
 * structured pr_opened event (SYD-54) so the issue UI can show a delivery
 * strip without parsing prose. gh runs on the host with the user's keyring
 * auth — containers never see GitHub credentials.
 */
export async function publishAgentBranch(
  repo: string,
  ref: string,
  issueTitle: string,
  serverUrl: string,
  exitCode: number | null = null
): Promise<PublishOutcome> {
  const branch = agentBranch(ref);
  try {
    await runGit(["-C", repo, "rev-parse", "--verify", `refs/heads/${branch}`]);
  } catch {
    return { status: "no-branch" };
  }
  const ahead = await runGit(["-C", repo, "rev-list", `${MAIN_BRANCH}..${branch}`, "--count"]);
  if (ahead === "0") return { status: "no-commits" };

  await runGit(["-C", repo, ...buildPushArgs(ref)]);
  const ownerRepo = await originOwnerRepo(repo);
  const prNumber = await findOpenAgentPr(repo, ref);
  if (prNumber !== null) {
    const url = await run("gh", buildPrViewUrlArgs(prNumber, ownerRepo), { cwd: GH_CWD });
    return { status: "already-open", prNumber, url };
  }
  const url = await run("gh", buildPrCreateArgs(ref, issueTitle, serverUrl, ownerRepo, exitCode), { cwd: GH_CWD });
  return { status: "opened", prNumber: parsePrNumberFromUrl(url), url };
}

export async function findOpenAgentPr(repo: string, ref: string): Promise<number | null> {
  const ownerRepo = await originOwnerRepo(repo);
  const open = JSON.parse(await run("gh", buildPrListArgs(ref, ownerRepo), { cwd: GH_CWD })) as { number: number }[];
  return open.length > 0 ? open[0].number : null;
}

/** Reconciliation lookup (SYD-94): unlike findOpenAgentPr, this also finds
 * agent/<ref> PRs that were merged outside the gate (manual merge after a
 * delivery_failed) so the stale attention flag can be cleared. Returns null
 * if no merged PR exists for the branch (still open, or closed unmerged). */
export async function findMergedAgentPr(repo: string, ref: string): Promise<{ prNumber: number; mergeSha: string } | null> {
  const ownerRepo = await originOwnerRepo(repo);
  const merged = JSON.parse(
    await run("gh", buildMergedPrForBranchArgs(ref, ownerRepo), { cwd: GH_CWD })
  ) as { number: number; mergeCommit: { oid: string } | null }[];
  const hit = merged[0];
  if (!hit || !hit.mergeCommit) return null;
  return { prNumber: hit.number, mergeSha: hit.mergeCommit.oid };
}

/** Merges the PR (merge commit, deletes the remote branch) and returns the merge SHA. */
export async function mergeAgentPr(repo: string, prNumber: number): Promise<string> {
  const ownerRepo = await originOwnerRepo(repo);
  await run("gh", buildPrMergeArgs(prNumber, ownerRepo), { cwd: GH_CWD });
  return run("gh", buildPrViewMergeShaArgs(prNumber, ownerRepo), { cwd: GH_CWD });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readMergeableState(prNumber: number, ownerRepo: string): Promise<MergeableState> {
  const out = await run("gh", buildPrViewMergeableArgs(prNumber, ownerRepo), { cwd: GH_CWD });
  return out as MergeableState;
}

/**
 * Polls `gh pr view --json mergeable` until it leaves UNKNOWN or
 * MERGE_POLL_TIMEOUT_MS elapses, so a merge attempt doesn't race GitHub's
 * asynchronous mergeability recompute. Originally added (SYD-103) for the
 * merge retry that follows a rebase/conflict-resolution force-push; also
 * called before deliver.ts's very first merge attempt (SYD-152) since a PR
 * pushed or force-pushed moments earlier — by publishAgentBranch, or by an
 * auto-rebase from a prior delivery attempt on the same ref — can still read
 * UNKNOWN there too. Returns whatever state was last observed — including a
 * still-UNKNOWN timeout — and never throws on CONFLICTING or timeout: the
 * caller attempts/retries the merge through its normal path regardless, so a
 * real conflict or a slow recompute just fails the same way delivery already
 * handles a merge failure.
 */
export async function pollUntilMergeable(repo: string, prNumber: number): Promise<MergeableState> {
  const ownerRepo = await originOwnerRepo(repo);
  const start = Date.now();
  let state = await readMergeableState(prNumber, ownerRepo);
  while (shouldRetryMergePoll(state, Date.now() - start)) {
    await sleep(MERGE_POLL_INTERVAL_MS);
    state = await readMergeableState(prNumber, ownerRepo);
  }
  return state;
}

/**
 * Deploys must never run from a working tree (stale/dirty trees must not be
 * shippable) — keep a dedicated clone hard-reset to origin/main instead.
 */
export async function ensureCleanClone(sourceRepo: string, cloneDir: string): Promise<void> {
  if (!existsSync(path.join(cloneDir, ".git"))) {
    const remote = await runGit(["-C", sourceRepo, "remote", "get-url", "origin"]);
    mkdirSync(path.dirname(cloneDir), { recursive: true });
    await runGit(["clone", remote, cloneDir]);
  }
  await runGit(["-C", cloneDir, "fetch", "origin", MAIN_BRANCH]);
  await runGit(["-C", cloneDir, "reset", "--hard", `origin/${MAIN_BRANCH}`]);
  await runGit(["-C", cloneDir, "clean", "-fd"]);
}

/**
 * Installs dependencies in the clean clone via `npm ci`. `npm ci` deletes
 * node_modules wholesale before installing from the lockfile, unlike `npm
 * install` (which leaves already-installed packages alone) -- needed
 * because ensureCleanClone's `git clean -fd` does NOT remove node_modules
 * (it's gitignored; -fd only clears untracked files git isn't told to
 * ignore), so a persistent clone can carry native modules (e.g.
 * better-sqlite3) compiled for a node version the gate no longer runs
 * (SYD-101).
 */
export async function installDeps(cloneDir: string): Promise<string> {
  return run("npm", ["ci"], { cwd: cloneDir });
}

/** Whether the clone's package.json declares the named npm script. */
function hasScript(cloneDir: string, name: string): boolean {
  const pkgPath = path.join(cloneDir, "package.json");
  if (!existsSync(pkgPath)) return false;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
  return Boolean(pkg.scripts?.[name]);
}

/**
 * Post-merge verification gate (SYD-78): a PR is reviewed and green in
 * isolation, but nothing previously confirmed that main *after* the merge
 * (i.e. this branch plus everything else landed since its clone) still
 * typechecks and passes its tests — semantic conflicts between concurrently
 * merged branches land silently. Runs in the clean clone, never the deploy
 * caller's working tree.
 */
export async function runVerification(cloneDir: string): Promise<{ ok: boolean; tail: string }> {
  // NO_COLOR keeps tsc/vitest output plain at the source so failure tails
  // pasted into issue comments carry no escape codes (tailOf's ANSI strip
  // stays as a backstop — SYD-161).
  const env = { ...process.env, NO_COLOR: "1" };
  try {
    await installDeps(cloneDir);
    const steps = [await run("npm", ["run", "typecheck"], { cwd: cloneDir, env })];
    // SYD-168: tests that serve the SPA (spa-fallback) need dist/ui to exist,
    // and the clean clone never has it — skipping this failed the gate on
    // every tree. Conditional because not every delivered project (NOC) has
    // a build:ui script.
    if (hasScript(cloneDir, "build:ui")) {
      steps.push(await run("npm", ["run", "build:ui"], { cwd: cloneDir, env }));
    }
    steps.push(await run("npx", ["vitest", "run"], { cwd: cloneDir, env }));
    return { ok: true, tail: tailOf(steps.join("\n")) };
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string };
    return { ok: false, tail: tailOf(`${e.stdout ?? ""}\n${e.stderr ?? e.message}`) };
  }
}

/**
 * Mechanical recovery for a `gh pr merge` failure (SYD-85): rebases the agent
 * branch onto origin/main in the scratch clone (reusing ensureCleanClone, the
 * same machinery the deploy step uses). A clean rebase is verified (typecheck
 * + tests — the merged combination was never tested) and force-pushed
 * with-lease so the caller can retry the merge; a conflicted rebase is
 * aborted and reported, never resolved automatically — that needs intent a
 * script doesn't have. Force-push only ever targets `agent/<ref>` branches.
 * Callers are expected to invoke this at most once per merge failure (a
 * failed retry falls through to the normal failure path) so a stuck PR can't
 * loop rebase attempts forever.
 */
export async function attemptAutoRebase(repo: string, cloneDir: string, ref: string): Promise<RebaseOutcome> {
  await ensureCleanClone(repo, cloneDir);
  try {
    await runGit(["-C", cloneDir, ...buildFetchAgentBranchArgs(ref)]);
  } catch {
    return { status: "no-branch" };
  }
  await runGit(["-C", cloneDir, ...buildCheckoutRebaseBranchArgs(ref)]);
  try {
    await runGit(["-C", cloneDir, ...buildRebaseOntoMainArgs()]);
  } catch {
    const filesOut = await runGit(["-C", cloneDir, ...buildConflictFilesArgs()]).catch(() => "");
    const files = filesOut.split("\n").map((f) => f.trim()).filter(Boolean);
    await runGit(["-C", cloneDir, ...buildRebaseAbortArgs()]).catch(() => {});
    return { status: "conflict", files };
  }
  const verify = await runVerification(cloneDir);
  if (!verify.ok) return { status: "verify-failed", tail: verify.tail };
  await runGit(["-C", cloneDir, ...buildForcePushWithLeaseArgs(ref)]);
  const sha = await runGit(["-C", cloneDir, "rev-parse", "HEAD"]);
  return { status: "rebased", sha };
}

/**
 * Dispatches a one-shot conflict-resolution worker session (SYD-100) against
 * `cloneDir` — the same scratch clone attemptAutoRebase just left checked out
 * on agent/<ref> at its pre-rebase commit, having aborted its own mechanical
 * rebase on hitting real conflicts. Syncs the clone's own local main branch
 * to its origin/main (the container's "origin" is this clone, so its local
 * main is otherwise frozen at whatever commit it had the first time the
 * clone was ever created — see buildSyncLocalMainArgs), then detaches HEAD
 * onto it (git refuses to push into a checked-out branch) so the container's
 * own `git push` into the /origin bind mount can update agent/<ref>.
 *
 * A session is free to decline resolving (see buildConflictResolutionPrompt)
 * without the container itself failing, so success is judged by whether
 * agent/<ref> actually moved, not by the container's exit code alone: once
 * the container exits cleanly, this pushes the resolved branch on to GitHub
 * with the host's own credentials (the container never sees them) and
 * returns the merge-ready sha — unless the branch is unchanged, which is
 * reported as a failure so the caller escalates instead of retrying a merge
 * that will just hit the same conflict again. The resolver session never
 * merges; the caller (deliver.ts) re-verifies and retries the merge through
 * its normal path.
 */
export async function dispatchConflictResolution(
  cloneDir: string,
  ref: string,
  conflictFiles: string[],
  project: WorkerProject,
  config: WorkerConfig
): Promise<ConflictResolutionOutcome> {
  const originalSha = await runGit(["-C", cloneDir, "rev-parse", agentBranch(ref)]);

  await runGit(["-C", cloneDir, ...buildSyncLocalMainArgs()]);
  await runGit(["-C", cloneDir, ...buildDetachOntoMainArgs()]);

  const dockerArgs = buildConflictResolutionDockerArgs(ref, conflictFiles, cloneDir, project, config, process.env);
  let dockerOutput: string;
  try {
    dockerOutput = await run("docker", dockerArgs);
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string };
    return { status: "failed", tail: tailOf(`${e.stdout ?? ""}\n${e.stderr ?? e.message}`) };
  }

  const resolvedSha = await runGit(["-C", cloneDir, "rev-parse", agentBranch(ref)]);
  if (resolvedSha === originalSha) {
    return {
      status: "failed",
      tail: tailOf(`${dockerOutput}\nthe session left ${agentBranch(ref)} unchanged — see its own comment on the issue for why`),
    };
  }

  try {
    await runGit(["-C", cloneDir, ...buildForcePushWithLeaseArgs(ref)]);
  } catch (err) {
    return {
      status: "failed",
      tail: tailOf(`${dockerOutput}\ncould not push the resolved branch to GitHub: ${(err as Error).message}`),
    };
  }
  return { status: "resolved", sha: resolvedSha };
}

/** Runs the project's `npm run deploy` from the clean clone, if it has one. */
export async function runDeploy(
  cloneDir: string
): Promise<{ ran: false } | { ran: true; ok: boolean; tail: string }> {
  if (!hasScript(cloneDir, "deploy")) return { ran: false };
  try {
    const out = await run("npm", ["run", "deploy"], { cwd: cloneDir });
    return { ran: true, ok: true, tail: tailOf(out) };
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string };
    return { ran: true, ok: false, tail: tailOf(`${e.stdout ?? ""}\n${e.stderr ?? e.message}`) };
  }
}
