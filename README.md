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
`POST /api/dependencies` · `GET/POST /api/webhooks` · `DELETE /api/webhooks/:id`.

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
registered.

## Development

```bash
npm test
npm run typecheck
```
