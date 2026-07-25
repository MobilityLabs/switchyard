> Generated: 2026-07-24 | Token-lean format for LLM context

# Frontend (`ui/`)

React 19 SPA, built by vite (`ui/vite.config.ts`) → `dist/ui`, served by the Hono server with an SPA fallback (`src/server.ts`). Own tsconfig (`tsc -p ui`). No state library — polling + local state.

## Structure

```
ui/src/
  main.tsx            entry
  App.tsx             auth gate (getMe → login screen | ShellRouter) + internal-link click interceptor
  Shell.tsx           nav chrome: scope-carrying nav links, scope switcher, topbar search box
  router.ts           hand-rolled History-API router (no react-router), scope-first URLs (SYD-254)
  api.ts              fetch wrapper → /api, ApiError(status)
  types.ts            client-side mirrors of IssueView etc.
  usePoll.ts          usePoll(fn, deps) — 15s polling hook, powers all live data
  usePasteUpload.ts   paste-image → POST attachment
  useActorNames.ts    actorId → name resolution
  attention.ts        attention-signal helpers for issue rows
  labels.ts           label parsing/formatting
  refs.ts             projectKeyFromRef (shared by router + views)
  safeHref.ts         href sanitizing for markdown links
  Composer.tsx        shared comment/description editor
  Modal.tsx           shared modal
  PollErrorBar.tsx    "can't reach server" banner
  Markdown.tsx        marked + dompurify rendering
  DesignEmbeds.tsx    figma/embed handling in markdown
  views/
    Triage.tsx        triage inbox        /:scope/triage
    Board.tsx         per-project kanban  /:project/board (concrete key only)
    IssueDetail.tsx   issue + activity    /:project/issue/:ref
    Review.tsx        in_review queue     /:scope/review[/:ref]
    NewIssue.tsx      manual filing       /:scope/new (scope pre-selects project)
    Search.tsx        results view        /:scope/search?q= (scope = project filter)
    Agents.tsx        worker sessions     /:scope/agents (scope filters by ref)
    Approvals.tsx     pending approvals   /:scope/approvals (unresolved rows never hidden)
    settings/         Settings.tsx + per-tab files, /settings/:tab (global, unprefixed)
```

## Routes (`router.ts`) — scope-first (SYD-254)

First path segment = scope: a project key (`/SYD/...`) or reserved lowercase `all` (`/all/...`). Settings is the one unprefixed family (`/settings/:tab`).

```ts
type Route = {view:"triage"|"board"|"new-issue"|"agents"|"approvals", scope}
           | {view:"issue", scope, ref}          // scope always = projectKeyFromRef(ref)
           | {view:"review", scope, ref|null}    // /all/review/SYD-66 is expressible
           | {view:"search", scope, query}
           | {view:"settings", tab}
```

- `board` and `issue` need a concrete key (no `/all/board`); `issueRoute(ref)` is the one way to build issue routes — the ref wins any scope mismatch.
- Legacy view-first paths (`/board/SYD`, `/issue/SYD-66`, bare `/triage` …) still parse (`matchLegacy`); `useRoute` canonicalizes the address bar via `replaceState` (never a new history entry). Markdown links keep working through `isKnownPath` + the App.tsx interceptor.
- Bare `/` lands on the last concrete scope's triage (localStorage `switchyard:last-project`, written from any concrete-scope route), else `/all/triage`.
- `navigate()` pushes history + fires custom `switchyard:navigate` event so `useRoute` re-renders (popstate only covers back/forward); `redirect()` replaces.
- Legacy `#/...` hash routes are migrated to pathnames on load.
- `scopeProject(scope)` maps `"all"` → null — the shape API `project` filters take.
- Server-side: paths under `/api /auth /mcp /health /attachments` or with a file extension never fall back to the SPA shell; everything else does, so scope-first paths need no server routes.

## Shell (`Shell.tsx`)

- All nav links (Triage/Board/Review/Agents/Approvals) render under the current scope; Board falls back scope → remembered project → first project.
- Scope switcher renders on every view except settings; All option hidden on board and issue; on issue, picking a project jumps to its board; review drops the selected ref on switch.
- Review badge scoped to the current scope's project; Agents/Approvals badges are global.

## Conventions

- Auth = session cookie only; 401 from `/api/me` shows the mint-login instructions screen.
- All data fetching goes through `api.ts` + `usePoll` — no websockets, realtime is out of scope by design.
- UI tests colocated (`ui/src/*.test.{ts,tsx}`), run by the same `npm test` via jsdom.
