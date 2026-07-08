> Generated: 2026-07-08 | Token-lean format for LLM context

# Backend

## Services (`src/services/`) — the only place business logic lives

| File | Exports (key) | Notes |
|------|---------------|-------|
| `actors.ts` | `createActor`, `authenticate`, `listActors`, `Actor` | Bearer token → sha256 → actor lookup |
| `auth.ts` | `createLoginLink`, `redeemLoginLink`, `getSessionActor`, `deleteSession` | Human login links + sessions |
| `issues.ts` | `createIssue`, `getIssue`, `updateIssue`, `claimIssue`, `parseRef`, `toView` | `updateIssue` enforces status rules per actor type |
| `search.ts` | `searchIssues(db, filters)` | project/status/assignee/label/needsInput/text (LIKE on title+description) |
| `dependencies.ts` | `addDependency`, `removeDependency` (human-only), `listDependencies`, `getOpenBlockers`, `nextTask` | `nextTask` = highest-priority unblocked issue for me/unassigned |
| `comments.ts` | `addComment`, `getActivity` | Activity = events joined w/ actor names |
| `events.ts` | `recordEvent`, `listIssueEvents`, `listRecentEvents` | `DEFAULT_RECENT_EVENTS_LIMIT=200`, `MAX=500` |
| `needs-input.ts` | `requestHumanInput` | Parks issue (`needsInput=true`); human comment clears + releases claim |
| `triage-actions.ts` | `snoozeIssue`, `markDuplicate` | |
| `stale-claims.ts` | `releaseStaleClaims(db, maxIdleSeconds=4h)` | |
| `attachments.ts` | `saveAttachment`, `getAttachment`, `ALLOWED_ATTACHMENT_TYPES`, `MAX_ATTACHMENT_SIZE` (20MB) | Files on disk, metadata row in db |
| `webhooks.ts` | `addWebhook`, `listWebhooks`, `removeWebhook`, `setWebhookActive` | |
| `webhook-dispatcher.ts` | `dispatchPending`, `startWebhookDispatcher(db, 2000ms)` | Cursor table, best-effort, HMAC `x-switchyard-signature` |
| `projects.ts` | `createProject`, `listProjects`, `getProjectByKey`, `reserveIssueNumber` | |
| `tokens.ts` | `hashToken`, `mintToken(prefix)` | |
| `errors.ts` | `class SwitchyardError extends Error` | Thrown for user-facing failures |

### Server-enforced rules (change ⇒ update matching tests)

- `triage → *` transitions: human actors only.
- `* → done`: human actors only (agents rejected in `updateIssue`).
- `removeDependency`: human-only.
- Agent `file_issue`/`POST /issues` forced to `status: triage` + provenance required.

## REST (`src/rest/api-routes.ts`, mounted at `/api`)

Auth middleware (`app.use("*")`) resolves bearer token or session cookie → `c.var.actor`; `app.onError` maps `SwitchyardError` → 400.

```
GET/POST /projects            GET /actors            GET /me
GET/POST /issues              GET/PATCH /issues/:ref
POST /issues/:ref/claim | /comments | /attachments | /request-input | /snooze | /duplicate
GET /attachments/:id/:filename
GET /next-task?project=       GET /events?since=&limit=
POST/DELETE /dependencies
GET/POST /webhooks            PATCH/DELETE /webhooks/:id
```

Request bodies validated with zod schemas in `src/rest/schemas.ts` (`@hono/zod-validator`).

## MCP (`src/mcp/server.ts`, POST `/mcp`)

Stateless per-request: new `StreamableHTTPServerTransport` + `buildMcpServer(db, actor)` per POST; bridged with `fetch-to-node`. Do NOT pre-read the request body (stream is consumed by the transport — reading twice throws).

12 tools: `list_projects`, `get_issue`, `search_issues`, `next_task`, `file_issue`, `claim_issue`, `update_issue`, `comment`, `request_human_input`, `attach_file`, `add_dependency`, `triage_queue`. All wrapped in `guard()`: `SwitchyardError` → `{isError: true}` text result; other errors propagate.

Behavioral conventions live in tool descriptions (comment before `in_review`; never self-`done` — also server-enforced).

## Tests (`tests/`, vitest)

Mirror the layers: `tests/services/`, `tests/rest/`, `tests/mcp/`, `tests/integration/` (core loop, rest loop, SPA fallback), `tests/scripts/`, `tests/db/`. Tests open temp SQLite dbs; migrations auto-apply via `openDb()`.
