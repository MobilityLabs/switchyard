# Switchyard

Self-hosted, agent-native project tracker. Humans plan on a shared board;
Claude Code agents file, triage, claim, and work issues through MCP —
gated by human triage, with provenance on everything.

Spec: `docs/superpowers/specs/2026-07-07-switchyard-design.md`

## Quick start

```bash
npm install
npx tsx src/cli.ts switchyard.db add-project AIPI "aipi benchmarking"
npx tsx src/cli.ts switchyard.db add-actor sean human
npx tsx src/cli.ts switchyard.db add-actor claude/worker agent
npm run dev   # listens on :3300
```

## Connect Claude Code

```bash
claude mcp add switchyard --transport http http://localhost:3300/mcp \
  --header "Authorization: Bearer <token from add-actor>"
```

Tools: `list_projects`, `get_issue`, `search_issues`, `next_task`,
`file_issue`, `claim_issue`, `update_issue`, `comment`, `triage_queue`,
`add_dependency`.

For a per-person setup (user-scoped registration, a CLAUDE.md snippet that
primes sessions to actually use the tracker) see `docs/agent-kit.md`.

## Web UI

The server serves the web UI at `/` — triage inbox (default), per-project board
with drag-to-move, and issue detail. Log in once via a minted link (below); the
session cookie lasts 30 days.

## Humans: log in

```bash
npx tsx src/cli.ts switchyard.db mint-login sean
# open the printed link — it sets a 30-day session cookie
```

## REST API

All routes under `/api` accept a bearer token (agents) or the session cookie (humans).
`GET/POST /api/projects` · `GET /api/actors` · `GET/POST /api/issues` ·
`GET/PATCH /api/issues/:ref` · `POST /api/issues/:ref/claim` ·
`POST /api/issues/:ref/comments` · `GET /api/next-task` ·
`POST /api/dependencies` · `GET/POST /api/webhooks` · `DELETE /api/webhooks/:id` ·
`GET /api/events`.

`GET /api/events?since=<unix>&limit=<n>` — global, newest-first activity feed
(events joined with issue ref/title, project key, and actor name). `limit`
defaults to 200, capped at 500. Powers reflection tooling like the Dreamer
(below); useful for any external consumer that wants "what happened
recently" without polling per-issue.

Issues in `triage` can only be moved out by human actors (enforced server-side).

## Webhooks

```bash
npx tsx src/cli.ts switchyard.db add-webhook https://example.com/hook SYD
```

Events POST as JSON (`event`, `issue`, `project`, `actor`, ...) with an
`x-switchyard-signature: sha256=<hmac>` header when a secret is set.
Delivery is best-effort (no retries), polled every 2 seconds.

### Slack notifications

A standalone consumer (its own process, not part of the main server) that turns
select webhook events into Slack messages: new triage filings, needs-input
escalations, and issues moving to `in_review`. Everything else is dropped.

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... npx tsx scripts/slack-notifier.ts
```

Then register it as a webhook (optionally scoped to a project, optionally signed):

```bash
npx tsx src/cli.ts switchyard.db add-webhook http://<host>:3301/ [PROJECT] <secret>
```

If you set a secret, also export it as `SWITCHYARD_WEBHOOK_SECRET` on the notifier
process so it can verify the `x-switchyard-signature` header. It ships unconfigured
— nothing posts to Slack until `SLACK_WEBHOOK_URL` is set and the webhook is
registered. Always set a webhook secret when registering — an unsigned webhook
endpoint will accept spoofed events from anyone who finds the URL.

## Auto-dispatch

A local poller (`scripts/agent-worker.ts`, meant to run on a person's own machine)
that spawns headless Claude Code sessions on ready work.

The human control point is a label: only issues in `todo` carrying the
configured label (`auto` by default) are ever picked up. Copy the example
config and edit it for your machine:

```bash
cp switchyard-worker.example.json switchyard-worker.json
```

```json
{
  "url": "http://100.85.158.109:3300",
  "label": "auto",
  "intervalSeconds": 300,
  "maxConcurrent": 1,
  "projects": { "SYD": { "repo": "/Users/sean/sites/switchyard" } }
}
```

Label an issue to opt it in, then run the worker:

```bash
SWITCHYARD_TOKEN=... npx tsx scripts/agent-worker.ts            # poll forever
SWITCHYARD_TOKEN=... npx tsx scripts/agent-worker.ts --once     # single poll
SWITCHYARD_TOKEN=... npx tsx scripts/agent-worker.ts --dry-run  # print, don't spawn
```

Safety model: the label gate (nothing runs unlabeled), `maxConcurrent` (caps
concurrent headless sessions), and the fact that dispatched work still flows
through the same claim -> in_review -> human-review pipeline as anything else
— dispatched sessions can never move an issue to `done` themselves, and the
server enforces this (agents attempting a `done` transition are rejected, not
just discouraged by the prompt). Each dispatch's stdout/stderr is logged to
`<project repo>/.superpowers/worker-logs/<ref>.log`.

Labeling an issue `auto` is consent to run that issue's content (title,
description, comments) through a headless session with your local permission
profile — review the issue text like you'd review a script before running it,
and keep the worker's permission allowlist tight.

## The Dreamer

A nightly reflection job (SYD-28): once a night, a headless Claude Code
session reads the last 24h of tracker activity (`GET /api/events`) plus the
full board and triage queue, looks for patterns — review-column latency,
needs-input response gaps, stale/parked issues, recurring themes in what
agents file, board hygiene, error signals, and integration opportunities
(e.g. repeated manual SHA citations that a GitHub link would remove) — and:

1. writes a dated digest to `~/.claude/dreams/switchyard-YYYY-MM-DD.md`
   (counts, top 3-5 ranked observations, open questions — a one-minute read), and
2. files at most 3 concrete, decision-grade findings back into triage
   (after checking they aren't already tracked), each with provenance
   `sourceType: "session"`, `detail: "dreamer nightly YYYY-MM-DD"`.

It never modifies existing issues — read and file only. See
`prompts/dreamer.md` for the full instructions and `scripts/dreamer.sh` for
the runner (modeled on cc-autodream's lean headless-invocation pattern).

Install the nightly schedule (04:30 local time):

```bash
cp launchd/com.switchyard.dreamer.plist ~/Library/LaunchAgents/
# edit the copy: replace REPLACE_WITH_TOKEN with a real actor token
# (npx tsx src/cli.ts switchyard.db add-actor dreamer agent), and check
# SWITCHYARD_URL / WorkingDirectory match your host
launchctl load ~/Library/LaunchAgents/com.switchyard.dreamer.plist
```

Manual run:

```bash
SWITCHYARD_URL=http://localhost:3300 SWITCHYARD_TOKEN=... sh scripts/dreamer.sh
```

Dry run (writes the digest, files nothing):

```bash
SWITCHYARD_URL=http://localhost:3300 SWITCHYARD_TOKEN=... DREAMER_DRY_RUN=1 sh scripts/dreamer.sh
```

## Development

```bash
npm test
npm run typecheck
```
