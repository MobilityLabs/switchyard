# Competitor Feature Analysis & Suggested Features

**Date:** 2026-07-07 · **Inputs:** three research sweeps (Linear/Linear-for-Agents; beads/Gas Town; Paperclip + 2026 landscape). Full inventories in the session record; sources linked at bottom of each sweep.

## The landscape in one paragraph

Linear has gone agent-native from the top down (agents as free workspace members, delegation-not-replacement assignment, an Agent Session API, LLM-assisted triage) but remains closed SaaS. beads/Gas Town own agent ergonomics from the bottom up (ready-work detection, discovered-from edges, durable memory) but have no human governance story and a chaotic orchestration layer users find overwhelming. Paperclip owns the "agent org" fantasy and its users' loudest complaint is exactly what Switchyard enforces structurally: **no per-work-item human gate, no escalation path**. One direct competitor emerged: **Hiveship** (agent-first kanban, per-agent identity, inline-diff review, MCP) — closest analog to Switchyard, but its human approval is workflow-configurable, not structurally enforced. **OpenAI Symphony** is a spec for orchestrating coding agents against existing trackers — a potential compatibility target, not a competitor.

**Positioning read:** the triage gate + human-only transitions remain the defensible wedge. Nobody else enforces governance in the data model. Hiveship validates the category; Paperclip's complaint threads validate the gate; Linear validates the UX patterns worth borrowing.

## Suggested features (decision-grade: what / why / effort)

### Tier 1 — high value, small, borrow now

1. **Stale-claim detection ("the Witness").** Issues `in_progress` with no events for N hours get flagged and auto-released to `todo` with an event. Why: agents die mid-task; today a dead agent's claim blocks work forever. Linear solves it with session acknowledgment timeouts, Gas Town has a dedicated Witness role, Paperclip's issue tracker is full of "zombie task" complaints. Effort: ~2h (sweep in the dispatcher tick + tests).
2. **"Needs human input" escalation.** Let an agent mark a claimed issue as blocked-on-a-question; surface those in a dedicated inbox lane next to triage. Why: Paperclip's single loudest complaint is that agents barrel ahead with no escalation path; today our agents can only comment and hope. This extends the governance wedge. Effort: ~3h (status or flag + UI lane + MCP tool description).
3. **Triage actions parity: snooze + mark-duplicate.** Linear's fixed accept/decline/duplicate/snooze action set keeps triage fast. We have accept/dismiss; snooze (hide until date/activity) and duplicate-linking are the missing two. Effort: ~3h.
4. **Slack notifier.** A small webhook consumer posting triage arrivals and review-column changes to a channel. Why: Linear's inbox/Slack loop is the #1 reason boards stay current; we already ship signed webhooks — this is a consumer script, not a server feature. Effort: ~2h.
5. **Claude Code integration kit.** A skill/CLAUDE.md snippet that makes any session auto-check `next_task`, file discovered work, and follow board conventions. Why: beads' biggest reported pain is that agents don't *proactively* use the tracker — the fix is priming, not server code. Effort: ~2h, mostly docs.

### Tier 2 — differentiating, medium effort

6. **Duplicate hints at triage (Triage Intelligence, lite).** Show "similar existing issues" (title text-similarity) on triage rows and at `file_issue` time. Why: dedupe is the most decision-relevant context we don't show; Linear ships this LLM-assisted, we can start with trigram/LIKE similarity. Effort: ~1 day.
7. **GitHub linking via magic words.** "fixes SYD-42" in commits/PRs → issue events + auto-transition on merge. Why: Linear's most-loved integration; our agents already cite SHAs in comments manually. Effort: ~1 day (webhook receiver from GitHub, needs the repo pushed to a remote first — SYD-14).
8. **Insights, governance edition.** From the event log we already have: agent vs human throughput, time-in-triage, time-in-review, stale-claim counts. Why: Linear proves managers pay for this; ours uniquely answers "how well is the human-agent contract working." Effort: ~1-2 days (one API endpoint + one UI view).
9. **Richer relation types.** `discovered-from` and `duplicates` edges alongside `blocks`. Why: beads' `discovered-from` is the best idea in its data model — it gives filed-while-working issues a machine-readable origin trail beyond our provenance text. Effort: ~1 day (relation column + UI).
10. **Delegation model (owner + delegate).** Linear keeps the human as owner of record while the agent works. Why: sharpens accountability semantics for client work; today assignee is one field. Effort: ~1 day.

### Tier 3 — product-scale, only with real multi-team demand

11. **Guidance endpoint** — workspace-level conventions agents fetch at session start (Linear's Guidance, our tool descriptions generalized).
12. **Per-agent activity caps + suspend switch** (Paperclip budgets, Linear's suspend) — governance observability once multiple agents run unattended.
13. **Triage responsibility rotation** (Linear) — when the team is on the board.
14. **Symphony-compatible surface** — implement the OpenAI Symphony spec's tracker interface so third-party orchestrators can drive Switchyard.

### Deliberately NOT adopting

- **Org charts / persona hierarchies / agent-hires-agent** (Paperclip, Gas Town): the telephone-game quality dilution and "19-agent trap" are their users' own words; our flat actor model is the lesson, not the gap.
- **Cycles/sprints/roadmaps, command palette, realtime sync**: spec non-goals, unchanged — Linear wins polish; we win governance and self-hosting.
- **Zero-human autonomy**: the market's own reviews ("nobody says the statistic is made up") are the argument for our gate.
