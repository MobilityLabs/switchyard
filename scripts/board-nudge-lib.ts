// Pure decision logic for the board-process Stop-hook nudge (SYD-189). The
// hook (board-nudge-hook.ts) gathers local signals via git/gh (board-nudge-
// exec.ts) and feeds them here; all the branching that decides whether — and
// how — to nudge lives in these pure functions so it is unit-tested without a
// shell. No board token, no network: local signals only.

// A board ref is <KEY>-<number>, KEY = 2+ letters (SYD, NOCT, …). Branch
// conventions this repo uses: `feat/syd-189-topic`, `agent/SYD-189`,
// `fix/SYD-42-thing`. The key may be lower- or upper-case in the branch; we
// normalize to the upper-case KEY-NUM the board uses.
const REF_RE = /\b([A-Za-z]{2,10})-(\d+)\b/;

function normalizeRef(key: string, num: string): string {
  return `${key.toUpperCase()}-${num}`;
}

/** The ref a branch name encodes, or null. Matches the first <KEY>-<n> token —
 * branch prefixes like `feat/`, `agent/`, `fix/` carry no digits so they never
 * false-match. */
export function refFromBranch(branch: string): string | null {
  const m = REF_RE.exec(branch);
  return m ? normalizeRef(m[1], m[2]) : null;
}

/** The first ref found scanning commit subjects in the given order (the caller
 * passes them newest-first), or null. */
export function refFromCommits(subjects: string[]): string | null {
  for (const subject of subjects) {
    const m = REF_RE.exec(subject);
    if (m) return normalizeRef(m[1], m[2]);
  }
  return null;
}

/** The turn-end reminder text. Nudge only — the session still does the actual
 * board transition through MCP with its own actor + provenance. */
export function nudgeReminder(ref: string, prNumber: number): string {
  return (
    `Board-process check (SYD-189): ${ref} has an open PR #${prNumber}. ` +
    `Before finishing, confirm ${ref} is in \`in_review\` (not left in \`in_progress\`) ` +
    `and that PR #${prNumber} is linked. If it already is, ignore this.`
  );
}

export type NudgeInput = {
  /** Claude Code sets this true on a stop that is itself the continuation of a
   * prior Stop-hook block — the guard that stops one nudge from trapping the
   * session in a loop. */
  stopHookActive: boolean;
  branch: string | null;
  commitSubjects: string[];
  /** The open PR for the current branch, or null if there is none. */
  openPr: { number: number } | null;
};

export type NudgeDecision =
  { nudge: true; ref: string; prNumber: number; message: string } | { nudge: false };

/** Decide whether to nudge, given purely local signals. Nudges once, only when
 * there is a derivable ref AND an open PR for the branch AND we are not already
 * mid-nudge — so a false positive (e.g. an interactive branch that legitimately
 * has no board issue) stays silent, and a real one can't loop. */
export function decideNudge(input: NudgeInput): NudgeDecision {
  if (input.stopHookActive) return { nudge: false };
  if (input.openPr === null) return { nudge: false };
  const ref =
    (input.branch ? refFromBranch(input.branch) : null) ?? refFromCommits(input.commitSubjects);
  if (ref === null) return { nudge: false };
  return {
    nudge: true,
    ref,
    prNumber: input.openPr.number,
    message: nudgeReminder(ref, input.openPr.number),
  };
}
