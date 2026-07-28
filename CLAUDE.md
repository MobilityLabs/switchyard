# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Switchyard is a self-hosted, agent-native project tracker: humans plan on a shared board, Claude Code agents file/triage/claim/work issues through MCP, gated by human triage with provenance on everything. The API and MCP server are the product; the web UI is a thin client. Full design: `docs/superpowers/specs/2026-07-07-switchyard-design.md`.

Architecture maps live in `codemaps/` (generated — regenerate with `/update-codemaps`, don't hand-edit): `architecture.md`, `backend.md`, `data.md`, `frontend.md`, `workers.md`.

This repo tracks its own work in Switchyard itself (project key `SYD`) via the `switchyard` MCP server — check/update issues there rather than keeping side lists.

## Commands

```bash
npm run dev            # server on :3300 (tsx src/server.ts); SWITCHYARD_DB / PORT env override
npm test               # vitest run (all tests)
npx vitest run tests/services/issues-update.test.ts   # single test file
npm run typecheck      # checks BOTH tsconfigs: app (tsc --noEmit) and ui (tsc -p ui)
npm run lint           # eslint .
npm run format:check   # prettier --check . (npm run format to fix)
npm run build:ui       # vite build → dist/ui (server 404s SPA routes until this exists)
npm run dev:ui         # vite dev server for UI work
npm run db:generate    # drizzle-kit generate — run after editing src/db/schema.ts
npm run deploy         # ship working tree to the NAS + rebuild container (scripts/deploy-nas.sh)
npm run init-worker    # doctor for the auto-dispatch worker (--self-test, --install-launchd)
npm run build:worker-image   # docker image for containerized dispatch
npx tsx scripts/syd.ts       # authenticated API client — see below
```

Before opening a PR, run `npm run lint && npm run format:check && npm run typecheck && npm test` — CI (`.github/workflows/ci.yml`) runs the same checks and fails the build on any of them.

Admin CLI (first arg is the db path): `npx tsx src/cli.ts switchyard.db add-project|add-actor|mint-login|add-webhook|backfill-pr-links ...`

**`scripts/syd.ts` — talk to the API without hand-assembling a curl.** Reads the token from `.env`, puts it only in a request header (never argv, per the security invariant below).

```bash
npx tsx scripts/syd.ts whoami                                  # which actor your token is
npx tsx scripts/syd.ts pr-link list SYD-280                    # an issue's declared links
npx tsx scripts/syd.ts pr-link confirm SYD-280 226             # human-only: make a link proof-bearing
npx tsx scripts/syd.ts api GET /issues/SYD-280                 # anything else
npx tsx scripts/syd.ts whoami --as SWITCHYARD_TOKEN            # pick a credential explicitly
```

Before any write it prints `acting as <name> (<type>) via <KEY>`. Read that line. Variable names describe the *actor*, not the tier — `SWITCHYARD_HUMAN_TOKEN` is a person, `SWITCHYARD_GITHUB_POLLER_TOKEN` and `SWITCHYARD_DELIVER_POLLER_TOKEN` are `service` actors, and `SWITCHYARD_TOKEN` is the dispatch worker's *agent* token, which the delivery and GitHub-ingestion endpoints refuse on purpose.

`worker-sdk/` has isolated dependencies (`npm install --prefix worker-sdk`) because the Claude Agent SDK needs zod@4 while the app is on zod@3.

## Constraints & conventions

**All business logic goes in `src/services/*`.** The MCP server, REST API, and web UI are thin adapters over the same functions — no client has private powers. Add capabilities to the service layer first, then expose per client. Services throw `SwitchyardError` for user-facing failures (MCP `guard()` → isError result, REST → 4xx); anything else is a real 500.

**Server-enforced rules — keep them enforced in services (not just prompts), and keep their tests:**
- Issues in `triage` can only be moved out by human actors.
- Agents can never transition an issue to `done` (a human stamps it).
- Dependency removal is human-only.
- Agent-created issues land in `triage` with required provenance.
- `claim_issue` (and a direct PATCH to `in_progress`) refuses an issue already claimed by someone else, or sitting behind an open agent PR from a prior claim.

**Claim before you touch code.** For any board-tracked issue, call `claim_issue` before editing files — even in an interactive/coordinating session, not just dispatched workers. This is what lets the server (and the dispatch worker) see your claim and refuse to double-work the same issue; skipping it is exactly how SYD-93 got fixed twice in parallel (worker PR #41 vs a coordinating session's PR #42, opened without ever claiming).

**Declare your PR when you open it.** Call `declare_pr_link` (MCP) or `POST /issues/:ref/pr-links` as soon as a PR exists, on any branch. The issue↔PR link is a *declaration*, not a guess: nothing infers it from the branch name or from mentioning the ref in the PR title. Skip it and the board cannot tell your work exists — the PR won't gate a second claim, won't be deliverable, and won't clear `done_without_merged_pr`. Dispatched workers get this for free (the host declares at publish); interactive sessions must do it themselves, which is exactly the gap that made `feat/` work invisible. Your declaration blocks other claimants but does **not** prove the work landed — a human confirms that at review (SYD-280).

**Mutate issues only through services** — core issue state lives in mutable columns on the `issues` table, with `events` a co-written append-only audit log (not a fold/replay source — see `src/services/issues.ts`); a direct DB write would skip that log. Only the auxiliary attention/open-PR/unanswered-questions signals are actually derived by querying `events` (see `src/services/attention.ts`, `pr-status.ts`, `events.ts`), so those can't drift from what happened.

**Security invariants:**
- Secrets live in `.env` (0600, never committed, excluded from the deploy tarball).
- Tokens must never appear in argv — pass via env or file handoff (see `buildDockerArgs` in `scripts/worker-select.ts` and the sdk runner).
- Worker containers get no GitHub credentials and can only push `agent/<ref>` branches; merging is a human decision.

**Branches:** `feat/<topic>` for interactive work; `agent/<REF>` (e.g. `agent/SYD-42`) is reserved for dispatched worker sessions. Commit messages reference the issue ref, e.g. `feat: containerized dispatch mode in the worker (SYD-30)`. Since SYD-280 the branch name is a **convention, not attribution** — it triggers auto-declaration for dispatched work, but the link itself is the `pr_links` row. Never add a rule that reads a ref out of a branch or a PR title to decide what a PR belongs to.

**MCP transport gotcha:** in `src/server.ts`, never pre-read the `/mcp` request body — the transport consumes the stream itself; reading it twice throws "ReadableStream is locked".
