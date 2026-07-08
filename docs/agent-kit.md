# Claude Code priming kit

Switchyard is only useful to agents if they actually use it. An MCP server being
reachable is not the same as a Claude Code session knowing it should check for
work, file what it finds, or ask before guessing. Agents don't proactively adopt
a tracker's conventions unless they're primed — this doc is that priming: how to
register the MCP server for a person's sessions, and a CLAUDE.md snippet that
tells every session the house rules.

## 1. Register the MCP server (per person, user scope)

Mint a dedicated agent actor per person rather than sharing one token —
provenance and `assignee` filtering both depend on knowing which human's
sessions did what. Use the `claude/<name>-dev` naming convention:

```bash
npx tsx src/cli.ts switchyard.db add-actor claude/<name>-dev agent
# prints a token — store it, it's shown once
```

Then register the server at **user scope** (applies across all of that person's
projects/sessions, not just one repo) using the minted token:

```bash
claude mcp add --scope user switchyard --transport http http://100.85.158.109:3300/mcp \
  --header "Authorization: Bearer <agent token>"
```

## 2. Paste this into CLAUDE.md

Add the following block to the person's (or team's) CLAUDE.md so every session
picks up the conventions automatically:

````markdown
## Switchyard conventions

- When asked "what should I work on" or when idle between tasks, call
  `next_task` before doing anything else.
- File ANY discovered work — bugs noticed, TODOs, follow-ups, flaky tests —
  with `file_issue`, even if it's not what you were asked to do. Write a
  decision-grade description: what's wrong or needed, why it matters (impact
  if ignored), and your suggested next action.
- Call `claim_issue` before starting work on an issue.
- Comment progress as you go (`comment`) — don't go silent on a claimed issue.
- If you're blocked on a decision only a human can make, use
  `request_human_input` instead of guessing.
- Before moving an issue to `in_review`, comment the verification evidence:
  what you did and how you verified it.
- NEVER move an issue to `done`. That's a human or review-step call, always.
````

## Why this exists

Switchyard's MCP tools are available the moment the server is registered, but
availability isn't adoption. Left to their own judgment, agents default to
scratch todo lists, silent fixes, and chat-only summaries — none of which
leave provenance, none of which a human can triage or audit later. The
conventions above turn "the tools exist" into "the tools are used the way the
tracker's gating model (triage inbox, claim-before-work, human-only done)
assumes they'll be used."
