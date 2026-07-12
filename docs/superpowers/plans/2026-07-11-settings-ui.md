# /settings UI (SYD-158) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/settings` route with Projects / Bot identities / Integrations / Config tabs per spec §Web UI (docs/superpowers/specs/2026-07-10-settings-section-design.md), plus the missing SYD-157 backend (project rename + human-only guards) that drifted out of main.

**Architecture:** One view component per tab under `ui/src/views/settings/`, composed by a `Settings.tsx` shell with tab nav; route `/settings/:tab?` (default `projects`). Existing conventions throughout: `usePoll` + `PollErrorBar` for reads, `api()` helpers for mutations, inline `ApiError.message` next to the offending form. Nav link visible only when `me.type === "human"`.

**Tech Stack:** React + vite (ui tsconfig), vitest/jsdom view tests. No new dependencies.

## Global Constraints

- Backend-first for the SYD-157 gap: `updateProject(db, actor, key, {name})` (rename only, human-only), human-only guard on `createProject` (breaking: adds actor param — update callers `src/cli.ts`, `src/services/linear-import.ts` executeImportPlan, and tests), `PATCH /api/projects/:key` + `projectUpdateBody`. Semantics per the stranded `agent/SYD-157` commit f2ad31a, reimplemented TDD on current main. Note on SYD-157 + PR about the drift.
- Token plaintext appears exactly once (create/rotate responses) in a copy-to-clipboard callout; never re-fetchable; absent after refetch/re-render.
- New-project key validated client-side `^[A-Z][A-Z0-9]{1,9}$`… **spec conflict:** server enforces `^[A-Z]{2,10}$` — use the SERVER's regex client-side (spec's variant would accept keys the server rejects).
- Config number fields validate client-side (integer, min 0) mirroring setSetting; reset = DELETE.
- Secrets write-only: webhooks/repos show `hasSecret`-style booleans only.
- Gates per task commit: `npm run typecheck && npm test`; `npm run build:ui` before the PR.

## Tasks

### 1. Backend: project rename + human-only guards (SYD-157 gap)
Files: `src/services/projects.ts`, `src/rest/api-routes.ts`, `src/rest/schemas.ts`, callers (`src/cli.ts`, `src/services/linear-import.ts`), tests (`tests/services/projects*.test.ts` or new, `tests/rest/api-projects.test.ts` if exists else in api-issues-adjacent file).
- [ ] RED: updateProject renames (human), rejects agents, 404s unknown key, key immutable; createProject rejects agents; PATCH route wired (agent → 400, human → renamed row). RED first, then implement + fix callers. Commit.

### 2. Route + Shell nav + Settings shell
Files: `ui/src/router.ts`(+test), `ui/src/App.tsx`(+test), `ui/src/Shell.tsx`(+test), `ui/src/views/settings/Settings.tsx`(+test), `ui/src/api.ts`, `ui/src/types.ts`.
- [ ] Route `{view:"settings", tab: "projects"|"actors"|"integrations"|"config"}` from `/settings[/:tab]`; href back-mapping; unknown tab → null (404 fallback).
- [ ] Shell nav "Settings" link only when `me.type === "human"`; App renders Settings view. Tab bar links between tabs. Commit.

### 3. Projects tab
Files: `ui/src/views/settings/ProjectsTab.tsx` + test; api.ts `updateProject`.
- [ ] Table (key, name, next issue #, created date), inline rename (edit → save/cancel, PATCH, reload), new-project form (key uppercase-validated pre-submit, POST, reload), server error inline. jsdom tests: render from poll, rename fires PATCH, create fires POST, invalid key blocked client-side, ApiError surfaces. Commit.

### 4. Bot identities tab
Files: `ui/src/views/settings/ActorsTab.tsx` + test; api.ts `createActor/rotateToken/revokeToken/mintLoginLink`; types `ActorWithStatus`.
- [ ] Table (name, type badge, created, token status), new-agent form → token-once callout (copy button), rotate (confirm → token-once callout), revoke (confirm → DELETE), mint login link on human rows → URL callout. Tests: token visible after mint, absent after reload; rotate/revoke fire right requests; confirm gating. Commit.

### 5. Integrations tab
Files: `ui/src/views/settings/IntegrationsTab.tsx` + test; api.ts webhook + github-repo helpers (verify route shapes in api-routes.ts first).
- [ ] Webhooks panel: url, project scope, signed?, active toggle (PATCH), delete, add form. Repos panel: fullName, project, secret?, delete, add form. Tests per pattern. Commit.

### 6. Config tab
Files: `ui/src/views/settings/ConfigTab.tsx` + test; api.ts `listSettings/putSetting/resetSetting`; types `SettingView`.
- [ ] Groups by key prefix → Instance / Sessions & claims / Auth / Webhooks / Dispatch (prefix→label map; unknown prefix falls back to prefix itself). Per key: description, editor by type (string/number/string[] as comma-list), "default" badge, Save (PUT) + Reset (DELETE) when overridden. Client number validation. Tests: render groups, save fires PUT with typed value, reset fires DELETE, invalid number blocked, error inline. Commit.

### 7. Gates + acceptance + ship
- [ ] `npm run typecheck && npm test && npm run build:ui`; live smoke: serve a scratch db, log in? (session cookie needed — use mint-login link flow) or rely on jsdom + typecheck; PR; SYD-158 comment + in_review; note SYD-157 drift on SYD-157.
