# Settings section — design

**Date:** 2026-07-10
**Status:** draft, awaiting approval
**Owner:** Sean (design session with Claude)

## Context

Every administrative operation today goes through the host CLI (`npx tsx src/cli.ts <db> add-project|add-actor|mint-login|add-webhook ...`) or hand-edited files (`switchyard-worker.json`, hardcoded service constants). The web UI has no admin surface at all. This design adds a **Settings** section to the web UI covering four areas:

1. **Projects** — create and edit projects.
2. **Bot identities** — see actors, generate agent identities and tokens, rotate/revoke.
3. **Integrations** — manage outbound webhooks and GitHub repo links.
4. **Config** — instance settings and behavior knobs, stored in the DB instead of env vars / hardcoded constants, including dispatch policy served to workers.

Decided during brainstorming:
- **Config scope:** behavior knobs + instance identity + dispatch policy (all three).
- **Authorization:** any human actor may use Settings; agents are blocked server-side. No admin flag.

## Goals

- All four areas manageable from the web UI without shelling into the host.
- Per the architecture rule, every capability lands in `src/services/*` first; REST and UI are thin adapters. The CLI remains as a break-glass path that calls the same services.
- Config values move from hardcoded constants to a DB-backed, typed settings registry with sane defaults — a fresh DB behaves exactly like today with zero rows in the table.

## Non-goals

- No admin role/permission tiers (revisit if non-admin humans ever join a board).
- No MCP exposure of any Settings mutation — these are human-governance operations, consistent with the tool-surface audit (SYD-149/150/151 cover the agent-side gaps).
- No secrets management UI for `.env` (GitHub PATs, session signing, DB path stay in env — they are host secrets, not board config).
- No project deletion or archiving (issues reference projects; out of scope until there's a need).
- No editing of a project's key (issue refs embed it; immutable).

## Data model

### New table: `settings`

```ts
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),            // e.g. "sessions.stale_seconds"
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: integer("updated_at").notNull().default(now()),
  updatedByActorId: integer("updated_by_actor_id").references(() => actors.id),
});
```

Rows exist only for values that differ from the compiled-in default. "Reset to default" deletes the row. `updatedByActorId` gives provenance without inventing a new audit stream (settings are not issue history, so the `events` table is not the right home — same reasoning as `agent_sessions`).

### Existing tables

No changes to `actors` or `projects`. Token rotation reuses `actors.tokenHash`; project rename updates `projects.name`.

## Settings registry (`src/services/settings.ts`)

A compile-time registry is the single source of truth for what settings exist. Nothing reads the settings table directly.

```ts
const REGISTRY = {
  "instance.base_url":            { type: "string",   default: "http://localhost:3300",
                                    description: "Base URL used in login links and outbound payloads" },
  "instance.name":                { type: "string",   default: "Switchyard" },
  "sessions.stale_seconds":       { type: "number",   default: 12 * 3600 },   // agent-sessions.ts:20
  "claims.stale_seconds":         { type: "number",   default: 4 * 3600 },    // stale-claims.ts releaseStaleClaims
  "auth.login_link_ttl_seconds":  { type: "number",   default: 15 * 60 },     // auth.ts LOGIN_TTL
  "webhooks.suppressed_events":   { type: "string[]", default: ["progress_note"] }, // webhook-dispatcher.ts
  "dispatch.max_concurrent":      { type: "number",   default: 1 },
  "dispatch.max_answer_concurrent": { type: "number", default: 2 },
  "dispatch.poll_seconds":        { type: "number",   default: 300 },
  "dispatch.event_poll_seconds":  { type: "number",   default: 15 },
} as const;
```

API: `getSetting(db, key)` (typed, falls back to default), `getAllSettings(db)` (registry merged with overrides, with `isDefault` per key), `setSetting(db, actor, key, value)` (validates type + range, **rejects agent actors**), `resetSetting(db, actor, key)`.

Values are read at point of use (SQLite reads are cheap; no cache invalidation problem). Existing constants (`AGENT_SESSION_STALE_SECONDS`, `releaseStaleClaims` default, `LOGIN_TTL`, `SUPPRESSED_WEBHOOK_EVENT_TYPES`) become `getSetting` calls; the exported constants remain as the registry defaults so tests keep a stable anchor.

## Service layer changes

All mutations below throw `SwitchyardError` when `actor.type !== "human"` — server-enforced, not prompt-enforced.

| Area | Function | Notes |
|---|---|---|
| Projects | `updateProject(db, actor, key, { name })` | new; rename only |
| Projects | `createProject` | exists; add human-only guard (currently unguarded REST) |
| Actors | `listActorsWithStatus(db)` | new: name, type, createdAt, `hasToken` (no last-used tracking — nothing records token use today) |
| Actors | `createActor` | exists (CLI); expose via REST, human-only, returns token once |
| Actors | `rotateActorToken(db, actor, actorId)` | new: mints + stores hash, returns plaintext once |
| Actors | `revokeActorToken(db, actor, actorId)` | new: nulls `tokenHash`; refuse revoking your own login-bound actor |
| Actors | `createLoginLink` | exists (CLI `mint-login`); expose via REST for human actors |
| Integrations | webhooks + github-repos CRUD | services exist; UI only. Secrets stay redacted (`hasSecret`) |
| Config | settings service | new, as above |

Token handling follows the existing invariant: plaintext appears exactly once in the creating/rotating response, never in lists, never logged, never in argv.

## REST surface (all under existing auth middleware)

```
PATCH  /api/projects/:key                { name }
GET    /api/actors                       → extended with hasToken (replaces bare list)
POST   /api/actors                       { name, type } → { actor, token }   // token shown once
POST   /api/actors/:id/rotate-token      → { token }                          // shown once
DELETE /api/actors/:id/token
POST   /api/actors/:id/login-link        → { url }        // humans only as target
GET    /api/settings                     → registry merged view (key, value, default, isDefault, description)
PUT    /api/settings/:key                { value }
DELETE /api/settings/:key                // reset to default
GET    /api/dispatch-policy              → the dispatch.* group only (worker-facing, agent tokens allowed)
```

Everything except `GET /api/dispatch-policy` rejects agent actors at the service layer. `POST /api/projects` gains the same human-only guard.

## Dispatch policy delivery to workers

`switchyard-worker.json` splits conceptually into **host concerns** (url, token env, image, containerized, roles, paths) which stay in the file, and **policy knobs** (concurrency, poll intervals) which move to `dispatch.*` settings.

The worker fetches `GET /api/dispatch-policy` at startup and on each poll tick; fetched values override the local file's policy fields when present. On fetch failure it keeps the last-known values (file values on first run). This keeps old workers working (file still honored) while letting the Settings UI retune a live worker within one poll interval — no launchd restart.

## Web UI

New route `/settings` (added to `router.ts`, `App.tsx`, and the Shell nav — visible only when the logged-in actor is human). One view component per tab, following the existing view conventions (`usePoll`, `PollErrorBar`, plain forms):

- **Projects** — table of projects (key, name, next issue #, created); inline rename; "New project" form (key + name, key validated `^[A-Z][A-Z0-9]{1,9}$` to match ref parsing).
- **Bot identities** — table of actors (name, type badge, created, token status); "New agent" form; per-row rotate/revoke with confirm; rotate/create shows the token once in a copy-to-clipboard callout that is never re-fetchable; "Mint login link" on human rows.
- **Integrations** — two panels: webhooks (url, project scope, signed?, active toggle, delete; add form) and GitHub repos (owner/repo, project, delete; add form). Existing redaction preserved: secrets write-only.
- **Config** — form generated from `GET /api/settings`: grouped by prefix (Instance / Sessions & claims / Webhooks / Dispatch), each field showing description, current value, and a "default" marker with reset. Numbers validated client- and server-side.

## Error handling

Service-layer `SwitchyardError` → REST 4xx with the message (existing pattern); the UI surfaces it inline next to the offending form. Agent-token requests to Settings endpoints get an explicit "Settings are human-only" error rather than a generic 403.

## Testing

- **Services:** settings registry (defaults, override, reset, type validation, agent rejection), token rotate/revoke (hash actually changes; old token stops authenticating), project rename, human-only guards on every mutation — these join the "server-enforced rules" test suite named in CLAUDE.md.
- **Behavior knobs actually bite:** e.g. set `sessions.stale_seconds` low → `listAgentSessions(active)` filters accordingly; set `webhooks.suppressed_events` to `[]` → progress notes fan out again.
- **REST:** auth-matrix tests (human ok, agent rejected, dispatch-policy readable by agents).
- **UI:** vitest/jsdom per tab following existing view tests (render, mutate, error surface, token-shown-once flow).

## Rollout (board-driven decomposition)

Filed as one parent issue + five children, buildable in order, each independently shippable:

1. **SYD-a: settings service + table + migration** (registry, typed accessors, human-only writes) — no consumers yet.
2. **SYD-b: wire existing knobs through settings** (sessions/claims/auth/webhook constants) + dispatch-policy endpoint + worker fetch.
3. **SYD-c: actors service extensions + REST** (list-with-status, create, rotate, revoke, login-link).
4. **SYD-d: projects rename + human-only guards + REST.**
5. **SYD-e: `/settings` UI** (all four tabs; can land tab-by-tab if reviews get large).

## Open questions (non-blocking)

- Should `instance.base_url` also replace `SWITCHYARD_URL` in the CLI's mint-login output? (Proposed: yes, CLI reads the setting with env as fallback.)
- Does the Agents nav need hiding for agent-token UI sessions, or is human-only nav gating for `/settings` sufficient? (Proposed: sufficient — agents don't log into the UI today.)
