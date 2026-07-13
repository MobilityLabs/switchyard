// Thin `gh` CLI wrappers for the polling fallback (SYD-71). All decision
// logic lives in github-poll-lib.ts and is unit-tested there; this file only
// shells out. Uses execFile (never a shell) so repo names/branch names are
// inert, and `--repo owner/repo` so no local clone is needed — unlike
// delivery-exec.ts (which pushes/merges and therefore needs a working repo),
// polling only ever reads.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GhPr, GhRun } from "./github-poll-lib.js";

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
