# Switchyard Web UI Implementation Plan (Plan 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A thin React web UI — triage inbox, per-project board, issue detail — served by the same Hono process over the existing REST API, plus the small API additions it needs (`/api/me`, webhook toggle, zod-validated bodies).

**Architecture:** Vite builds `ui/` (React 19 + TypeScript, hash routing, no router/state libraries) into `dist/ui`; Hono serves it statically after all API routes. The UI authenticates via the existing session cookie; agents' bearer tokens never touch it. Polling every 15s + refetch after each mutation; no websockets. All UI actions are thin calls to `/api/*`.

**Tech Stack:** Existing stack + `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `@hono/zod-validator` (zod already present). No CSS framework — one hand-written `styles.css`.

**This is Plan 3 of 3.** Plans 1–2 are merged and deployed to the NAS.

## Global Constraints

- Statuses (exact strings + display order): `triage`, `backlog`, `todo`, `in_progress`, `in_review`, `done`, `canceled`. Priorities: `none`, `low`, `medium`, `high`, `urgent`. Refs `<KEY>-<number>`.
- The web UI is cookie-authenticated (humans). If `/api/me` returns 401, show the login-needed screen with the exact mint-login command — never embed or request bearer tokens in the UI.
- Server route precedence: `/health`, `/auth/*`, `/api/*`, `/mcp` are registered BEFORE static serving; the SPA is served from `/` only (hash routing — no server-side SPA fallback needed).
- REST error shape stays `{ error: string }`; validation failures return 400 with that shape (zod messages joined), never zod's default format.
- Triage inbox is the primary view (default route). Accept = status → `backlog` or `todo`; dismiss = `canceled`.
- Board columns show `backlog → todo → in_progress → in_review → done` (triage lives in the inbox, canceled hidden). Drag a card to a column = PATCH status.
- Every mutation from the UI refetches the affected view immediately; background polling every 15 000 ms.
- Tests: REST additions get vitest coverage like Plan 2; UI has no unit-test harness in this plan (thin client; final verification is browser-driven after deploy). `npx tsc --noEmit` must stay clean — UI code included via a second tsconfig project reference is NOT required; instead `ui/` gets its own `tsconfig.json` checked by `npx tsc -p ui --noEmit`.
- Commit after every task; `git add` specific files only, never `-A`.

---

### Task 1: `/api/me` and webhook active-toggle

**Files:**
- Modify: `src/rest/api-routes.ts`, `src/services/webhooks.ts`
- Test: `tests/rest/api-me.test.ts`, extend `tests/rest/api-webhooks.test.ts`

**Interfaces:**
- Consumes: existing auth middleware (`c.var.actor`), `webhooks` table.
- Produces: `GET /api/me` → `{ id, name, type }` of the authenticated actor. `setWebhookActive(db, id: number, active: boolean): Webhook` in webhooks.ts (throws /no webhook with id/i if missing). `PATCH /api/webhooks/:id` body `{ active: boolean }` → redacted webhook; human-only (same guard/message as POST/DELETE: "Only humans manage webhooks — ask a human to add or remove webhook endpoints.").

- [ ] **Step 1: Write the failing tests**

`tests/rest/api-me.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

describe("GET /me", () => {
  it("returns the authenticated actor", async () => {
    const db = openDb(":memory:");
    const { token } = createActor(db, { name: "claude/dev", type: "agent" });
    const app = buildApiRoutes(db);
    const res = await app.request("/me", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 1, name: "claude/dev", type: "agent" });
    expect((await app.request("/me")).status).toBe(401);
  });
});
```

Append to the existing describe in `tests/rest/api-webhooks.test.ts` (it already has `db`, `app`, and human/agent header fixtures — reuse them; if the file builds fixtures inline per test, follow its existing pattern):

```ts
  it("PATCH toggles active, human-only", async () => {
    const db = openDb(":memory:");
    const humanH = {
      authorization: `Bearer ${createActor(db, { name: "sean", type: "human" }).token}`,
      "content-type": "application/json",
    };
    const agentH = {
      authorization: `Bearer ${createActor(db, { name: "claude/dev", type: "agent" }).token}`,
      "content-type": "application/json",
    };
    const app = buildApiRoutes(db);
    const { id } = (await (await app.request("/webhooks", {
      method: "POST", headers: humanH, body: JSON.stringify({ url: "http://example.com/h" }),
    })).json()) as { id: number };

    const off = await app.request(`/webhooks/${id}`, {
      method: "PATCH", headers: humanH, body: JSON.stringify({ active: false }),
    });
    expect(((await off.json()) as { active: boolean }).active).toBe(false);

    const denied = await app.request(`/webhooks/${id}`, {
      method: "PATCH", headers: agentH, body: JSON.stringify({ active: true }),
    });
    expect(denied.status).toBe(400);
    expect(((await denied.json()) as { error: string }).error).toMatch(/only humans manage webhooks/i);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/rest/api-me.test.ts tests/rest/api-webhooks.test.ts`
Expected: FAIL — `/me` 404, PATCH 404.

- [ ] **Step 3: Implement**

Add to `src/services/webhooks.ts`:

```ts
export function setWebhookActive(db: Db, id: number, active: boolean): Webhook {
  const row = db.update(webhooks).set({ active }).where(eq(webhooks.id, id)).returning().get();
  if (!row) throw new SwitchyardError(`There is no webhook with id ${id} — list them with GET /api/webhooks.`);
  return row;
}
```

Add to `src/rest/api-routes.ts` (`/me` near the top with the other GETs; PATCH beside the other webhook routes, reusing the existing `redact` helper and the exact human-only guard used by POST/DELETE):

```ts
  app.get("/me", (c) => c.json(c.var.actor));
```

```ts
  app.patch("/webhooks/:id", async (c) => {
    if (c.var.actor.type === "agent") {
      throw new SwitchyardError(
        "Only humans manage webhooks — ask a human to add or remove webhook endpoints."
      );
    }
    const { active } = (await c.req.json()) as { active: boolean };
    return c.json(redact(setWebhookActive(db, Number(c.req.param("id")), active)));
  });
```

(Import `setWebhookActive` alongside the other webhook imports.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/rest/api-me.test.ts tests/rest/api-webhooks.test.ts` — PASS. `npx vitest run` — all green.

- [ ] **Step 5: Commit**

```bash
git add src/rest/api-routes.ts src/services/webhooks.ts tests/rest/api-me.test.ts tests/rest/api-webhooks.test.ts
git commit -m "feat: GET /api/me and human-only webhook active toggle"
```

---

### Task 2: Zod-validated request bodies

**Files:**
- Create: `src/rest/schemas.ts`
- Modify: `src/rest/api-routes.ts`
- Test: `tests/rest/api-validation.test.ts`

**Interfaces:**
- Consumes: `STATUSES`, `PRIORITIES` from schema; `@hono/zod-validator` (install: `npm i @hono/zod-validator`).
- Produces: `src/rest/schemas.ts` exporting zod schemas `projectBody`, `issueCreateBody`, `issueUpdateBody`, `commentBody`, `dependencyBody`, `webhookCreateBody`, `webhookPatchBody`, and `body(schema)` — a preconfigured `zValidator("json", schema, hook)` whose hook returns `c.json({ error: <first issue path + message> }, 400)`. Every POST/PATCH route in `api-routes.ts` uses `body(...)` and reads input via `c.req.valid("json")` — the `as` casts disappear.

- [ ] **Step 1: Write the failing test**

`tests/rest/api-validation.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

let db: Db, app: ReturnType<typeof buildApiRoutes>, h: Record<string, string>;
beforeEach(() => {
  db = openDb(":memory:");
  h = {
    authorization: `Bearer ${createActor(db, { name: "sean", type: "human" }).token}`,
    "content-type": "application/json",
  };
  createProject(db, { key: "SYD", name: "Switchyard" });
  app = buildApiRoutes(db);
});

const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: h, body: JSON.stringify(body) });

describe("request validation", () => {
  it("rejects wrong-typed and missing fields with legible 400s", async () => {
    const noTitle = await post("/issues", { projectKey: "SYD" });
    expect(noTitle.status).toBe(400);
    expect(((await noTitle.json()) as { error: string }).error).toMatch(/title/);

    const badPriority = await post("/issues", { projectKey: "SYD", title: "x", priority: "mega" });
    expect(badPriority.status).toBe(400);
    expect(((await badPriority.json()) as { error: string }).error).toMatch(/priority/);

    const badStatus = await app.request("/issues/SYD-1", {
      method: "PATCH", headers: h, body: JSON.stringify({ status: "doing" }),
    });
    expect(badStatus.status).toBe(400);

    const badUrl = await post("/webhooks", { url: 42 });
    expect(badUrl.status).toBe(400);
    expect(((await badUrl.json()) as { error: string }).error).toMatch(/url/);
  });

  it("valid bodies still work end to end", async () => {
    const created = await post("/issues", { projectKey: "SYD", title: "Real one", priority: "high" });
    expect(created.status).toBe(200);
    expect(((await created.json()) as { ref: string }).ref).toBe("SYD-1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rest/api-validation.test.ts`
Expected: FAIL — missing title currently reaches the service (which throws a NOT NULL/other error → 400 or 500 without /title/ in the message) and `url: 42` currently 500s or passes wrongly.

- [ ] **Step 3: Implement**

`npm i @hono/zod-validator`

`src/rest/schemas.ts`:

```ts
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { STATUSES, PRIORITIES } from "../db/schema.js";

export const projectBody = z.object({ key: z.string(), name: z.string() });

const provenance = z.object({
  sourceType: z.enum(["session", "todo", "ci", "manual"]),
  detail: z.string().optional(),
  url: z.string().optional(),
});

export const issueCreateBody = z.object({
  projectKey: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  priority: z.enum(PRIORITIES).optional(),
  labels: z.array(z.string()).optional(),
  parentRef: z.string().optional(),
  provenance: provenance.optional(),
});

export const issueUpdateBody = z.object({
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  assigneeName: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
});

export const commentBody = z.object({ body: z.string() });
export const dependencyBody = z.object({ blockerRef: z.string(), blockedRef: z.string() });
export const webhookCreateBody = z.object({
  url: z.string(),
  projectKey: z.string().optional(),
  secret: z.string().optional(),
});
export const webhookPatchBody = z.object({ active: z.boolean() });

export const body = <T extends z.ZodTypeAny>(schema: T) =>
  zValidator("json", schema, (result, c) => {
    if (!result.success) {
      const first = result.error.issues[0];
      const path = first.path.join(".");
      return c.json({ error: `Invalid request body${path ? ` at "${path}"` : ""}: ${first.message}` }, 400);
    }
  });
```

In `src/rest/api-routes.ts`, for each POST/PATCH route: add `body(<schema>)` as middleware and replace `(await c.req.json()) as X` with `c.req.valid("json")`. Example for issues:

```ts
  app.post("/issues", body(issueCreateBody), (c) =>
    c.json(createIssue(db, c.var.actor, c.req.valid("json")))
  );

  app.patch("/issues/:ref", body(issueUpdateBody), (c) =>
    c.json(updateIssue(db, c.var.actor, c.req.param("ref"), c.req.valid("json")))
  );
```

Apply the same pattern to `POST /projects` (`projectBody`), `POST /issues/:ref/comments` (`commentBody`), `POST /dependencies` (`dependencyBody`), `POST /webhooks` (`webhookCreateBody`), `PATCH /webhooks/:id` (`webhookPatchBody`). Import the schemas + `body` from `./schemas.js`. Note: `zValidator` responds 400 itself on invalid JSON syntax too; the existing SyntaxError branch in `onError` stays for non-validated routes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/rest/api-validation.test.ts` — PASS. `npx vitest run` — ALL tests still green (existing tests send valid bodies; if any existing test sends a field the schema omits, extend the schema — the schemas above match the service-layer input types exactly). `npx tsc --noEmit` — clean.

**Known version-dependent wrinkle:** depending on the installed `@hono/zod-validator`, a syntactically-invalid JSON body on a validated route either (a) throws `SyntaxError` → our `onError` branch responds `{"error":"Request body is not valid JSON — send a JSON object."}`, or (b) is answered by the validator itself with its own 400. The existing malformed-JSON test in `tests/rest/api-projects.test.ts` asserts (a)'s message on `POST /projects`. If it fails after this task, the fix is to make behavior (a) explicit: wrap the route's JSON access so a parse failure rethrows SyntaxError, or simplest, assert only `status === 400` plus a non-empty `error` string in that test and note the message source. Either resolution is acceptable; a plain-text or empty-body 400 is NOT — the response must stay `{ error: string }`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/rest/schemas.ts src/rest/api-routes.ts tests/rest/api-validation.test.ts
git commit -m "feat: zod-validated REST bodies with legible 400s"
```

---

### Task 3: Vite + React scaffold, static serving, Docker build

**Files:**
- Create: `ui/index.html`, `ui/vite.config.ts`, `ui/tsconfig.json`, `ui/src/main.tsx`, `ui/src/App.tsx`, `ui/src/api.ts`, `ui/src/types.ts`, `ui/src/styles.css`
- Modify: `package.json` (scripts + deps), `src/server.ts` (static serving), `Dockerfile`, `.dockerignore`, `.gitignore`
- Test: manual smoke (this task has no vitest surface; the deliverable is a served page)

**Interfaces:**
- Consumes: `GET /api/me`.
- Produces: `npm run build:ui` emits `dist/ui/`; `createApp` serves it at `/` (after all API mounts); `npm run dev:ui` runs Vite on :5173 proxying `/api` + `/auth` to :3300. `ui/src/api.ts` exports `api<T>(path, init?): Promise<T>` (fetch wrapper: JSON, throws `ApiError` with `.status` and server `error` message) and typed helpers used by later tasks: `getMe()`, `listProjects()`, `listIssues(filters)`, `getIssue(ref)`, `createIssue(input)`, `updateIssue(ref, patch)`, `claimIssue(ref)`, `addComment(ref, body)`, `logout()`. `ui/src/types.ts` mirrors `IssueView`, `Project`, `Actor`, `Activity`. `App.tsx` renders: loading → login-needed screen (on 401) → `<Shell me={...}>` (placeholder `<p>hello {me.name}</p>` this task; Task 4 replaces).

- [ ] **Step 1: Install and scaffold**

```bash
npm i react react-dom
npm i -D vite @vitejs/plugin-react @types/react @types/react-dom
```

Add to root `package.json` scripts:

```json
    "build:ui": "vite build --config ui/vite.config.ts",
    "dev:ui": "vite --config ui/vite.config.ts"
```

`ui/vite.config.ts`:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.dirname(new URL(import.meta.url).pathname),
  plugins: [react()],
  build: { outDir: "../dist/ui", emptyOutDir: true },
  server: {
    proxy: {
      "/api": "http://localhost:3300",
      "/auth": "http://localhost:3300",
    },
  },
});
```

`ui/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

`ui/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Switchyard</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Append `dist/` to `.gitignore`. In `.dockerignore` ensure `dist` is NOT excluded is irrelevant (we build inside the image) but `ui` must be included — verify `.dockerignore` doesn't exclude it (it doesn't; no change likely needed).

- [ ] **Step 2: Types and API client**

`ui/src/types.ts`:

```ts
export type Actor = { id: number; name: string; type: "human" | "agent" };
export type Project = { id: number; key: string; name: string };
export const STATUSES = ["triage", "backlog", "todo", "in_progress", "in_review", "done", "canceled"] as const;
export type Status = (typeof STATUSES)[number];
export const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];
export type Issue = {
  id: number; ref: string; title: string; description: string;
  status: Status; priority: Priority;
  assigneeId: number | null; creatorId: number; labels: string[];
  sourceType: "session" | "todo" | "ci" | "manual" | null;
  sourceDetail: string | null; sourceUrl: string | null;
  createdAt: number; updatedAt: number;
};
export type Activity = { type: string; actorName: string; payload: Record<string, unknown>; createdAt: number };
export type IssueDetail = Issue & { activity: Activity[] };
```

`ui/src/api.ts`:

```ts
import type { Actor, Issue, IssueDetail, Priority, Project, Status } from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const getMe = () => api<Actor>("/api/me");
export const listProjects = () => api<Project[]>("/api/projects");
export const listIssues = (filters: { project?: string; status?: Status } = {}) => {
  const q = new URLSearchParams();
  if (filters.project) q.set("project", filters.project);
  if (filters.status) q.set("status", filters.status);
  const qs = q.toString();
  return api<Issue[]>(`/api/issues${qs ? `?${qs}` : ""}`);
};
export const getIssue = (ref: string) => api<IssueDetail>(`/api/issues/${ref}`);
export const updateIssue = (
  ref: string,
  patch: Partial<{ status: Status; priority: Priority; title: string; description: string; assigneeName: string | null; labels: string[] }>,
) => api<Issue>(`/api/issues/${ref}`, { method: "PATCH", body: JSON.stringify(patch) });
export const createIssue = (input: { projectKey: string; title: string; description?: string; priority?: Priority }) =>
  api<Issue>("/api/issues", { method: "POST", body: JSON.stringify(input) });
export const claimIssue = (ref: string) => api<Issue>(`/api/issues/${ref}/claim`, { method: "POST" });
export const addComment = (ref: string, body: string) =>
  api<{ ok: true }>(`/api/issues/${ref}/comments`, { method: "POST", body: JSON.stringify({ body }) });
export const logout = () => api<{ ok: true }>("/auth/logout", { method: "POST" });
```

- [ ] **Step 3: Minimal App + login screen**

`ui/src/main.tsx`:

```tsx
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);
```

`ui/src/App.tsx`:

```tsx
import { useEffect, useState } from "react";
import { getMe, ApiError } from "./api";
import type { Actor } from "./types";

export default function App() {
  const [me, setMe] = useState<Actor | null>(null);
  const [authState, setAuthState] = useState<"loading" | "out" | "in">("loading");

  useEffect(() => {
    getMe()
      .then((a) => { setMe(a); setAuthState("in"); })
      .catch((e) => setAuthState(e instanceof ApiError && e.status === 401 ? "out" : "out"));
  }, []);

  if (authState === "loading") return <main className="center"><p>Loading…</p></main>;
  if (authState === "out" || !me) {
    return (
      <main className="center login">
        <h1>Switchyard</h1>
        <p>You need a login link. On the server host, run:</p>
        <pre>npx tsx src/cli.ts /data/switchyard.db mint-login &lt;your-name&gt;</pre>
        <p>then open the printed URL in this browser (links are single-use, 15&nbsp;min).</p>
      </main>
    );
  }
  return <main className="center"><p>hello {me.name}</p></main>;
}
```

`ui/src/styles.css` (foundation only; later tasks extend — keep these custom-property names):

```css
:root {
  --bg: #14161a; --panel: #1d2026; --panel-2: #24282f;
  --text: #e6e8eb; --muted: #9aa3ad; --line: #33383f;
  --accent: #e8833a; --accent-2: #4c9be8;
  --ok: #4caf7d; --warn: #e8b04c; --danger: #e85c5c;
  --radius: 8px;
  font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); }
.center { display: grid; place-items: center; min-height: 100vh; }
.login pre { background: var(--panel); padding: 12px 16px; border-radius: var(--radius); }
button {
  background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
  border-radius: var(--radius); padding: 6px 12px; cursor: pointer; font-size: 13px;
}
button:hover { border-color: var(--muted); }
button.primary { background: var(--accent); border-color: var(--accent); color: #14161a; font-weight: 600; }
button.danger { color: var(--danger); }
a { color: var(--accent-2); text-decoration: none; }
```

- [ ] **Step 4: Serve the build from Hono**

In `src/server.ts`, inside `createApp`, AFTER the `/mcp` route registration (so it stays last), add:

```ts
  app.use("/*", serveStatic({ root: "./dist/ui" }));
```

with `import { serveStatic } from "@hono/node-server/serve-static";` at the top. (Hash routing means `/` + assets are the only paths the UI needs; API routes are registered earlier and win.)

- [ ] **Step 5: Docker build**

In `Dockerfile`, after `COPY src ./src`, add:

```dockerfile
COPY ui ./ui
RUN npx vite build --config ui/vite.config.ts
```

- [ ] **Step 6: Verify**

```bash
npm run build:ui                 # emits dist/ui/index.html + assets
npx tsc -p ui --noEmit           # clean
npx vitest run                   # all green (no server tests touched)
SWITCHYARD_DB=/tmp/ui-smoke.db PORT=3399 npx tsx src/server.ts &
sleep 1
curl -s http://localhost:3399/ | grep -o '<title>Switchyard</title>'
curl -s http://localhost:3399/health
kill %1 && rm -f /tmp/ui-smoke.db*
```

Expected: title tag found; `{"ok":true}` (API routes still win over static).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json ui .gitignore src/server.ts Dockerfile
git commit -m "feat: vite/react scaffold with cookie-auth gate, served by hono, built in docker"
```

---

### Task 4: App shell — header, hash router, polling hook

**Files:**
- Create: `ui/src/router.ts`, `ui/src/usePoll.ts`, `ui/src/Shell.tsx`
- Modify: `ui/src/App.tsx`, `ui/src/styles.css` (append)

**Interfaces:**
- Consumes: Task 3's api client + types.
- Produces:
  - `router.ts`: `type Route = { view: "triage" } | { view: "board"; project: string } | { view: "issue"; ref: string }`; `parseHash(hash: string): Route` (default `{view:"triage"}`; `#/board/SYD`, `#/issue/SYD-8`); `useRoute(): Route` (React hook, subscribes to `hashchange`); `href(route: Route): string`.
  - `usePoll.ts`: `usePoll<T>(fn: () => Promise<T>, deps: unknown[], intervalMs = 15000): { data: T | null; error: string | null; reload: () => void }` — runs immediately, re-runs on `deps` change and every interval; `reload` forces a refetch (used after mutations).
  - `Shell.tsx`: header with logo "⧉ Switchyard", nav links (Triage, Board), project switcher (`<select>` of projects, drives board route), spacer, actor badge (`me.name`), Logout button (calls `logout()` then `location.reload()`). Renders `children` below in `<div className="content">`.
  - `App.tsx` (authState "in"): `<Shell me={me} projects={projects}>{routeView}</Shell>` where `routeView` switches on `useRoute()` — this task renders placeholders `<p>triage view</p>` etc.; Tasks 5–7 replace them.

- [ ] **Step 1: Implement router**

`ui/src/router.ts`:

```ts
import { useEffect, useState } from "react";

export type Route =
  | { view: "triage" }
  | { view: "board"; project: string }
  | { view: "issue"; ref: string };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "board" && parts[1]) return { view: "board", project: parts[1] };
  if (parts[0] === "issue" && parts[1]) return { view: "issue", ref: parts[1] };
  return { view: "triage" };
}

export function href(route: Route): string {
  if (route.view === "board") return `#/board/${route.project}`;
  if (route.view === "issue") return `#/issue/${route.ref}`;
  return "#/";
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
```

`ui/src/usePoll.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";

export function usePoll<T>(fn: () => Promise<T>, deps: unknown[], intervalMs = 15000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let live = true;
    const run = () =>
      fnRef.current().then(
        (d) => { if (live) { setData(d); setError(null); } },
        (e) => { if (live) setError(e instanceof Error ? e.message : String(e)); },
      );
    run();
    const timer = setInterval(run, intervalMs);
    return () => { live = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, intervalMs]);

  return { data, error, reload };
}
```

- [ ] **Step 2: Shell**

`ui/src/Shell.tsx`:

```tsx
import type { ReactNode } from "react";
import type { Actor, Project } from "./types";
import { href, useRoute } from "./router";
import { logout } from "./api";

export default function Shell(props: { me: Actor; projects: Project[]; children: ReactNode }) {
  const route = useRoute();
  const currentProject =
    route.view === "board" ? route.project : props.projects[0]?.key ?? "";

  return (
    <>
      <header className="topbar">
        <span className="logo">⧉ Switchyard</span>
        <nav>
          <a href="#/" className={route.view === "triage" ? "active" : ""}>Triage</a>
          <a
            href={currentProject ? href({ view: "board", project: currentProject }) : "#/"}
            className={route.view === "board" ? "active" : ""}
          >
            Board
          </a>
        </nav>
        {route.view === "board" && (
          <select
            value={route.project}
            onChange={(e) => { location.hash = href({ view: "board", project: e.target.value }); }}
          >
            {props.projects.map((p) => <option key={p.key} value={p.key}>{p.key} — {p.name}</option>)}
          </select>
        )}
        <span className="spacer" />
        <span className="badge actor">{props.me.name}</span>
        <button onClick={() => logout().then(() => location.reload())}>Log out</button>
      </header>
      <div className="content">{props.children}</div>
    </>
  );
}
```

- [ ] **Step 3: Wire into App**

Replace the `authState === "in"` return in `ui/src/App.tsx`:

```tsx
  return (
    <ShellRouter me={me} />
  );
```

and add (same file):

```tsx
function ShellRouter({ me }: { me: Actor }) {
  const route = useRoute();
  const projects = usePoll(listProjects, []);
  return (
    <Shell me={me} projects={projects.data ?? []}>
      {route.view === "triage" && <p>triage view</p>}
      {route.view === "board" && <p>board: {route.project}</p>}
      {route.view === "issue" && <p>issue: {route.ref}</p>}
    </Shell>
  );
}
```

with imports: `useRoute` from `./router`, `usePoll` from `./usePoll`, `listProjects` from `./api`, `Shell` from `./Shell`.

- [ ] **Step 4: Styles (append to styles.css)**

```css
.topbar {
  display: flex; align-items: center; gap: 16px;
  padding: 10px 18px; background: var(--panel); border-bottom: 1px solid var(--line);
  position: sticky; top: 0;
}
.logo { font-weight: 700; letter-spacing: 0.3px; color: var(--accent); }
.topbar nav { display: flex; gap: 12px; }
.topbar nav a { color: var(--muted); padding: 4px 8px; border-radius: 6px; }
.topbar nav a.active { color: var(--text); background: var(--panel-2); }
.topbar select {
  background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
  border-radius: 6px; padding: 4px 8px;
}
.spacer { flex: 1; }
.badge {
  font-size: 12px; padding: 2px 8px; border-radius: 999px;
  background: var(--panel-2); border: 1px solid var(--line); color: var(--muted);
}
.content { padding: 20px; max-width: 1200px; margin: 0 auto; }
```

- [ ] **Step 5: Verify and commit**

```bash
npx tsc -p ui --noEmit && npm run build:ui
git add ui
git commit -m "feat: app shell with hash router, project switcher, polling hook"
```

(Optional live check: `npm run dev:ui` with the server running; header renders, nav switches placeholders.)

---

### Task 5: Triage inbox

**Files:**
- Create: `ui/src/views/Triage.tsx`
- Modify: `ui/src/App.tsx` (replace placeholder), `ui/src/styles.css` (append)

**Interfaces:**
- Consumes: `listIssues({ status: "triage" })`, `updateIssue`, `usePoll`, types.
- Produces: `<Triage />` — lists ALL projects' triage issues (poll). Each row: ref (links to `#/issue/<ref>`), title, priority badge, provenance line (`sourceType · sourceDetail`, `sourceUrl` as link when present), and actions: **Accept → todo**, **Accept → backlog**, **Dismiss** (status `canceled`, with `confirm()`), inline priority `<select>`. Empty state: "Nothing in triage. The yard is clear." Errors from mutations render in a dismissible `.error-bar`.

- [ ] **Step 1: Implement**

`ui/src/views/Triage.tsx`:

```tsx
import { useState } from "react";
import { listIssues, updateIssue } from "../api";
import { usePoll } from "../usePoll";
import { PRIORITIES, type Issue, type Priority } from "../types";

export default function Triage() {
  const { data, error, reload } = usePoll(() => listIssues({ status: "triage" }), []);
  const [actionError, setActionError] = useState<string | null>(null);

  const act = (fn: () => Promise<unknown>) =>
    fn().then(() => { setActionError(null); reload(); }, (e) => setActionError(e.message));

  if (error) return <p className="error-bar">{error}</p>;
  if (!data) return <p>Loading…</p>;
  if (data.length === 0) return <p className="empty">Nothing in triage. The yard is clear.</p>;

  return (
    <section className="triage">
      <h2>Triage inbox <span className="badge">{data.length}</span></h2>
      {actionError && (
        <p className="error-bar">{actionError} <button onClick={() => setActionError(null)}>×</button></p>
      )}
      {data.map((issue) => (
        <TriageRow key={issue.ref} issue={issue} act={act} />
      ))}
    </section>
  );
}

function TriageRow({ issue, act }: { issue: Issue; act: (fn: () => Promise<unknown>) => void }) {
  return (
    <article className="triage-row">
      <div className="triage-main">
        <a className="ref" href={`#/issue/${issue.ref}`}>{issue.ref}</a>
        <span className="title">{issue.title}</span>
        <span className={`badge prio prio-${issue.priority}`}>{issue.priority}</span>
      </div>
      {issue.sourceType && (
        <div className="provenance">
          {issue.sourceType} · {issue.sourceDetail ?? ""}
          {issue.sourceUrl && <> · <a href={issue.sourceUrl} target="_blank" rel="noreferrer">link</a></>}
        </div>
      )}
      <div className="triage-actions">
        <button className="primary" onClick={() => act(() => updateIssue(issue.ref, { status: "todo" }))}>
          Accept → todo
        </button>
        <button onClick={() => act(() => updateIssue(issue.ref, { status: "backlog" }))}>
          Accept → backlog
        </button>
        <select
          value={issue.priority}
          onChange={(e) => act(() => updateIssue(issue.ref, { priority: e.target.value as Priority }))}
        >
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <button
          className="danger"
          onClick={() => { if (confirm(`Dismiss ${issue.ref}?`)) act(() => updateIssue(issue.ref, { status: "canceled" })); }}
        >
          Dismiss
        </button>
      </div>
    </article>
  );
}
```

In `App.tsx`, replace `<p>triage view</p>` with `<Triage />` (import from `./views/Triage`).

- [ ] **Step 2: Styles (append)**

```css
.triage-row {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 12px 16px; margin-bottom: 10px;
}
.triage-main { display: flex; align-items: center; gap: 10px; }
.ref { font-family: ui-monospace, Menlo, monospace; font-size: 13px; }
.title { flex: 1; }
.provenance { color: var(--muted); font-size: 12px; margin-top: 6px; font-family: ui-monospace, Menlo, monospace; }
.triage-actions { display: flex; gap: 8px; margin-top: 10px; align-items: center; }
.triage-actions select {
  background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
  border-radius: 6px; padding: 4px 8px;
}
.error-bar {
  background: color-mix(in srgb, var(--danger) 15%, var(--panel)); border: 1px solid var(--danger);
  padding: 8px 12px; border-radius: var(--radius);
}
.empty { color: var(--muted); }
.prio-urgent { color: var(--danger); border-color: var(--danger); }
.prio-high { color: var(--warn); border-color: var(--warn); }
.prio-medium { color: var(--accent-2); }
h2 { display: flex; align-items: center; gap: 8px; }
```

- [ ] **Step 3: Verify and commit**

```bash
npx tsc -p ui --noEmit && npm run build:ui
git add ui
git commit -m "feat: triage inbox with accept/dismiss/priority actions"
```

---

### Task 6: Board view

**Files:**
- Create: `ui/src/views/Board.tsx`
- Modify: `ui/src/App.tsx` (replace placeholder), `ui/src/styles.css` (append)

**Interfaces:**
- Consumes: `listIssues({ project })`, `updateIssue`, `usePoll`.
- Produces: `<Board project={string} />` — five columns in order `backlog, todo, in_progress, in_review, done` (constant `BOARD_COLUMNS`). Cards: ref link, title, priority badge. HTML5 drag & drop: card `draggable`, `onDragStart` sets `e.dataTransfer.setData("text/plain", ref)`; column `onDragOver` prevents default; `onDrop` reads the ref and `updateIssue(ref, { status: column })` then reloads. Column header shows name + count. Mutation errors in `.error-bar`.

- [ ] **Step 1: Implement**

`ui/src/views/Board.tsx`:

```tsx
import { useState } from "react";
import { listIssues, updateIssue } from "../api";
import { usePoll } from "../usePoll";
import type { Issue, Status } from "../types";

const BOARD_COLUMNS: Status[] = ["backlog", "todo", "in_progress", "in_review", "done"];
const LABELS: Record<string, string> = {
  backlog: "Backlog", todo: "Todo", in_progress: "In progress",
  in_review: "In review", done: "Done",
};

export default function Board({ project }: { project: string }) {
  const { data, error, reload } = usePoll(() => listIssues({ project }), [project]);
  const [actionError, setActionError] = useState<string | null>(null);

  if (error) return <p className="error-bar">{error}</p>;
  if (!data) return <p>Loading…</p>;

  const move = (ref: string, status: Status) =>
    updateIssue(ref, { status }).then(
      () => { setActionError(null); reload(); },
      (e) => setActionError(e.message),
    );

  return (
    <section>
      {actionError && (
        <p className="error-bar">{actionError} <button onClick={() => setActionError(null)}>×</button></p>
      )}
      <div className="board">
        {BOARD_COLUMNS.map((col) => {
          const cards = data.filter((i) => i.status === col);
          return (
            <div
              key={col}
              className="column"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const ref = e.dataTransfer.getData("text/plain");
                if (ref) move(ref, col);
              }}
            >
              <h3>{LABELS[col]} <span className="badge">{cards.length}</span></h3>
              {cards.map((issue) => <Card key={issue.ref} issue={issue} />)}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Card({ issue }: { issue: Issue }) {
  return (
    <article
      className="card"
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/plain", issue.ref)}
    >
      <a className="ref" href={`#/issue/${issue.ref}`}>{issue.ref}</a>
      <p>{issue.title}</p>
      <span className={`badge prio prio-${issue.priority}`}>{issue.priority}</span>
    </article>
  );
}
```

In `App.tsx`, replace `<p>board: {route.project}</p>` with `<Board project={route.project} />`.

- [ ] **Step 2: Styles (append)**

```css
.board { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; align-items: start; }
.column {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 10px; min-height: 200px;
}
.column h3 { margin: 2px 4px 10px; font-size: 13px; color: var(--muted); display: flex; gap: 6px; align-items: center; }
.card {
  background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 10px; margin-bottom: 8px; cursor: grab;
}
.card p { margin: 6px 0; font-size: 13px; }
.card:active { cursor: grabbing; }
```

- [ ] **Step 3: Verify and commit**

```bash
npx tsc -p ui --noEmit && npm run build:ui
git add ui
git commit -m "feat: project board with drag-to-move columns"
```

---

### Task 7: Issue detail

**Files:**
- Create: `ui/src/views/IssueDetail.tsx`
- Modify: `ui/src/App.tsx` (replace placeholder), `ui/src/styles.css` (append)

**Interfaces:**
- Consumes: `getIssue`, `updateIssue`, `addComment`, `usePoll`, `STATUSES`, `PRIORITIES`.
- Produces: `<IssueDetail refId={string} />` — header (ref, title, status `<select>` over all statuses, priority `<select>`); provenance box when present (same format as triage); description in `<pre className="description">` (empty → muted "No description"); activity feed oldest-first: comments as speech blocks (`actorName`, `payload.body`), other events as one-liners (`actorName` + humanized type + payload from/to when present); comment composer (`<textarea>` + Send, disabled while empty; refetch after post). Timestamps rendered with `new Date(createdAt * 1000).toLocaleString()`.

- [ ] **Step 1: Implement**

`ui/src/views/IssueDetail.tsx`:

```tsx
import { useState } from "react";
import { addComment, getIssue, updateIssue } from "../api";
import { usePoll } from "../usePoll";
import { PRIORITIES, STATUSES, type Activity, type Priority, type Status } from "../types";

export default function IssueDetail({ refId }: { refId: string }) {
  const { data, error, reload } = usePoll(() => getIssue(refId), [refId]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  if (error) return <p className="error-bar">{error}</p>;
  if (!data) return <p>Loading…</p>;

  const act = (fn: () => Promise<unknown>) =>
    fn().then(() => { setActionError(null); reload(); }, (e) => setActionError(e.message));

  return (
    <section className="issue">
      <header className="issue-head">
        <span className="ref">{data.ref}</span>
        <h2>{data.title}</h2>
        <select value={data.status} onChange={(e) => act(() => updateIssue(refId, { status: e.target.value as Status }))}>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={data.priority} onChange={(e) => act(() => updateIssue(refId, { priority: e.target.value as Priority }))}>
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </header>
      {actionError && (
        <p className="error-bar">{actionError} <button onClick={() => setActionError(null)}>×</button></p>
      )}
      {data.sourceType && (
        <div className="provenance panel">
          Filed from: {data.sourceType} · {data.sourceDetail ?? ""}
          {data.sourceUrl && <> · <a href={data.sourceUrl} target="_blank" rel="noreferrer">link</a></>}
        </div>
      )}
      {data.description
        ? <pre className="description panel">{data.description}</pre>
        : <p className="empty">No description.</p>}

      <h3>Activity</h3>
      <div className="activity">
        {data.activity.map((ev, i) => <Event key={i} ev={ev} />)}
      </div>

      <div className="composer">
        <textarea
          value={draft}
          placeholder="Write a comment…"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          className="primary"
          disabled={!draft.trim()}
          onClick={() => act(() => addComment(refId, draft).then(() => setDraft("")))}
        >
          Send
        </button>
      </div>
    </section>
  );
}

function Event({ ev }: { ev: Activity }) {
  const when = new Date(ev.createdAt * 1000).toLocaleString();
  if (ev.type === "comment") {
    return (
      <article className="comment panel">
        <header><strong>{ev.actorName}</strong> <time>{when}</time></header>
        <p>{String(ev.payload.body ?? "")}</p>
      </article>
    );
  }
  const fromTo =
    ev.payload.from !== undefined || ev.payload.to !== undefined
      ? ` (${ev.payload.from ?? "…"} → ${ev.payload.to ?? "…"})`
      : "";
  return (
    <p className="event">
      <strong>{ev.actorName}</strong> {ev.type.replace(/_/g, " ")}{fromTo} <time>{when}</time>
    </p>
  );
}
```

In `App.tsx`, replace `<p>issue: {route.ref}</p>` with `<IssueDetail refId={route.ref} />`.

- [ ] **Step 2: Styles (append)**

```css
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 16px; }
.issue-head { display: flex; align-items: center; gap: 12px; }
.issue-head h2 { flex: 1; margin: 0; }
.issue-head select {
  background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
  border-radius: 6px; padding: 4px 8px;
}
.description { white-space: pre-wrap; font-family: inherit; margin: 12px 0; }
.activity { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
.comment header { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; }
.comment p { margin: 6px 0 0; white-space: pre-wrap; }
.event { color: var(--muted); font-size: 13px; margin: 0; }
.event time, .comment time { color: var(--muted); font-size: 11px; }
.composer { display: flex; gap: 8px; align-items: flex-end; }
.composer textarea {
  flex: 1; min-height: 70px; background: var(--panel); color: var(--text);
  border: 1px solid var(--line); border-radius: var(--radius); padding: 10px; font-family: inherit;
}
```

- [ ] **Step 3: Verify and commit**

```bash
npx tsc -p ui --noEmit && npm run build:ui && npx vitest run
git add ui
git commit -m "feat: issue detail with activity feed and comment composer"
```

---

## After this plan (controller steps, not subagent tasks)

1. Full local verification: run server + built UI, drive it with the browser (agent-browser skill): log in via a minted link, triage an issue, drag a card, comment.
2. README: add a "Web UI" section (served at `/`, cookie login).
3. Ship to NAS (tar-over-ssh) and rebuild (`sudo env DOCKER_BUILDKIT=0 docker compose up -d --build switchyard`).
4. Mint Sean's login link on the NAS; verify the UI over Tailscale.
5. Board hygiene: move SYD-10/SYD-11 (web UI, deploy) through review; Sean marks the done column.
