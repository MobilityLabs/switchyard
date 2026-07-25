---
description: One board-process watch pass — surface SYD-188 process deviations on the issues you're working. Run under /loop while doing board work.
---

Run a single **board-process watch pass** for Switchyard (SYD-189). This reads the
server's computed process-deviation signal (SYD-188) via MCP — it does not
re-derive state — and nudges only. It never mutates the board; you make any
actual transition yourself through the normal MCP path.

Meant to be run on an interval with `/loop` (e.g. `/loop /syd-watch`) while you
have board work in flight. One pass:

1. Call `whoami` to get your actor name (call it `ME`).
2. Call `search_issues(assignee=ME)`. For each returned issue, look at its
   `attention` field — a non-null `reason` is a live deviation. Flag any of:
   - `open_pr_not_in_review` — you opened a PR but the issue is still
     `in_progress`/other; move it to **in_review** (the exact SYD-182 miss).
   - `merged_pr_not_done` — the PR merged but the issue isn't `done`; a human
     stamps done, so surface it for the human rather than stamping it yourself.
   - `stale_claim` — you're holding a claim that's gone stale; re-confirm you're
     still on it or release it.
   - `done_without_merged_pr` — stamped `done` with nothing merged on record;
     check whether delivery silently skipped (see SYD-228) and re-stamp/deliver.
3. Call `recent_events` (default window) and scan for another actor acting on an
   issue **you** currently hold `in_progress` — a `claimed`, `status_changed`,
   or `pr_opened` by a different actor on one of your issues means a worker or
   another session may be racing you (the SYD-93 double-work shape). Surface it.

Then report **concisely**:
- If nothing is off: one line — `board-process: clear (N issues assigned, no deviations)`.
- Otherwise: a short bullet per deviation — `REF — <reason>: <what to do>` — and
  nothing else. Do not take the board action for the human; just nudge.

If MCP is unavailable this pass, say so in one line and end the pass — never
block on it.
