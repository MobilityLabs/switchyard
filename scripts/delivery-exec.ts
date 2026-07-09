// Thin subprocess wrappers for the delivery gate. All decision logic (which
// events fire, exact argv, comment text) lives in delivery-lib.ts and is
// unit-tested there; this file only sequences git/gh/npm calls. Everything
// uses execFile — never a shell — so issue-title content is inert.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  agentBranch,
  buildPushArgs,
  buildPrListArgs,
  buildPrCreateArgs,
  buildPrMergeArgs,
  buildPrViewUrlArgs,
  parsePrNumberFromUrl,
  tailOf,
  MAIN_BRANCH,
  type PublishOutcome,
} from "./delivery-lib.js";

const execFileP = promisify(execFile);

export async function run(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<string> {
  const { stdout } = await execFileP(cmd, args, { cwd: opts.cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
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
  serverUrl: string
): Promise<PublishOutcome> {
  const branch = agentBranch(ref);
  try {
    await run("git", ["-C", repo, "rev-parse", "--verify", `refs/heads/${branch}`]);
  } catch {
    return { status: "no-branch" };
  }
  const ahead = await run("git", ["-C", repo, "rev-list", `${MAIN_BRANCH}..${branch}`, "--count"]);
  if (ahead === "0") return { status: "no-commits" };

  await run("git", ["-C", repo, ...buildPushArgs(ref)]);
  const open = JSON.parse(await run("gh", buildPrListArgs(ref), { cwd: repo })) as { number: number }[];
  if (open.length > 0) {
    const prNumber = open[0].number;
    const url = await run("gh", buildPrViewUrlArgs(prNumber), { cwd: repo });
    return { status: "already-open", prNumber, url };
  }
  const url = await run("gh", buildPrCreateArgs(ref, issueTitle, serverUrl), { cwd: repo });
  return { status: "opened", prNumber: parsePrNumberFromUrl(url), url };
}

export async function findOpenAgentPr(repo: string, ref: string): Promise<number | null> {
  const open = JSON.parse(await run("gh", buildPrListArgs(ref), { cwd: repo })) as { number: number }[];
  return open.length > 0 ? open[0].number : null;
}

/** Merges the PR (merge commit, deletes the remote branch) and returns the merge SHA. */
export async function mergeAgentPr(repo: string, prNumber: number): Promise<string> {
  await run("gh", buildPrMergeArgs(prNumber), { cwd: repo });
  return run(
    "gh",
    ["pr", "view", String(prNumber), "--json", "mergeCommit", "--jq", ".mergeCommit.oid"],
    { cwd: repo }
  );
}

/**
 * Deploys must never run from a working tree (stale/dirty trees must not be
 * shippable) — keep a dedicated clone hard-reset to origin/main instead.
 */
export async function ensureCleanClone(sourceRepo: string, cloneDir: string): Promise<void> {
  if (!existsSync(path.join(cloneDir, ".git"))) {
    const remote = await run("git", ["-C", sourceRepo, "remote", "get-url", "origin"]);
    mkdirSync(path.dirname(cloneDir), { recursive: true });
    await run("git", ["clone", remote, cloneDir]);
  }
  await run("git", ["-C", cloneDir, "fetch", "origin", MAIN_BRANCH]);
  await run("git", ["-C", cloneDir, "reset", "--hard", `origin/${MAIN_BRANCH}`]);
  await run("git", ["-C", cloneDir, "clean", "-fd"]);
}

/**
 * Post-merge verification gate (SYD-78): a PR is reviewed and green in
 * isolation, but nothing previously confirmed that main *after* the merge
 * (i.e. this branch plus everything else landed since its clone) still
 * typechecks and passes its tests — semantic conflicts between concurrently
 * merged branches land silently. Runs in the clean clone, never the deploy
 * caller's working tree. `npm install` first because ensureCleanClone's
 * `git clean -fd` wipes the clone's (gitignored) node_modules every time.
 */
export async function runVerification(cloneDir: string): Promise<{ ok: boolean; tail: string }> {
  try {
    await run("npm", ["install"], { cwd: cloneDir });
    const typecheck = await run("npm", ["run", "typecheck"], { cwd: cloneDir });
    const tests = await run("npx", ["vitest", "run"], { cwd: cloneDir });
    return { ok: true, tail: tailOf(`${typecheck}\n${tests}`) };
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string };
    return { ok: false, tail: tailOf(`${e.stdout ?? ""}\n${e.stderr ?? e.message}`) };
  }
}

/** Runs the project's `npm run deploy` from the clean clone, if it has one. */
export async function runDeploy(
  cloneDir: string
): Promise<{ ran: false } | { ran: true; ok: boolean; tail: string }> {
  const pkgPath = path.join(cloneDir, "package.json");
  if (!existsSync(pkgPath)) return { ran: false };
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
  if (!pkg.scripts?.deploy) return { ran: false };
  try {
    const out = await run("npm", ["run", "deploy"], { cwd: cloneDir });
    return { ran: true, ok: true, tail: tailOf(out) };
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string };
    return { ran: true, ok: false, tail: tailOf(`${e.stdout ?? ""}\n${e.stderr ?? e.message}`) };
  }
}
