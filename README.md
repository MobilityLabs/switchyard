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
`POST /api/dependencies` · `GET/POST/DELETE /api/webhooks`.

Issues in `triage` can only be moved out by human actors (enforced server-side).

## Webhooks

```bash
npx tsx src/cli.ts switchyard.db add-webhook https://example.com/hook SYD
```

Events POST as JSON (`event`, `issue`, `project`, `actor`, ...) with an
`x-switchyard-signature: sha256=<hmac>` header when a secret is set.
Delivery is best-effort (no retries), polled every 2 seconds.

## Development

```bash
npm test
```
