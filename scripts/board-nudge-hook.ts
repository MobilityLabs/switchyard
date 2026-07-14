// Stop-hook entry for the board-process nudge (SYD-189). Registered in the
// repo's .claude/settings.json so every interactive session working in this
// repo gets the same deterministic backstop the SYD-182 session lacked: if the
// current branch has an open PR, remind the session to confirm the issue is in
// `in_review` before finishing.
//
// Contract (Claude Code Stop hook): reads a JSON event on stdin
// ({ cwd, stop_hook_active, ... }); to nudge, prints
// { "decision": "block", "reason": <text> } and exits 0 — Claude sees `reason`
// and does one more turn to act on (or dismiss) it. The follow-up stop arrives
// with stop_hook_active=true, which decideNudge treats as "already nudged" and
// stays silent, so a single reminder can never trap the session in a loop.
// Any error, missing stdin, or non-repo cwd exits 0 silently — a guardrail must
// never itself break turn-end.

import { readFileSync } from "node:fs";
import { decideNudge } from "./board-nudge-lib.js";
import { currentBranch, recentCommitSubjects, openPrForBranch } from "./board-nudge-exec.js";

async function main(): Promise<void> {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    /* no stdin */
  }
  let input: { cwd?: string; stop_hook_active?: boolean } = {};
  try {
    input = raw ? (JSON.parse(raw) as typeof input) : {};
  } catch {
    /* malformed event — fall through with defaults */
  }

  const stopHookActive = input.stop_hook_active === true;
  // Already mid-nudge: stay silent without even shelling out.
  if (stopHookActive) return;

  const cwd = input.cwd ?? process.cwd();
  const branch = await currentBranch(cwd);
  const commitSubjects = branch ? await recentCommitSubjects(cwd) : [];
  const openPr = branch ? await openPrForBranch(cwd, branch) : null;

  const decision = decideNudge({ stopHookActive, branch, commitSubjects, openPr });
  if (!decision.nudge) return;

  process.stdout.write(JSON.stringify({ decision: "block", reason: decision.message }));
}

main().catch(() => {
  /* never break turn-end on a guardrail failure */
});
