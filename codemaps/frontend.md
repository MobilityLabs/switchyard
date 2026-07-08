> Generated: 2026-07-08 | Token-lean format for LLM context

# Frontend (`ui/`)

React 19 SPA, built by vite (`ui/vite.config.ts`) → `dist/ui`, served by the Hono server with an SPA fallback (`src/server.ts`). Own tsconfig (`tsc -p ui`). No state library — polling + local state.

## Structure

```
ui/src/
  main.tsx            entry
  App.tsx             auth gate (getMe → login screen | ShellRouter) + internal-link click interceptor
  Shell.tsx           nav chrome (projects list, view switcher)
  router.ts           hand-rolled History-API router (no react-router)
  api.ts              fetch wrapper → /api, ApiError(status)
  types.ts            client-side mirrors of IssueView etc.
  usePoll.ts          usePoll(fn, deps) — 15s polling hook, powers all live data
  usePasteUpload.ts   paste-image → POST attachment
  PollErrorBar.tsx    "can't reach server" banner
  Markdown.tsx        marked + dompurify rendering
  DesignEmbeds.tsx    figma/embed handling in markdown
  views/
    Triage.tsx        triage inbox (default view, "/")
    Board.tsx         per-project kanban, drag-to-move ("/board/:project")
    IssueDetail.tsx   issue + activity + comments ("/issue/:ref")
    Review.tsx        in_review queue ("/review")
    NewIssue.tsx      manual filing ("/new")
```

## Routes (`router.ts`)

```ts
type Route = {view:"triage"} | {view:"board", project} | {view:"issue", ref}
           | {view:"review"} | {view:"new-issue"}
```

- `navigate()` pushes history + fires custom `switchyard:navigate` event so `useRoute` re-renders (popstate only covers back/forward).
- Legacy `#/...` hash routes are migrated to pathnames on load.
- `App.tsx` installs a capture-phase click interceptor: same-origin anchors matching `isKnownPath` are routed client-side; external/`target`/download/modified clicks pass through.
- Server-side: paths under `/api /auth /mcp /health /attachments` or with a file extension never fall back to the SPA shell.

## Conventions

- Auth = session cookie only; 401 from `/api/me` shows the mint-login instructions screen.
- All data fetching goes through `api.ts` + `usePoll` — no websockets, realtime is out of scope by design.
- UI tests colocated (`ui/src/*.test.{ts,tsx}`), run by the same `npm test` via jsdom.
