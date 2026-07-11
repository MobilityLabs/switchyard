# Multi-tenant / multi-team project scoping — Design

**Date:** 2026-07-11
**Status:** Draft for review
**Author:** Claude (SYD-138), direction from Sean
**Related:** SYD-138, `docs/superpowers/specs/2026-07-07-switchyard-design.md`

## Problem

The v1 design doc states two v1 non-goals directly on point: "Roles/permissions — everyone in the workspace sees everything" and "Multi-tenancy, orgs, billing" (`docs/superpowers/specs/2026-07-07-switchyard-design.md:24,26`), and calls out "single-tenant now" as a product discipline choice (`:90`).

That assumption is now baked into the code, not just the doc:

- `actors` has no project association at all (`src/db/schema.ts:14-20`).
- `projects` has no owner/team field (`src/db/schema.ts:22-28`).
- `authenticate()` resolves a token to an actor with a flat, global lookup (`src/services/actors.ts:35-38`) — no project dimension exists to filter on.
- `searchIssues` takes `projectKey` as an **optional** filter (`src/services/search.ts:23-25`); omitted, it searches every project.
- `getIssue(db, ref)` resolves the project embedded in the ref and fetches the issue with no check that the caller has any relationship to that project (`src/services/issues.ts:55-69`).
- `list_projects` returns every project to any authenticated actor (`src/mcp/server.ts:45-49`).
- The only authorization axis anywhere in the service layer is actor **type** (`human` vs `agent`) — e.g. `src/services/webhooks.ts:10-15`, `src/services/issues.ts:91,97,120,197,202,207,234,279`. There is no `actor.projectIds.includes(...)` equivalent.

SYD-138 asked whether this is a conscious single-tenant decision or an oversight. Sean's answer: spec out the multi-tenant/multi-team approach rather than closing it out. This document is that spec — it does not implement anything. If approved, the work below should be filed as its own implementation issue(s); this issue (SYD-138) closes out once the spec is reviewed.

## Goals

- An actor (human or agent) can only see and act on projects they're a member of.
- No change to the intra-project model: statuses, triage gate, agent-vs-human rules, provenance all stay exactly as they are today.
- Reuse the "global scope" pattern that already exists in the schema (see below) rather than inventing a new one.
- Migration must not silently lock existing installs out of their own data.

## Non-goals

- Per-project **roles** (e.g. viewer/editor/admin within a project). Sean's ask was tenancy isolation, not a permissions matrix — the existing "everyone sees everything within a project" model stays. Membership is binary: in or out.
- Billing/org-level constructs. Nothing in this proposal requires a `tenants` or `orgs` table — "team" in the issue title maps to "a set of projects an actor can see," not a new top-level entity. If Switchyard later needs multiple *humans-teams* fully unaware of each other's projects (not just scoped access), that's a bigger change (separate DB or schema-per-tenant) and out of scope here.
- Changing the human/agent authorization axis. Membership is an *additional* filter, applied after the existing `actor.type` checks, not a replacement for them.

## Proposed data model

Add one join table:

```ts
export const projectMembers = sqliteTable("project_members", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  actorId: integer("actor_id").notNull().references(() => actors.id),
  projectId: integer("project_id").references(() => projects.id), // nullable — see below
  createdAt: integer("created_at").notNull(),
});
```

`projectId` is nullable, mirroring the pattern `webhooks.projectId` and `githubRepos.projectId` already use for "applies to all projects" (`src/db/schema.ts:100,114`). A membership row with `projectId = null` grants the actor access to every project, present and future — this is the "workspace admin" case, not a per-project row you'd need to create N times. Unique constraint on `(actorId, projectId)` (treating null as a distinct value, which SQLite does).

No change to `actors` or `projects` tables themselves.

## Enforcement

Add one service function, `src/services/project-members.ts`:

```ts
export function actorProjectIds(db, actorId): "all" | Set<number>
export function canAccessProject(db, actorId, projectId): boolean
```

`actorProjectIds` returns the literal string `"all"` if a `projectId = null` row exists for the actor (short-circuits further filtering), otherwise the explicit set.

This gets called at every point identified in the survey above, plus their siblings:

- `searchIssues` (`src/services/search.ts:23`) — intersect the query with `actorProjectIds`, not just the optional `filters.projectKey`. Today `projectKey` narrows; after this change, actor scope narrows unconditionally and `projectKey` narrows further within that.
- `getIssue`, `createIssue`, and the rest of `src/services/issues.ts` — resolve the project from the ref/projectId first, then `canAccessProject` before touching the row. Same shape as the existing `requireHuman`-style guards already in that file (`:91,97,120,197,202,207,234,279`), so it composes with them rather than replacing them.
- `list_projects` (`src/mcp/server.ts:45-49`) and `GET /api/projects` (`src/rest/api-routes.ts:101`) — filter the returned list instead of gating (there's nothing to deny, just less to return).
- `src/services/webhooks.ts`, `github-repos.ts`, `dependencies.ts` — add `canAccessProject` alongside the existing `actor.type === "human"` checks.
- `next_task` (`src/rest/api-routes.ts:288`, MCP equivalent) — when no project is specified, search within `actorProjectIds` instead of everywhere.
- `webhook-dispatcher.ts` is *not* in scope — outbound webhook delivery is already scoped by `webhooks.projectId` independent of any actor, and dispatch has no actor in the loop.

One deliberate simplification: resolve `actorProjectIds` once per request/session (REST middleware, MCP session setup) and pass it down, the same place `actor` is already resolved (`src/rest/api-routes.ts:77-89`, `src/server.ts:41-53`). Membership changes take effect on the actor's next request/session, same latency as a token revocation today — no new caching or invalidation logic needed.

## Migration path

Because every existing actor currently has implicit access to every project, a naive migration (empty `project_members` table) would lock every current install out of its own data on upgrade. The migration backfills one `projectId = null` row per existing actor, preserving today's behavior exactly. Isolation is opt-in going forward: new actors get no default access, and an admin explicitly narrows an existing actor's access by deleting their `all` row and adding scoped rows.

## CLI / admin surface

`src/cli.ts` needs two new subcommands (mirroring the existing `add-actor`/`add-project` shape at `cli.ts:29-45`):

- `grant-project-access <actor-name> <project-key|--all>`
- `revoke-project-access <actor-name> <project-key|--all>`

No change to `add-actor`, `add-project`, or `mint-login` — membership is granted as a separate step, consistent with how `add-webhook`/`add-github-repo` already take an optional, separate project scope (`cli.ts:56-83`).

## Web UI

The project switcher and board currently assume "all projects" are listable. Once `list_projects` filters server-side, the UI needs no new logic — it already renders whatever the API returns. Worth a follow-up check that there's no client-side "all projects" cache that bypasses the filtered list.

## Testing (for the implementation issue)

- Service-layer: an actor with no membership row gets an empty `searchIssues` result and a not-found/denied error from `getIssue` on another project's ref, against real SQLite per the project's existing test convention.
- An actor with a `projectId = null` row retains full current behavior (regression coverage for the migration backfill).
- MCP and REST: one test per surface confirming a cross-project `get_issue`/`GET /api/issues/:ref` is denied for a scoped actor.

## Open questions for Sean

1. Should newly-created agent actors default to scoped-to-one-project (matching how agent tokens are typically minted per repo/worker today) while newly-created human actors default to `all` (today's behavior, least surprise for the existing small-team usage)? This spec doesn't assume a default either way.
2. Is binary membership (in/out) sufficient, or is there a near-term need for a lighter "read-only" tier — e.g. a client who should see their project's board but not comment? Non-goals above assume no, but flagging since it changes the schema (would need a `role` column now rather than bolted on later).
3. Confirm no near-term need for tenant-level isolation stronger than access scoping (e.g. two client orgs who must not even see each other's *project names* in a shared `list_projects` call) — the "all" sentinel and filtered listing above are correct for "everyone trusted, scoped visibility," not for mutually-distrusting tenants sharing one instance.

## Suggested follow-up issues (once this spec is approved)

1. Schema + migration: `project_members` table, backfill, `actorProjectIds`/`canAccessProject` in a new `src/services/project-members.ts`.
2. Wire enforcement into `search.ts`, `issues.ts`, `mcp/server.ts`, `rest/api-routes.ts`, `webhooks.ts`, `github-repos.ts`, `dependencies.ts`, `next_task`.
3. CLI: `grant-project-access` / `revoke-project-access`.
4. UI follow-up check (project switcher / any client-side "all projects" assumption).
