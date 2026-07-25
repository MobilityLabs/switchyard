# Project-scoped URLs (scope-first routing)

**Date:** 2026-07-24
**Status:** Approved (Sean, 2026-07-24 session)
**Scope:** `ui/` only — no server or API changes.

## Problem

Routes today are view-first with ad-hoc project scoping: `/board/:project`
(required), `/triage/:project?` and `/review/:project?` (optional), and
`/agents`, `/approvals`, `/search`, `/new` (unscoped). A localStorage
"last project" value (`ui/src/router.ts`, `LAST_PROJECT_STORAGE_KEY`) papers
over the inconsistency by remembering which project you were on so nav links
land somewhere sensible. With multiple projects live (SYD, HEX, …) the scope
should be in the URL on every screen: shareable, bookmarkable, and consistent.

## Decision

Flip to **scope-first URLs**: the first path segment is always the scope —
either a project key (`/SYD/...`) or the reserved word `all` (`/all/...`) for
cross-project views. Implemented in the existing hand-rolled router
(`ui/src/router.ts`); no react-router, no query-param scoping (both considered
and rejected — the hand-rolled router is deliberate and small, and query-param
scope isn't in the path).

### URL scheme

| Screen | Scoped | Global |
|---|---|---|
| Triage | `/SYD/triage` | `/all/triage` |
| Board | `/SYD/board` | — (no cross-project board, as today) |
| Issue | `/SYD/issue/SYD-66` | — (a ref pins its project) |
| Review | `/SYD/review`, `/SYD/review/SYD-66` | `/all/review`, `/all/review/SYD-66` |
| Approvals | `/SYD/approvals` | `/all/approvals` |
| Agents | `/SYD/agents` | `/all/agents` |
| Search | `/SYD/search?q=...` | `/all/search?q=...` |
| New issue | `/SYD/new` (pre-selects project) | `/all/new` (no pre-selection) |
| Settings | — | `/settings/:tab` (global, unprefixed, unchanged) |

Notes:

- The issue URL is deliberately redundant (`/SYD/issue/SYD-66`) for a fully
  uniform scope-first shape. If the ref's project disagrees with the scope
  segment (`/SYD/issue/HEX-3`), **the ref wins**: redirect to `/HEX/issue/HEX-3`.
  `/all/issue/SYD-66` likewise redirects to the ref's project.
- Review gains expressiveness the old scheme couldn't encode: `/all/review/SYD-66`
  means "all-projects review queue, currently viewing SYD-66". The old
  `/review/:x` single segment forced project-or-ref disambiguation
  (`isProjectKey` vs `isIssueRef` in `router.ts`) and couldn't say both.
- Board has no `all` scope: a kanban mixing projects' columns has no meaning
  here, matching today's required `:project`.

### Scope resolution rules

- Scope segment grammar: `all` (lowercase, reserved) or a project key matching
  the existing `PROJECT_KEY_PATTERN` (`/^[A-Z]{2,10}$/`). Lowercase view words
  (`board`, `issue`, …) can't collide with keys; `ALL` as an actual project key
  is not reserved (only lowercase `all` is), though creating one would be
  confusing and is discouraged.
- The router does **not** validate the key against the live project list —
  an unknown-but-well-formed key renders that scope with empty data, same as
  today's `/board/NOPE`. Malformed first segments fall through to the default
  route.
- Bare `/` redirects (replaceState) to the last-seen scope's triage, falling
  back to `/all/triage`. localStorage keeps exactly one job: remembering the
  last concrete project scope (for `/` landing and for the Board nav link while
  in `all` scope). The rest of the `rememberedProject` plumbing in `Shell.tsx`
  goes away.

### Legacy redirects (client-side, replaceState, no history entry)

| Old | New |
|---|---|
| `/` | last scope's triage, else `/all/triage` |
| `/triage` | `/all/triage` |
| `/triage/SYD` | `/SYD/triage` |
| `/board/SYD` | `/SYD/board` |
| `/issue/SYD-66` | `/SYD/issue/SYD-66` |
| `/review` | `/all/review` |
| `/review/SYD` | `/SYD/review` |
| `/review/SYD-66` | `/SYD/review/SYD-66` |
| `/new`, `/agents`, `/approvals`, `/search` | `/all/<same>` (carrying `?q=`) |
| `#/...` hash routes | parsed as before, then mapped through the same table |

The server-side SPA fallback (`src/server.ts`) already serves any extensionless
path outside `/api /auth /mcp /health /attachments`, so `/SYD/board` needs zero
server changes; all compatibility lives in the client router.

## Component changes

**`ui/src/router.ts`** — `Route` gains a scope field on every view (concrete
key or `"all"`; board and issue always concrete). `matchRoute` peels the first
segment as scope, then matches view segments; a legacy-shape matcher feeds the
redirect table. `href()` emits scope-first paths. `isKnownPath` accepts new
and legacy shapes (legacy anchors intercepted then redirected). `useRoute`
performs the legacy redirect + `/` landing via the existing `redirect()` helper.

**`ui/src/Shell.tsx`** — the project dropdown becomes the scope switcher:
changing it rewrites the scope segment and keeps the current view ("All
projects" not offered while on board, as today). All nav links generate under
the current scope. The Review badge scopes by `route.scope`.

**Views** — `Approvals` and `Agents` filter their lists by scope; `Search`
passes the scope as the search API's `project` param; `NewIssue` pre-selects
the scope's project. `Board`/`Triage`/`Review`/`IssueDetail` read the renamed
scope field. No service or REST changes: all needed filters already exist.

## Error handling

- Ref/scope mismatch → redirect, ref wins (above).
- Unknown well-formed project key → empty-data render, as today.
- Malformed paths → default route (last scope's triage), as today's fallback.

## Testing

- `router` tests: parse/`href` round-trips for every view × scope, legacy
  redirect table (every row), ref-vs-scope mismatch, `all` vs project-key
  grammar, bare-`/` landing with and without localStorage.
- `Shell` tests: scope switcher rewrites segment and keeps view; board hides
  "All projects"; nav links carry scope.
- View tests: approvals/agents filtering, search project param, new-issue
  pre-selection.
- `npm run verify` before done-stamp.

## Out of scope

- Cross-project board.
- Server-generated deep links (none exist today).
- Renaming or validating project keys server-side.
