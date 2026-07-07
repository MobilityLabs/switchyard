# Switchyard — Design

**Date:** 2026-07-07
**Status:** Approved pending user review
**Author:** Sean + Claude (brainstorming session)

## What it is

Switchyard is a self-hosted, agent-native project tracker for small human teams that work alongside Claude Code agents. Humans plan and coordinate on a shared board; agents read, work, and — critically — file and help triage issues, so the board reflects reality without manual entry. The API and MCP server are the product; the web UI is a thin client.

The name: a switchyard is where a rail yard sorts incoming cars onto the right tracks — work arrives from humans and agents, gets sorted at the triage gate, and moves down status tracks to done. Fits the Mobility Labs transportation identity.

## Goals

- One shared board for 2–5 humans plus Claude Code agents across many projects.
- **Bidirectional planning day one:** agents create and triage issues (from session summaries, code TODOs, CI failures), not just execute them.
- Self-hosted; client project data never leaves infrastructure we control.
- Tight fit over feature breadth; deliberately smaller than Linear.
- Plausible path to a Mobility Labs product without building product scaffolding now.

## Non-goals (v1)

- Cycles, sprints, roadmaps, estimates, velocity.
- Roles/permissions — everyone in the workspace sees everything. Data sensitivity is handled by hosting (Tailscale), not ACLs.
- Realtime sync (websockets, live cursors). Polling every ~15s.
- Multi-tenancy, orgs, billing.
- Autonomous dispatch (auto-spawning headless agents on `todo` issues). The webhook surface makes this a small external script later, not a v1 feature.
- Competing with Linear on UI polish. No command palette.

## Positioning / competitive landscape

- **Linear (+ Linear for Agents):** agents as workspace members — right mental model, but SaaS, per-seat, no self-host, no product potential for us.
- **beads (Yegge):** git-backed, local-first agent memory per repo. Excellent within one repo; weak as a shared cross-project board for a human team. Steal: the dependency graph (blocks/blocked-by) and the "never lose discovered work" ethos.
- **Gas Town (Yegge):** coding-agent factory on top of beads. Agent-first — human is the audience.
- **Paperclip (paperclip.ing):** open-source "zero-human company" orchestrator — AI CEO hires agent employees into an org chart with budgets and governance. The inverse of our framing. Steal (roadmap, not v1): per-agent budgets/cost caps.
- **MetaGPT / ChatDev:** academic virtual-software-company frameworks. Steal: structured artifacts over chat (reflected in our provenance model).

**The gap Switchyard occupies:** every tool above is agent-first — the org chart is agents and the human is a CEO or spectator. Nothing self-hosted does "a real human team's tracker where agents are governed teammates": humans own the board, agents participate through a triage gate, everything attributed and auditable. For a consultancy with client accountability, that governance-first inversion is the defensible position.

## Core concepts & data model

**Hierarchy:** one workspace → projects (roughly repos/clients) → issues.

**Actors.** One `actors` table, `type: human | agent`. Every creator, assignee, comment, and status change is attributed to an actor. Agent actors are durable identities (e.g., `claude/aipi-worker`) with their own bearer tokens — not shared API keys. The activity feed reads "claude/aipi-worker moved this to In Review," same as a person.

**Issues:**
- Per-project ID (`AIPI-42`), title, markdown description.
- Status: `triage → backlog → todo → in progress → in review → done | canceled`.
- Priority, assignee (any actor), labels, optional parent (sub-issues).
- **Dependencies:** blocks / blocked-by edges, so "what's actually workable" is a query.

**Agent-native distinctives:**

1. **Provenance.** Agent-created issues record where they came from: source type, session ID, repo, `file:line` for a TODO, CI run URL. Humans triage with receipts, not claims.
2. **The triage gate.** Agent-created issues land in `triage`, not on the board. A human accepts, edits, or dismisses. This is the core trust mechanism — bidirectional planning fails socially if agents can pollute the shared board directly.

**Comments + activity log:** immutable, actor-attributed, append-only events table per issue. Issue state is the latest fold of events; the audit trail is free. Doubles as agent memory — a resuming session reads issue history to catch up.

## MCP & API surface

One service layer, three clients: MCP server (agents), REST API (webhooks, CLI, scripts), web UI. No client has private powers.

**MCP tools (~10):**

Reading / orienting:
- `list_projects`, `get_issue`, `search_issues` (project, status, assignee, label, free text).
- `next_task` — "highest-priority issue assigned to me (or unassigned in project X) that isn't blocked." One call turns any Claude session into a worker that knows what to do.

Working:
- `claim_issue` (assign self + move to in progress), `update_issue`, `comment`.

Bidirectional planning:
- `file_issue` — creates in `triage`, provenance fields required. Tool description instructs agents to file discovered work (TODOs, flaky tests, follow-ups) rather than dropping it in chat.
- `triage_queue` — human asks Claude to review the triage inbox with them: dedupe, suggest priorities, merge related items. Triage stays a human decision, but assisted.

**Behavioral conventions encoded in tool descriptions:**
- Always comment before moving an issue to `in review`: what was done, how it was verified.
- Never move your own issue to `done` — a human or review step does that.

**REST API + webhooks:** same operations over HTTP with token auth; outbound webhooks on issue events (the hook for later dispatch automation).

**Auth:** humans get magic-link login; agents get per-actor bearer tokens minted from the UI.

## Architecture & stack

- **One TypeScript service** (Node + Hono): service layer + three thin adapters — REST routes, MCP server (official SDK, streamable HTTP transport so remote Claude Code sessions can connect), web UI. One process, one deploy, one log.
- **SQLite** with Litestream replication for backup. Schema via Drizzle so a later Postgres move is a driver swap. Events table is append-only.
- **Web UI:** React + Vite, served by the same process. Three views: per-project board (columns = statuses, drag to move), issue detail (description, comments, activity, provenance links), and the **triage inbox** — the most design attention goes here; accept/edit/dismiss is the workflow that makes or breaks trust.
- **Hosting:** one Docker container on the NAS behind Tailscale initially (VPS is the fallback if NAS resources disappoint). Public URL later is config, not code.
- **Product discipline:** single-tenant now. The actor/provenance/triage model is the product IP; it survives a rewrite of everything around it.

## Error handling

MCP tools return structured, agent-legible errors — the error message is effectively a prompt. Example: "issue AIPI-42 is blocked by AIPI-40 — resolve the blocker or call next_task for another issue." No stack traces across the MCP boundary. REST returns conventional problem+json.

## Testing

- Service layer unit tests run against real SQLite (fast enough; no mocking the DB).
- One integration test drives the full core loop — agent files issue → human accepts → agent claims → comments → moves to in review — because that loop is the product.
- MCP surface tested by invoking tools through the SDK against a test server.

## v1 cut lines

In: projects, issues, statuses, priorities, labels, sub-issues, dependencies, comments, activity log, actors (human + agent), provenance, triage inbox, ~10 MCP tools, REST + webhooks, board/detail/triage UI, magic-link + token auth, Docker deploy.

Out (roadmap candidates): autonomous dispatch watcher, per-agent token/cost budgets (Paperclip-inspired), realtime sync, permissions/roles, GitHub Issues import/sync, notifications (email/Slack), multi-tenancy.

## Risks

- **Scope creep toward Linear.** Mitigation: the v1 cut lines above; UI stays unambitious.
- **Triage inbox becomes a chore.** If agents over-file, humans stop triaging. Mitigations: `triage_queue` assisted review; tool-description guidance on when to file; dedupe hints at file time (roadmap).
- **Crowded adjacent space.** Paperclip et al. could pivot toward governed human teams. Our wedge is being tracker-first and self-hosted, not company-simulation-first.
- **Maintenance decay.** It's an internal tool from a consultancy. Mitigation: boring stack, one process, SQLite, tests on the core loop.

## Rough build order (detailed plan comes from writing-plans)

1. Schema + service layer + events (core loop, tested).
2. MCP server with the 10 tools; dogfood from Claude Code immediately.
3. REST + auth + webhooks.
4. Web UI: triage inbox first, then board, then issue detail.
5. Docker + Tailscale deploy; migrate real projects onto it.
