# Project-Scoped URLs Implementation Plan (SYD-254)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flip UI routes from view-first (`/board/SYD`, unscoped `/agents`) to scope-first (`/SYD/board`, `/all/triage`, `/SYD/issue/SYD-66`) so project scope is in the URL on every screen.

**Architecture:** Rewrite the hand-rolled History-API router (`ui/src/router.ts`): every `Route` variant except `settings` gains a `scope` field (a project key or the reserved lowercase `"all"`); `matchRoute` peels the first segment as scope; legacy view-first paths parse to the same `Route` shapes and `useRoute` canonicalizes the address bar via `replaceState`. `Shell.tsx`'s project dropdown becomes the scope switcher; views gain scope props from `ShellRouter`.

**Tech Stack:** React 19, hand-rolled router (no react-router), vitest + jsdom, TypeScript.

**Spec:** `docs/superpowers/specs/2026-07-24-project-scoped-urls-design.md` — the URL table, scope-resolution rules, and legacy-redirect table there are normative.

## Global Constraints

- Scope grammar: `all` (lowercase, reserved) or `PROJECT_KEY_PATTERN` = `/^[A-Z]{2,10}$/`. Board and issue routes always carry a concrete key, never `all`.
- On ref/scope mismatch (`/SYD/issue/HEX-3`) the ref wins.
- All redirects (legacy shapes, bare `/`, mismatches) use `replaceState` — never a new history entry.
- Settings stays global and unprefixed (`/settings/:tab`).
- No server/service/REST changes. `ui/` only.
- Every commit must pass `npm run typecheck && npm run build:ui && npx vitest run` in-transcript first (subagent commit gate). `npm run verify` before in_review.
- Node 24 (Node 25 breaks jsdom tests).

---

### Task 1: Router rewrite + consumer adaptation (one compile unit)

The `Route` type change breaks `App.tsx`, `Shell.tsx`, and views at typecheck, so this task lands the router and minimal consumer adaptation together. Behavioral view changes (filtering, pre-selection) are Task 2.

**Files:**
- Modify: `ui/src/router.ts` (full rewrite of route table; keep `navigate`/`redirect`/event plumbing)
- Modify: `ui/src/router.test.tsx` (rewrite route-shape tests; keep test harness/`Probe` pattern)
- Modify: `ui/src/App.tsx:99-115` (ShellRouter props)
- Modify: `ui/src/Shell.tsx` (scope derivation, nav links, scope switcher)
- Modify: `ui/src/views/Agents.tsx`, `Approvals.tsx`, `Search.tsx`, `NewIssue.tsx` (accept new props, minimal compile-only wiring)
- Modify: any test files that construct old-shape routes/paths (grep `view: "` and `parsePath(` under `ui/src`)

**Interfaces (produced, relied on by Tasks 2–3):**
```ts
export const ALL_SCOPE = "all";
export type Route =
  | { view: "triage"; scope: string }
  | { view: "board"; scope: string }              // concrete key only
  | { view: "issue"; scope: string; ref: string } // scope === projectKeyFromRef(ref) always
  | { view: "review"; scope: string; ref: string | null }
  | { view: "new-issue"; scope: string }
  | { view: "search"; scope: string; query: string }
  | { view: "agents"; scope: string }
  | { view: "approvals"; scope: string }
  | { view: "settings"; tab: SettingsTab };
export function scopeProject(scope: string): string | null; // "all" -> null, else the key
export function issueRoute(ref: string): Route; // { view:"issue", scope: projectKeyFromRef(ref), ref }
```
View props (wired here, implemented in Task 2): `Agents({ project: string | null })`, `Approvals({ project: string | null })`, `Search({ query: string; project: string | null })`, `NewIssue({ defaultProject: string | null })`.

- [ ] **Step 1: Rewrite `ui/src/router.test.tsx` route-shape tests (failing first)**

Replace the shape assertions; keep the SYD-55 memory + navigate/redirect history-semantics describe blocks, updated to new shapes. New coverage (all as `parsePath`/`href`/`isKnownPath` assertions):

```tsx
describe("scope-first routes", () => {
  it("parses every scoped view", () => {
    expect(parsePath("/SYD/triage")).toEqual({ view: "triage", scope: "SYD" });
    expect(parsePath("/all/triage")).toEqual({ view: "triage", scope: "all" });
    expect(parsePath("/SYD/board")).toEqual({ view: "board", scope: "SYD" });
    expect(parsePath("/SYD/issue/SYD-66")).toEqual({ view: "issue", scope: "SYD", ref: "SYD-66" });
    expect(parsePath("/SYD/review")).toEqual({ view: "review", scope: "SYD", ref: null });
    expect(parsePath("/all/review/SYD-66")).toEqual({ view: "review", scope: "all", ref: "SYD-66" });
    expect(parsePath("/SYD/new")).toEqual({ view: "new-issue", scope: "SYD" });
    expect(parsePath("/SYD/search", "?q=auth%20bug")).toEqual({ view: "search", scope: "SYD", query: "auth bug" });
    expect(parsePath("/all/agents")).toEqual({ view: "agents", scope: "all" });
    expect(parsePath("/all/approvals")).toEqual({ view: "approvals", scope: "all" });
  });
  it("round-trips href for every scoped view", () => {
    expect(href({ view: "board", scope: "SYD" })).toBe("/SYD/board");
    expect(href({ view: "issue", scope: "SYD", ref: "SYD-66" })).toBe("/SYD/issue/SYD-66");
    expect(href({ view: "triage", scope: "all" })).toBe("/all/triage");
    expect(href({ view: "review", scope: "all", ref: "SYD-66" })).toBe("/all/review/SYD-66");
    expect(href({ view: "search", scope: "SYD", query: "auth bug" })).toBe("/SYD/search?q=auth%20bug");
    expect(href({ view: "new-issue", scope: "all" })).toBe("/all/new");
  });
  it("rejects /all/board and /all/issue as scoped matches (board/issue need a concrete key)", () => {
    expect(isKnownPath("/all/board")).toBe(false);
    // /all/issue/SYD-66 IS known — the ref supplies the concrete scope:
    expect(parsePath("/all/issue/SYD-66")).toEqual({ view: "issue", scope: "SYD", ref: "SYD-66" });
  });
  it("the ref wins a ref-vs-scope mismatch", () => {
    expect(parsePath("/SYD/issue/HEX-3")).toEqual({ view: "issue", scope: "HEX", ref: "HEX-3" });
  });
  it("rejects malformed scope segments", () => {
    expect(isKnownPath("/syd/board")).toBe(false);
    expect(isKnownPath("/TOOLONGPROJECTKEY/board")).toBe(false);
  });
});

describe("legacy redirects (parse old shape -> new Route)", () => {
  it("maps every legacy row from the spec table", () => {
    expect(parsePath("/triage")).toEqual({ view: "triage", scope: "all" });
    expect(parsePath("/triage/SYD")).toEqual({ view: "triage", scope: "SYD" });
    expect(parsePath("/board/SYD")).toEqual({ view: "board", scope: "SYD" });
    expect(parsePath("/issue/SYD-66")).toEqual({ view: "issue", scope: "SYD", ref: "SYD-66" });
    expect(parsePath("/review")).toEqual({ view: "review", scope: "all", ref: null });
    expect(parsePath("/review/SYD")).toEqual({ view: "review", scope: "SYD", ref: null });
    expect(parsePath("/review/SYD-66")).toEqual({ view: "review", scope: "SYD", ref: "SYD-66" });
    expect(parsePath("/new")).toEqual({ view: "new-issue", scope: "all" });
    expect(parsePath("/agents")).toEqual({ view: "agents", scope: "all" });
    expect(parsePath("/approvals")).toEqual({ view: "approvals", scope: "all" });
    expect(parsePath("/search", "?q=x")).toEqual({ view: "search", scope: "all", query: "x" });
  });
  it("legacy paths are known paths (anchor interceptor must catch markdown links)", () => {
    expect(isKnownPath("/issue/SYD-66")).toBe(true);
    expect(isKnownPath("/board/SYD")).toBe(true);
  });
  it("bare / lands on the last concrete scope's triage, else /all", () => {
    localStorage.clear();
    expect(parsePath("/")).toEqual({ view: "triage", scope: "all" });
    localStorage.setItem("switchyard:last-project", "SYD");
    expect(parsePath("/")).toEqual({ view: "triage", scope: "SYD" });
  });
});

describe("useRoute canonicalization", () => {
  // mountRoute() harness as in the existing file
  it("replaces a legacy URL with its canonical scope-first form, no history entry", async () => {
    history.replaceState(null, "", "/issue/SYD-66");
    await mountRoute();
    expect(location.pathname).toBe("/SYD/issue/SYD-66");
  });
  it("rewrites a mismatched issue scope to the ref's project", async () => {
    history.replaceState(null, "", "/SYD/issue/HEX-3");
    await mountRoute();
    expect(location.pathname).toBe("/HEX/issue/HEX-3");
  });
  it("remembers the last concrete scope from any scoped view, not just board", async () => {
    localStorage.clear();
    history.replaceState(null, "", "/HEX/agents");
    await mountRoute();
    expect(getLastProject()).toBe("HEX");
  });
  it("does not overwrite the memory from an all-scope view", async () => {
    localStorage.setItem("switchyard:last-project", "SYD");
    history.replaceState(null, "", "/all/triage");
    await mountRoute();
    expect(getLastProject()).toBe("SYD");
  });
});

describe("settings route (unchanged, unprefixed)", () => {
  it("parses /settings and tabs exactly as before", () => {
    expect(parsePath("/settings")).toEqual({ view: "settings", tab: "projects" });
    expect(parsePath("/settings/config")).toEqual({ view: "settings", tab: "config" });
    expect(isKnownPath("/settings/bogus")).toBe(false);
  });
});
```

Also update the retained SYD-55 / history-semantics blocks to new shapes (`navigate({ view: "board", scope: "SYD" })` etc.), and the search round-trip block to include `scope`.

- [ ] **Step 2: Run the router tests, confirm they fail on the old router**

Run: `npx vitest run ui/src/router.test.tsx`
Expected: FAIL (old shapes returned / unknown fields).

- [ ] **Step 3: Rewrite `ui/src/router.ts`**

Keep: `SETTINGS_TABS`, `isProjectKey`, `isIssueRef`, `NAVIGATE_EVENT`, `LAST_PROJECT_STORAGE_KEY`, `getLastProject`/`setLastProject`, `navigate`, `redirect`, `migrateHashRoute`. Replace the `Route` type with the Interfaces block above, and replace `matchRoute`/`href`/`useRoute`:

```ts
export const ALL_SCOPE = "all";

export function scopeProject(scope: string): string | null {
  return scope === ALL_SCOPE ? null : scope;
}

export function issueRoute(ref: string): Route {
  return { view: "issue", scope: projectKeyFromRef(ref), ref };
}

function isScopeSegment(value: string): boolean {
  return value === ALL_SCOPE || isProjectKey(value);
}

function defaultRoute(): Route {
  return { view: "triage", scope: getLastProject() ?? ALL_SCOPE };
}

// Scope-first shapes: /:scope/<view>[/:arg]
function matchScoped(parts: string[], search: string): Route | null {
  const [scope, view, arg] = parts;
  if (!scope || !isScopeSegment(scope)) return null;
  if (view === "triage" && parts.length === 2) return { view: "triage", scope };
  if (view === "board" && parts.length === 2 && scope !== ALL_SCOPE)
    return { view: "board", scope };
  // The ref names its own project; a disagreeing scope segment (or "all")
  // is corrected here and canonicalized by useRoute — the ref wins.
  if (view === "issue" && parts.length === 3 && isIssueRef(arg)) return issueRoute(arg);
  if (view === "review") {
    if (parts.length === 2) return { view: "review", scope, ref: null };
    if (parts.length === 3 && isIssueRef(arg)) return { view: "review", scope, ref: arg };
    return null;
  }
  if (view === "new" && parts.length === 2) return { view: "new-issue", scope };
  if (view === "search" && parts.length === 2)
    return { view: "search", scope, query: new URLSearchParams(search).get("q") ?? "" };
  if (view === "agents" && parts.length === 2) return { view: "agents", scope };
  if (view === "approvals" && parts.length === 2) return { view: "approvals", scope };
  return null;
}

// Pre-scope-first shapes (old bookmarks, refs in markdown comments). Parsed
// to the same Route values; useRoute rewrites the address bar to canonical.
function matchLegacy(parts: string[], search: string): Route | null {
  const [head, arg] = parts;
  if (head === "board" && parts.length === 2 && isProjectKey(arg))
    return { view: "board", scope: arg };
  if (head === "issue" && parts.length === 2 && isIssueRef(arg)) return issueRoute(arg);
  if (head === "triage") {
    if (parts.length === 1) return { view: "triage", scope: ALL_SCOPE };
    if (parts.length === 2 && isProjectKey(arg)) return { view: "triage", scope: arg };
    return null;
  }
  if (head === "review") {
    if (parts.length === 1) return { view: "review", scope: ALL_SCOPE, ref: null };
    if (parts.length === 2 && isProjectKey(arg)) return { view: "review", scope: arg, ref: null };
    if (parts.length === 2 && isIssueRef(arg))
      return { view: "review", scope: projectKeyFromRef(arg), ref: arg };
    return null;
  }
  if (head === "search" && parts.length === 1)
    return { view: "search", scope: ALL_SCOPE, query: new URLSearchParams(search).get("q") ?? "" };
  if (head === "new" && parts.length === 1) return { view: "new-issue", scope: ALL_SCOPE };
  if (head === "agents" && parts.length === 1) return { view: "agents", scope: ALL_SCOPE };
  if (head === "approvals" && parts.length === 1) return { view: "approvals", scope: ALL_SCOPE };
  return null;
}

function matchRoute(pathname: string, search: string): Route | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return defaultRoute();
  if (parts[0] === "settings") {
    if (parts.length === 1) return { view: "settings", tab: "projects" };
    if (parts.length === 2 && (SETTINGS_TABS as readonly string[]).includes(parts[1]))
      return { view: "settings", tab: parts[1] as SettingsTab };
    return null;
  }
  return matchScoped(parts, search) ?? matchLegacy(parts, search);
}

export function parsePath(pathname: string, search = ""): Route {
  return matchRoute(pathname, search) ?? defaultRoute();
}

export function href(route: Route): string {
  if (route.view === "settings")
    return route.tab === "projects" ? "/settings" : `/settings/${route.tab}`;
  if (route.view === "board") return `/${route.scope}/board`;
  if (route.view === "issue") return `/${route.scope}/issue/${route.ref}`;
  if (route.view === "triage") return `/${route.scope}/triage`;
  if (route.view === "review")
    return route.ref ? `/${route.scope}/review/${route.ref}` : `/${route.scope}/review`;
  if (route.view === "new-issue") return `/${route.scope}/new`;
  if (route.view === "search")
    return route.query
      ? `/${route.scope}/search?q=${encodeURIComponent(route.query)}`
      : `/${route.scope}/search`;
  if (route.view === "agents") return `/${route.scope}/agents`;
  if (route.view === "approvals") return `/${route.scope}/approvals`;
  return `/${ALL_SCOPE}/triage`;
}
```

`useRoute` gains canonicalization and generalizes the last-project memory:

```ts
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => {
    migrateHashRoute();
    return parsePath(location.pathname, location.search);
  });
  useEffect(() => {
    const onChange = () => setRoute(parsePath(location.pathname, location.search));
    window.addEventListener("popstate", onChange);
    window.addEventListener(NAVIGATE_EVENT, onChange);
    return () => {
      window.removeEventListener("popstate", onChange);
      window.removeEventListener(NAVIGATE_EVENT, onChange);
    };
  }, []);
  // Legacy shapes, bare "/", and ref-vs-scope mismatches all parse to a route
  // whose canonical href differs from the address bar. Replace, never push —
  // the non-canonical form must not become a back-button stop. Stable after
  // one pass: the replaced URL parses back to the same route.
  useEffect(() => {
    const canonical = href(route);
    if (canonical !== `${location.pathname}${location.search}`) redirect(canonical);
  }, [route]);
  useEffect(() => {
    const project = route.view === "settings" ? null : scopeProject(route.scope);
    if (project) setLastProject(project);
  }, [route]);
  return route;
}
```

Note `redirect(target)` already no-ops when the path matches, so the effect can call it unconditionally on mismatch only (the guard above keeps re-render noise down).

- [ ] **Step 4: Run router tests until green**

Run: `npx vitest run ui/src/router.test.tsx`
Expected: PASS.

- [ ] **Step 5: Adapt `App.tsx` ShellRouter**

Replace the view wiring (`ui/src/App.tsx:102-113`) with:

```tsx
<Shell me={me} projects={projects.data ?? []}>
  {route.view === "triage" && <Triage project={scopeProject(route.scope)} />}
  {route.view === "board" && <Board project={route.scope} />}
  {route.view === "issue" && <IssueDetail refId={route.ref} />}
  {route.view === "review" && (
    <Review project={scopeProject(route.scope)} currentRef={route.ref} />
  )}
  {route.view === "new-issue" && <NewIssue defaultProject={scopeProject(route.scope)} />}
  {route.view === "search" && <Search query={route.query} project={scopeProject(route.scope)} />}
  {route.view === "agents" && <Agents project={scopeProject(route.scope)} />}
  {route.view === "approvals" && <Approvals project={scopeProject(route.scope)} />}
  {route.view === "settings" && <Settings tab={route.tab} />}
</Shell>
```

(`scopeProject` imported from `./router`.) The click interceptor needs no change — `isKnownPath` accepts legacy and new shapes, so markdown links to `/issue/SYD-66` still intercept and then canonicalize.

- [ ] **Step 6: Adapt `Shell.tsx`**

Derive scope once, generate all nav under it, and generalize the switcher:

```tsx
const lastProject = getLastProject();
const rememberedProject = allProjects.some((p) => p.key === lastProject) ? lastProject : null;
// Settings is unscoped; its nav renders under the remembered scope.
const scope = route.view === "settings" ? (rememberedProject ?? ALL_SCOPE) : route.scope;
const scopeKey = scopeProject(scope);
const boardProject = scopeKey ?? rememberedProject ?? allProjects[0]?.key ?? "";
```

- Review badge poll: `listIssues({ status: "in_review", project: scopeKey ?? undefined })`, dep `[scopeKey]`.
- Nav links: Triage `href({ view: "triage", scope })`; Board `boardProject ? href({ view: "board", scope: boardProject }) : href({ view: "triage", scope: ALL_SCOPE })`; Review `href({ view: "review", scope, ref: null })`; Agents `href({ view: "agents", scope })`; Approvals `href({ view: "approvals", scope })`; Settings unchanged. Delete `triageHref`/`reviewHref` and the `currentProject`/`scopeProject` locals they fed.
- New-issue button: `navigate({ view: "new-issue", scope })`.
- `SearchBox` gains a `scope: string` prop; submit: ref fast-path `navigate(issueRoute(upper))`, else `navigate({ view: "search", scope, query: trimmed })`.
- Scope switcher: render on every view except `settings`. `value={scopeKey ?? ""}`; the "All projects" empty option is hidden on `board` and `issue` (both need a concrete key). onChange:

```tsx
const next = e.target.value || ALL_SCOPE;
if (route.view === "issue")
  navigate(next === ALL_SCOPE ? { view: "triage", scope: ALL_SCOPE } : { view: "board", scope: next });
else if (route.view === "board") navigate({ view: "board", scope: e.target.value });
else if (route.view === "review") navigate({ view: "review", scope: next, ref: null });
else if (route.view === "search") navigate({ view: "search", scope: next, query: route.query });
else if (route.view !== "settings") navigate({ ...route, scope: next });
```

(Issue view pins its scope to the ref, so switching picks the target project's board — the nearest "keep browsing that project" surface. Review drops the selected ref when switching: the ref belongs to the old scope.)

- [ ] **Step 7: Compile-only prop additions to the four views**

Add the new props with no behavior yet (behavior is Task 2), so this task typechecks: `Agents({ project }: { project: string | null })` (unused-var-safe: prefix `_project` is NOT the pattern here — accept and ignore via `void project;`? No — just wire the trivial filter in Task 2; for this task have the components accept the prop and not use it, TypeScript allows unused destructured props). Same for `Approvals`, `Search` (add `project` prop), `NewIssue` (`defaultProject`). Update `Search` to drop nothing yet.

- [ ] **Step 8: Sweep issue links to `issueRoute`**

Grep: `grep -rn 'view: "issue"' ui/src --include='*.tsx' --include='*.ts' | grep -v test | grep -v router.ts`
Replace each `href({ view: "issue", ref: X })` / `navigate({ view: "issue", ref: X })` with `href(issueRoute(X))` / `navigate(issueRoute(X))` (known sites: `Agents.tsx:23`, `Approvals.tsx:51`, `Search.tsx:68`, `NewIssue.tsx:64`, `Shell.tsx:37` (SearchBox), plus Triage/Board/Review/IssueDetail/attention sites the grep surfaces).

- [ ] **Step 9: Fix remaining test files that construct old shapes**

Run: `npm run typecheck && npx vitest run`
Fix every failure by updating to new route shapes / canonical URLs (expected: `Shell.test.tsx`, `App.test.tsx`, several `views/*.test.tsx` asserting `/issue/...` hrefs — assert `/SYD/issue/SYD-1` style now). Do not weaken assertions; where a test asserted a legacy URL renders, keep it but assert the canonicalized outcome.

- [ ] **Step 10: Full gate, then commit**

Run: `npm run typecheck && npm run build:ui && npx vitest run`
Expected: all pass.

```bash
git add ui/src docs/superpowers/plans/2026-07-24-project-scoped-urls.md
git commit -m "feat: scope-first URLs — /SYD/board, /all/triage, canonicalizing router (SYD-254)"
```

---

### Task 2: Scoped behavior in Agents, Approvals, Search, NewIssue

**Files:**
- Modify: `ui/src/views/Agents.tsx`, `ui/src/views/Approvals.tsx`, `ui/src/views/Search.tsx`, `ui/src/views/NewIssue.tsx`
- Test: colocated `*.test.tsx` for each

**Interfaces:** Consumes Task 1's props. No new exports.

- [ ] **Step 1: Write failing tests**

`Agents.test.tsx` — render `<Agents project="SYD" />` with a mocked `listAgentSessions` returning sessions for `SYD-1` and `HEX-2`; assert only `SYD-1` renders. Render with `project={null}`; assert both.

`Approvals.test.tsx` — mock `listPendingActions` with two actions whose `issueId`s resolve (via mocked `listIssues`) to `SYD-1` and `HEX-2`, plus one action whose `issueId` resolves to nothing. With `project="SYD"`: assert `SYD-1` row renders, `HEX-2` doesn't, and the unresolved row **still renders** (an approval must never be hidden by a failed ref lookup — over-show, don't silently drop a blocking approval). With `project={null}`: all three.

`Search.test.tsx` — render `<Search query="bug" project="SYD" />`; assert `listIssues` was called with `project: "SYD"`, and the view's own project `<select>` is gone (scope comes from the topbar switcher now). With `project={null}`: `project: undefined`.

`NewIssue.test.tsx` — render `<NewIssue defaultProject="HEX" />` with mocked `listProjects` returning SYD and HEX; assert the project select shows HEX. With `defaultProject={null}`: first project (SYD), as today.

- [ ] **Step 2: Run them, confirm failures**

Run: `npx vitest run ui/src/views/Agents.test.tsx ui/src/views/Approvals.test.tsx ui/src/views/Search.test.tsx ui/src/views/NewIssue.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `Agents.tsx`: `const scoped = project ? data.filter((s) => projectKeyFromRef(s.ref) === project) : data;` then split running/exited from `scoped`. Import `projectKeyFromRef` from `../refs`.
- `Approvals.tsx`: filter the queue rows before mapping: `const visible = queue.data.filter((a) => { if (!project) return true; const ref = refById.get(a.issueId); return !ref || projectKeyFromRef(ref) === project; });` — header count uses `visible.length`. Comment the over-show rule.
- `Search.tsx`: delete the `project` useState + its `<select>` + the `listProjects` poll/import; `listIssues({ text: trimmed, project: project ?? undefined, status: ..., label: ... })`, poll deps `[trimmed, project, status, label]`.
- `NewIssue.tsx`: `const effectiveProjectKey = projectKey || defaultProject || availableProjects[0]?.key || "";` (keep the explicit-pick state as-is).

- [ ] **Step 4: Run tests until green**

Run: same vitest command as Step 2. Expected: PASS.

- [ ] **Step 5: Full gate, then commit**

Run: `npm run typecheck && npm run build:ui && npx vitest run`

```bash
git add ui/src/views
git commit -m "feat: scope Agents/Approvals/Search/NewIssue views by URL project scope (SYD-254)"
```

---

### Task 3: Shell scope-switcher tests + codemap + verify

**Files:**
- Test: `ui/src/Shell.test.tsx`
- Modify: `codemaps/frontend.md` (via `/update-codemaps` if available to the session; otherwise note staleness in the PR body — do not hand-edit)

- [ ] **Step 1: Write failing Shell tests**

In `Shell.test.tsx` (follow its existing render/mock pattern): (a) on `/HEX/agents` the Triage/Review/Agents/Approvals nav links all carry `/HEX/...` hrefs; (b) on `/all/triage` the Board link targets the remembered project's board (seed `localStorage["switchyard:last-project"] = "SYD"`); (c) the switcher renders on agents/approvals/search views (absent only on settings); (d) picking a project on `/all/agents` navigates to `/SYD/agents`; (e) "All projects" option absent while on board and issue views.

- [ ] **Step 2: Run, confirm failures, fix Shell if needed, re-run to green**

Run: `npx vitest run ui/src/Shell.test.tsx`
(Task 1 Step 6 should already implement these; this step is the behavioral lock-in. Fix any gaps the tests expose.)

- [ ] **Step 3: Full verify (CI mirror)**

Run: `npm run verify`
Expected: node-version check, typecheck (both tsconfigs), build:ui, full vitest — all green.

- [ ] **Step 4: Commit + push + PR**

```bash
git add ui/src codemaps
git commit -m "test: Shell scope-switcher coverage; codemap refresh (SYD-254)"
git push origin HEAD:feat/project-scoped-urls
gh pr create --title "feat: project-scoped URLs — scope-first routing (SYD-254)" --body "..."
```

(Worktree push memory: `push.default=current` would push `worktree-project-scoped-urls`; always push explicit `HEAD:feat/project-scoped-urls`.)

PR body: spec link, URL table summary, legacy-redirect note, screenshots of the scope switcher on agents/approvals (visual-verification memory: attach screenshots for UI work).

- [ ] **Step 5: Board close-out**

Comment on SYD-254 (what was done + verify evidence), move to `in_review` if the claim/lease is held by then (needs Sean to have accepted it out of triage), attach screenshots to the issue.

---

## Self-Review Notes

- Spec coverage: URL table → Task 1 Steps 1/3; redirects table → Step 1 legacy block + canonicalization tests; ref-wins → matchScoped/issueRoute + tests; localStorage single job → useRoute effect + memory tests; Shell switcher → Task 1 Step 6 + Task 3 tests; view scoping → Task 2; settings unchanged → tests; error handling rows → default-route fallback retained (`parsePath` `?? defaultRoute()`), unknown-key empty render needs no code (views already render empty data).
- Type consistency: `scope: string` everywhere; `scopeProject(scope)` is the only null-producing accessor; view props take `string | null` — checked against Task 1 Interfaces block.
- Search's own project dropdown removal is an intentional spec deviation-refinement: the spec says "Search passes the scope as the search API's project param"; a second in-view project picker would fight the topbar switcher. Noted for PR review.
