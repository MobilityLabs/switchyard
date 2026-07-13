// Thin `gh` CLI wrappers for the polling fallback (SYD-71). All decision
// logic lives in github-poll-lib.ts and is unit-tested there; this file only
// shells out. Uses execFile (never a shell) so repo names/branch names are
// inert, and `--repo owner/repo` so no local clone is needed — unlike
// delivery-exec.ts (which pushes/merges and therefore needs a working repo),
// polling only ever reads.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GhPr, GhRun } from "./github-poll-lib.js";
import { originOwnerRepo } from "./delivery-exec.js";

const execFileP = promisify(execFile);

async function run(args: string[]): Promise<string> {
  const { stdout } = await execFileP("gh", args, { maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

const PR_FIELDS = "number,headRefName,headRefOid,updatedAt,title,body,url,state,mergeCommit";

/** Most-recently-updated PRs (any state), bounded so a busy repo doesn't
 * burn the whole poll tick's API budget on ancient history. */
export async function listPullRequests(repo: string, limit = 50): Promise<GhPr[]> {
  const out = await run([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "all",
    "--limit",
    String(limit),
    "--search",
    "sort:updated-desc",
    "--json",
    PR_FIELDS,
  ]);
  return JSON.parse(out || "[]") as GhPr[];
}

/** A single PR by number — the targeted refresh (SYD-206) for open pr_state
 * rows that fell outside the poll window. Same execFile-argv posture as the
 * list call: repo names and numbers are inert arguments, never a shell
 * string. */
export async function viewPullRequest(repo: string, number: number): Promise<GhPr> {
  const out = await run(["pr", "view", String(number), "--repo", repo, "--json", PR_FIELDS]);
  return JSON.parse(out) as GhPr;
}

/** All PRs (any state) whose head is `branch` — the backfill's targeted
 * lookup for agent branches beyond the window (SYD-207). Argv-inert like
 * every other call here. */
export async function listPullRequestsForBranch(repo: string, branch: string): Promise<GhPr[]> {
  const out = await run([
    "pr",
    "list",
    "--repo",
    repo,
    "--head",
    branch,
    "--state",
    "all",
    "--limit",
    "10",
    "--json",
    PR_FIELDS,
  ]);
  return JSON.parse(out || "[]") as GhPr[];
}

/** Resolves each worker-configured project's clone to its GitHub owner/repo
 * (via the clone's origin remote) — the identity the SYD-207 preflight
 * checks against the server's linked-repo bindings. A clone that can't be
 * resolved is reported as a problem, not skipped silently. */
export async function resolveConfiguredRepos(
  projects: Record<string, { repo: string }>,
): Promise<{ configured: { projectKey: string; repo: string }[]; problems: string[] }> {
  const configured: { projectKey: string; repo: string }[] = [];
  const problems: string[] = [];
  for (const [projectKey, project] of Object.entries(projects)) {
    try {
      configured.push({ projectKey, repo: await originOwnerRepo(project.repo) });
    } catch (err) {
      problems.push(
        `project "${projectKey}": cannot resolve ${project.repo}'s origin remote: ${(err as Error).message}`,
      );
    }
  }
  return { configured, problems };
}

/** The latest workflow run for a branch, or null if it has none yet. */
export async function latestRun(repo: string, branch: string): Promise<GhRun | null> {
  const out = await run([
    "run",
    "list",
    "--repo",
    repo,
    "--branch",
    branch,
    "--limit",
    "1",
    "--json",
    "headSha,status,conclusion,url",
  ]);
  const runs = JSON.parse(out || "[]") as GhRun[];
  return runs[0] ?? null;
}
