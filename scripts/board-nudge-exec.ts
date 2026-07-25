// Local-signal gathering for the board-process Stop-hook nudge (SYD-189). Thin
// git/gh wrappers only — every decision lives in board-nudge-lib.ts. Uses
// execFile (never a shell) so branch names are inert, a short timeout so the
// hook can never hang turn-end, and swallows every failure to null: no repo, no
// gh auth, detached HEAD, gh offline — all degrade to "no nudge", never an
// error. No board token, no writes: reads only.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function tryRun(cmd: string, args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(cmd, args, {
      cwd,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Current branch, or null on a detached HEAD / non-repo. */
export async function currentBranch(cwd: string): Promise<string | null> {
  const out = await tryRun("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return out && out !== "HEAD" ? out : null;
}

/** The subjects of the most recent commits, newest first. */
export async function recentCommitSubjects(cwd: string, n = 10): Promise<string[]> {
  const out = await tryRun("git", ["log", "-n", String(n), "--format=%s"], cwd);
  return out ? out.split("\n").filter((s) => s.length > 0) : [];
}

/** The open PR for a branch, or null (no PR, PR closed/merged, gh unavailable). */
export async function openPrForBranch(
  cwd: string,
  branch: string,
): Promise<{ number: number } | null> {
  const out = await tryRun("gh", ["pr", "view", branch, "--json", "state,number"], cwd);
  if (!out) return null;
  try {
    const pr = JSON.parse(out) as { state?: string; number?: number };
    if (pr.state === "OPEN" && typeof pr.number === "number") return { number: pr.number };
  } catch {
    /* malformed gh output — treat as no PR */
  }
  return null;
}
