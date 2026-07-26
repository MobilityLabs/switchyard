---
name: make-issue
description: Use when filing, creating, or drafting a Switchyard issue (via the switchyard MCP file_issue tool or the web UI) — captures what a good issue must contain, the required topic tags, how to route work that a headless agent can't do (workerPreference "interactive"), and when to break a big ask into an epic + stories instead of one blob.
---

# Making a good Switchyard issue

A Switchyard issue is the unit of work a human triages and an agent (or a
human) executes. A vague issue wastes a dispatch: the worker guesses, produces
the wrong thing, or escalates. Spend the effort here so the executor doesn't
have to reconstruct it.

**Before filing anything**, decide three things: (1) is this one issue or an
epic that needs decomposing? (2) can a headless agent actually finish it? (3)
what is it about (its tags)? The sections below are that decision, in order.

## 1. Is it one issue, or an epic?

If the ask is multi-subsystem, needs a design decision, or is more than roughly
one working session, **do not file it as one issue.**

1. Brainstorm and write a spec in `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
   (use the `brainstorming` skill).
2. File a **parent epic** issue (the outcome), then file each **story** as a
   child with `parent_ref: <EPIC-REF>` — each story independently completable and
   independently valuable.
3. Use **dependencies** (blocks / blocked-by via `add_dependency`) for *ordering*
   between stories. Parent/child is *containment*; dependencies are *sequence* —
   they're different axes, and you often use both.

There is no "epic" label — an issue *with children* is an epic by definition
(the UI badges the story count). Don't invent one.

Worked example: the Codex/Gemini engines were an epic (`Project 2`) with
per-engine stories (SYD-187 codex, SYD-225 gemini) plus follow-up stories
(SYD-220 lease header), each its own issue under the parent.

## 2. Can a headless agent finish it? (routing)

**Litmus:** *Could a headless agent, in a disposable container with no human
present and no real external credentials, complete this and open a PR?*

If **no** — it needs live credentials, a real provider CLI/binary, an
interactive spike, a browser/GUI login, or a mid-task human decision — set
**`workerPreference: "interactive"`**. The dispatch worker hard-skips those, so
a human/interactive session picks it up instead of a headless worker getting
stranded and escalating.

> This is the exact failure that motivated the field: SYD-220 (verify codex
> config live) and SYD-225 (spike Gemini auth) *needed* real CLIs + credentials;
> dispatched headless workers just blocked and asked for a human. Mark that kind
> of work `interactive` up front.

If a specific engine is preferred but any could do it, set `workerPreference` to
that engine name (`claude` / `codex` / `gemini`) — it's a soft sort, not a hard
filter, so the issue still gets picked up if that engine's worker is busy.
Leave it unset (**Any**) for ordinary work.

**The `ui` label routes to interactive automatically (SYD-239).** `createIssue`
defaults `workerPreference` to `"interactive"` for any issue labeled `ui`, so you
don't need to set it by hand. The reason: SYD-183 asks for a screenshot on UI
work, and the worker images ship the upload path (`switchyard-attach`) but no
browser to produce one — so visual verification only really happens in a
human-attended session. It's a *default*, not an override: pass an explicit
`workerPreference` if a particular `ui` issue genuinely is headless-doable (a
mechanical rename, a pure test change) and it wins.

## 3. What is it about? (topic tags — required)

**Every issue carries at least one topic label** naming its area, so the board
is filterable and triage is fast. Use existing labels where they fit; examples:
`ui`, `dispatch`, `engine-worker`, `security`, `docs`, `data`, `mcp`, `rest`,
`worker-host`. Don't file an untagged issue.

(The `auto` label is different — it's a human-only *dispatch opt-in*, not a
topic tag. Agents can't apply it.)

## 4. Anatomy of the issue body

Model every issue on the ones that executed cleanly (SYD-220/225). Provide:

- **Title** — the outcome, specific. "Wire codex containers for the lease
  header", not "codex lease stuff".
- **Summary** — one sentence a human can triage from at a glance. This is what
  shows on the card.
- **Description**, with these beats:
  - **What** — the concrete change, in the codebase's terms (name the files /
    functions you already know are involved).
  - **Why** — what breaks or is missing without it; link the driving issue/PR.
  - **Next action** — the first step the executor should take (the spike to run,
    the file to edit, the thing to verify first). Especially important when the
    work is gated on a decision or an unknown.
  - **Provenance** — where this came from (a review, a session, a human ask).
    `file_issue` records the actor automatically; add the source in the body when
    it's a decision or a prior issue.
  - **Effort** — a rough size, and any decomposition note.

Write the description so someone with no memory of this conversation can execute
it. If it depends on an unproven assumption, say so and make verifying it the
first next-action — don't bury a guess as fact.

## 5. File it

- **MCP** (agent or interactive session): `file_issue` with
  `project_key`, `title`, `summary`, `description`, `labels`, `priority`,
  `parent_ref` (for a story), and `worker_preference` (`"interactive"` or an
  engine). Agent-filed issues land in `triage` with provenance for a human to
  accept.
- **UI**: the New issue form has Summary, Labels, **Preferred worker**, and
  **Parent (epic)** fields for the same.

## Checklist

- [ ] One issue, or an epic with `parent_ref` stories + a spec?
- [ ] `workerPreference: "interactive"` if a headless agent can't finish it?
- [ ] At least one topic label?
- [ ] Title = outcome; one-sentence summary; body has What / Why / Next action / Provenance / Effort?
- [ ] Executable by someone with no memory of this conversation?
