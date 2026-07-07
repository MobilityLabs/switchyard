# Switchyard REST API + Auth + Webhooks Implementation Plan (Plan 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the Plan 1 service layer over an authenticated REST API, add CLI-minted magic-link sessions for humans, enforce the human-only triage exit (SYD-8), and deliver outbound webhooks on issue events.

**Architecture:** Same single Hono process. New `/api/*` routes are thin adapters over the existing services, authenticated by bearer token (agents/scripts) OR session cookie (humans). Login links and sessions are hashed tokens in new tables; the CLI mints one-time login URLs. Webhooks are rows in a `webhooks` table; a cursor-based poller reads the append-only `events` table after commit and POSTs JSON (optionally HMAC-signed) to registered URLs — no in-transaction network calls.

**Tech Stack:** Existing stack (Node 24, TypeScript, Hono 4, drizzle + better-sqlite3, vitest). No new dependencies.

**This is Plan 2 of 3.** Plan 1 (core + MCP) is merged and deployed. Plan 3: web UI + redeploy.

## Global Constraints

- Statuses: `triage`, `backlog`, `todo`, `in_progress`, `in_review`, `done`, `canceled`. Priorities: `none`, `low`, `medium`, `high`, `urgent`. Refs `<KEY>-<number>`.
- **NEW (SYD-8):** only human actors may change an issue's status FROM `triage` to anything else — enforced in `updateIssue`, error is agent-legible.
- Errors crossing any boundary (MCP, REST, CLI) are agent-legible `SwitchyardError` messages, never stack traces. REST: `SwitchyardError` → 400 `{ "error": message }`; unauthenticated → 401; unknown internal errors → 500 `{ "error": "internal error" }` with the real error logged server-side.
- Tokens are stored ONLY as sha256 hashes. Prefixes: actor `syd_`, login link `syl_` (15-minute TTL, single-use), session `sys_` (30-day TTL). Session cookie name: `switchyard_session`, httpOnly, SameSite=Lax, path=/.
- Every mutation still appends to `events` in the same transaction; webhook delivery happens strictly after commit via the cursor poller (best-effort, no retries in this plan; failures logged).
- Webhook signature header: `x-switchyard-signature: sha256=<hex hmac-sha256 of raw body with the webhook's secret>`.
- Tests against real `:memory:` SQLite; REST tested through `app.request(...)` or a real listening server — no mocked HTTP inside Hono.
- Run `npx drizzle-kit generate` after schema changes and commit the migration files.
- Commit after every task at minimum.

---

### Task 1: Schema for sessions, login links, webhooks, and the delivery cursor

**Files:**
- Modify: `src/db/schema.ts` (append tables)
- Create: migration via `npx drizzle-kit generate`
- Test: `tests/db/plan2-schema.test.ts`

**Interfaces:**
- Consumes: existing `actors`, `projects` tables; `now()` helper in `schema.ts`.
- Produces: tables `sessions` (id, tokenHash unique, actorId FK, expiresAt, createdAt), `loginLinks` (id, tokenHash unique, actorId FK, expiresAt, usedAt nullable, createdAt), `webhooks` (id, url, projectId nullable FK, secret nullable, active bool default true, createdAt), `webhookCursor` (id PK, lastEventId default 0). All exported from `src/db/schema.ts`.

- [ ] **Step 1: Write the failing test**

`tests/db/plan2-schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { sql } from "drizzle-orm";

describe("plan 2 schema", () => {
  it("migrates the new tables", () => {
    const db = openDb(":memory:");
    const names = db
      .all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type='table'`)
      .map((r) => r.name);
    for (const t of ["sessions", "login_links", "webhooks", "webhook_cursor"]) {
      expect(names).toContain(t);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/plan2-schema.test.ts`
Expected: FAIL — tables missing.

- [ ] **Step 3: Append to `src/db/schema.ts`**

```ts
export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tokenHash: text("token_hash").notNull().unique(),
  actorId: integer("actor_id").notNull().references(() => actors.id),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull().default(now()),
});

export const loginLinks = sqliteTable("login_links", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tokenHash: text("token_hash").notNull().unique(),
  actorId: integer("actor_id").notNull().references(() => actors.id),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
  createdAt: integer("created_at").notNull().default(now()),
});

export const webhooks = sqliteTable("webhooks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  url: text("url").notNull(),
  projectId: integer("project_id").references(() => projects.id),
  secret: text("secret"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull().default(now()),
});

export const webhookCursor = sqliteTable("webhook_cursor", {
  id: integer("id").primaryKey(),
  lastEventId: integer("last_event_id").notNull().default(0),
});
```

- [ ] **Step 4: Generate the migration**

Run: `npx drizzle-kit generate`
Expected: a new SQL file under `drizzle/`. Commit it.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/db/plan2-schema.test.ts` — PASS. Then `npx vitest run` — all green.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: schema for sessions, login links, webhooks, delivery cursor"
```

---

### Task 2: Enforce human-only triage exit (SYD-8)

**Files:**
- Modify: `src/services/issues.ts` (inside `updateIssue`'s status branch)
- Modify: `src/mcp/server.ts` (update_issue tool description)
- Test: `tests/services/issues-update.test.ts` (append)

**Interfaces:**
- Consumes: existing `updateIssue`, `claimIssue`, `createIssue`.
- Produces: behavioral guarantee — `updateIssue` throws `SwitchyardError` matching `/only humans move issues out of triage/i` when `actor.type === "agent"`, `current.status === "triage"`, and the patch changes status. Agents may still edit non-status fields of triage issues. `claimIssue` on a triage issue inherits the guard (it routes through `updateIssue`).

- [ ] **Step 1: Write the failing tests**

Append inside `describe("updateIssue", ...)` in `tests/services/issues-update.test.ts`:

```ts
  it("agents cannot move issues out of triage; humans can", () => {
    const filed = createIssue(db, agent, {
      projectKey: "AIPI", title: "Agent-filed",
      provenance: { sourceType: "manual", detail: "x" },
    });
    // non-status edits by agents are still allowed in triage
    expect(updateIssue(db, agent, filed.ref, { priority: "high" }).priority).toBe("high");
    expect(() => updateIssue(db, agent, filed.ref, { status: "todo" }))
      .toThrowError(/only humans move issues out of triage/i);
    expect(() => claimIssue(db, agent, filed.ref))
      .toThrowError(/only humans move issues out of triage/i);
    expect(updateIssue(db, human, filed.ref, { status: "todo" }).status).toBe("todo");
  });
```

(`claimIssue` and `createIssue` are already imported in this file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/issues-update.test.ts`
Expected: FAIL — no error thrown for the agent status change.

- [ ] **Step 3: Implement the guard**

In `src/services/issues.ts`, inside `updateIssue`, in the `if (patch.status !== undefined && patch.status !== current.status)` block, immediately after the `STATUSES.includes` validation, add:

```ts
      if (current.status === "triage" && actor.type === "agent") {
        throw new SwitchyardError(
          `${ref} is in triage — only humans move issues out of triage. Use triage_queue to help a human review it.`
        );
      }
```

- [ ] **Step 4: Update the MCP tool description**

In `src/mcp/server.ts`, in the `update_issue` registration, change the description's convention sentence to end with:

```
"NEVER move an issue you worked on to done — a human or a review step does that. " +
"Issues in triage can only be moved out by humans (enforced by the server)."
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run` — all green (the MCP write-tools test does not exercise agent triage-exit, so nothing else changes).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: enforce human-only triage exit at the service layer (SYD-8)"
```

---

### Task 3: Token util and auth service (login links + sessions)

**Files:**
- Create: `src/services/tokens.ts`, `src/services/auth.ts`
- Modify: `src/services/actors.ts` (use the shared util; behavior unchanged)
- Test: `tests/services/auth.test.ts`

**Interfaces:**
- Consumes: `sessions`, `loginLinks`, `actors` tables; `SwitchyardError`; `Actor` type.
- Produces:
  - `tokens.ts`: `hashToken(t: string): string` (sha256 hex); `mintToken(prefix: string, bytes = 24): string` (`<prefix>_<hex>`).
  - `auth.ts`: `createLoginLink(db, actorName: string): { token: string; path: string }` (human actors only; 15-min TTL); `redeemLoginLink(db, token: string): { sessionToken: string; actor: Actor }` (single-use; creates 30-day session); `getSessionActor(db, sessionToken: string): Actor | null`; `deleteSession(db, sessionToken: string): void`.

- [ ] **Step 1: Write the failing test**

`tests/services/auth.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import {
  createLoginLink, redeemLoginLink, getSessionActor, deleteSession,
} from "../../src/services/auth.js";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
  createActor(db, { name: "sean", type: "human" });
  createActor(db, { name: "claude/dev", type: "agent" });
});

describe("auth", () => {
  it("mints a link, redeems it once, and the session authenticates", () => {
    const { token, path } = createLoginLink(db, "sean");
    expect(token).toMatch(/^syl_[0-9a-f]{48}$/);
    expect(path).toBe(`/auth/login?token=${token}`);
    const { sessionToken, actor } = redeemLoginLink(db, token);
    expect(sessionToken).toMatch(/^sys_[0-9a-f]{64}$/);
    expect(actor.name).toBe("sean");
    expect(getSessionActor(db, sessionToken)?.name).toBe("sean");
    // single use
    expect(() => redeemLoginLink(db, token)).toThrowError(/invalid, expired, or already used/i);
    deleteSession(db, sessionToken);
    expect(getSessionActor(db, sessionToken)).toBeNull();
  });

  it("rejects agents and unknown actors", () => {
    expect(() => createLoginLink(db, "claude/dev")).toThrowError(/agents authenticate with their bearer token/i);
    expect(() => createLoginLink(db, "ghost")).toThrowError(/no actor named "ghost"/i);
    expect(getSessionActor(db, "sys_" + "0".repeat(64))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/auth.test.ts` — FAIL, module not found.

- [ ] **Step 3: Implement**

`src/services/tokens.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
export const mintToken = (prefix: string, bytes = 24) =>
  `${prefix}_${randomBytes(bytes).toString("hex")}`;
```

`src/services/auth.ts`:

```ts
import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { actors, loginLinks, sessions } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { hashToken, mintToken } from "./tokens.js";

const LOGIN_TTL = 15 * 60;
const SESSION_TTL = 30 * 24 * 3600;
const nowSec = () => Math.floor(Date.now() / 1000);

export function createLoginLink(db: Db, actorName: string): { token: string; path: string } {
  const actor = db.select().from(actors).where(eq(actors.name, actorName)).get();
  if (!actor) throw new SwitchyardError(`There is no actor named "${actorName}".`);
  if (actor.type !== "human") {
    throw new SwitchyardError(
      `"${actorName}" is an agent — agents authenticate with their bearer token, not login links.`
    );
  }
  const token = mintToken("syl");
  db.insert(loginLinks)
    .values({ tokenHash: hashToken(token), actorId: actor.id, expiresAt: nowSec() + LOGIN_TTL })
    .run();
  return { token, path: `/auth/login?token=${token}` };
}

export function redeemLoginLink(db: Db, token: string): { sessionToken: string; actor: Actor } {
  const row = db.select().from(loginLinks).where(eq(loginLinks.tokenHash, hashToken(token))).get();
  if (!row || row.usedAt !== null || row.expiresAt < nowSec()) {
    throw new SwitchyardError(
      "This login link is invalid, expired, or already used — mint a new one with the switchyard CLI."
    );
  }
  db.update(loginLinks).set({ usedAt: nowSec() }).where(eq(loginLinks.id, row.id)).run();
  const sessionToken = mintToken("sys", 32);
  db.insert(sessions)
    .values({ tokenHash: hashToken(sessionToken), actorId: row.actorId, expiresAt: nowSec() + SESSION_TTL })
    .run();
  const a = db.select().from(actors).where(eq(actors.id, row.actorId)).get()!;
  return { sessionToken, actor: { id: a.id, name: a.name, type: a.type } };
}

export function getSessionActor(db: Db, sessionToken: string): Actor | null {
  const row = db
    .select({ s: sessions, a: actors })
    .from(sessions)
    .innerJoin(actors, eq(sessions.actorId, actors.id))
    .where(eq(sessions.tokenHash, hashToken(sessionToken)))
    .get();
  if (!row || row.s.expiresAt < nowSec()) return null;
  return { id: row.a.id, name: row.a.name, type: row.a.type };
}

export function deleteSession(db: Db, sessionToken: string): void {
  db.delete(sessions).where(eq(sessions.tokenHash, hashToken(sessionToken))).run();
}
```

Refactor `src/services/actors.ts`: delete its private `hash` helper and `randomBytes`/`createHash` imports; import `hashToken, mintToken` from `./tokens.js`; replace `hash(token)` with `hashToken(token)` (both call sites) and `"syd_" + randomBytes(24).toString("hex")` with `mintToken("syd")`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/services/auth.test.ts` — PASS (2 tests). `npx vitest run` — all green (actor tests unchanged and still passing proves the refactor preserved token format).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: login links and sessions with shared token util"
```

---

### Task 4: Auth HTTP routes and CLI mint-login

**Files:**
- Create: `src/rest/auth-routes.ts`
- Modify: `src/cli.ts` (add `mint-login`), `src/server.ts` (mount the routes)
- Test: `tests/rest/auth-routes.test.ts`

**Interfaces:**
- Consumes: Task 3's auth service.
- Produces: `buildAuthRoutes(db: Db): Hono` with `GET /auth/login?token=` (redeems, sets `switchyard_session` cookie, returns `{ ok: true, actor }`) and `POST /auth/logout` (deletes session, clears cookie). CLI: `tsx src/cli.ts <db> mint-login <name>` prints a full login URL using `SWITCHYARD_URL` (default `http://localhost:3300`).

- [ ] **Step 1: Write the failing test**

`tests/rest/auth-routes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createLoginLink, getSessionActor } from "../../src/services/auth.js";
import { buildAuthRoutes } from "../../src/rest/auth-routes.js";

describe("auth routes", () => {
  it("login sets a session cookie; logout clears it", async () => {
    const db = openDb(":memory:");
    createActor(db, { name: "sean", type: "human" });
    const app = buildAuthRoutes(db);
    const { path } = createLoginLink(db, "sean");

    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, actor: "sean" });
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/switchyard_session=sys_/);
    expect(cookie).toMatch(/HttpOnly/i);
    const sessionToken = /switchyard_session=([^;]+)/.exec(cookie)![1];
    expect(getSessionActor(db, sessionToken)?.name).toBe("sean");

    const out = await app.request("/auth/logout", { method: "POST", headers: { cookie: `switchyard_session=${sessionToken}` } });
    expect(out.status).toBe(200);
    expect(getSessionActor(db, sessionToken)).toBeNull();
  });

  it("bad or missing tokens are rejected legibly", async () => {
    const db = openDb(":memory:");
    const app = buildAuthRoutes(db);
    expect((await app.request("/auth/login")).status).toBe(400);
    const res = await app.request("/auth/login?token=syl_deadbeef");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/invalid, expired, or already used/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rest/auth-routes.test.ts` — FAIL, module not found.

- [ ] **Step 3: Implement**

`src/rest/auth-routes.ts`:

```ts
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Db } from "../db/index.js";
import { SwitchyardError } from "../services/errors.js";
import { createLoginLink, redeemLoginLink, deleteSession } from "../services/auth.js";

export const SESSION_COOKIE = "switchyard_session";

export function buildAuthRoutes(db: Db) {
  const app = new Hono();

  app.get("/auth/login", (c) => {
    const token = c.req.query("token");
    if (!token) return c.json({ error: "Missing token query parameter." }, 400);
    try {
      const { sessionToken, actor } = redeemLoginLink(db, token);
      setCookie(c, SESSION_COOKIE, sessionToken, {
        httpOnly: true, sameSite: "Lax", path: "/", maxAge: 30 * 24 * 3600,
      });
      return c.json({ ok: true, actor: actor.name });
    } catch (err) {
      if (err instanceof SwitchyardError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  app.post("/auth/logout", (c) => {
    const st = getCookie(c, SESSION_COOKIE);
    if (st) deleteSession(db, st);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  return app;
}
```

In `src/server.ts`, inside `createApp` after the `/health` route, add:

```ts
  app.route("/", buildAuthRoutes(db));
```

with `import { buildAuthRoutes } from "./rest/auth-routes.js";` at the top.

In `src/cli.ts`, add a command branch (mirroring the existing style):

```ts
} else if (cmd === "mint-login") {
  const [name] = args;
  if (!name) {
    console.error("mint-login needs: <actor name>");
    process.exit(1);
  }
  const { path } = createLoginLink(db, name);
  const base = process.env.SWITCHYARD_URL ?? "http://localhost:3300";
  console.log(`login link (valid 15 minutes, single use):`);
  console.log(base + path);
```

with `import { createLoginLink } from "./services/auth.js";` at the top, and add `mint-login <name>` to the usage lines.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/rest/auth-routes.test.ts` — PASS. `npx vitest run` — all green.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: auth routes with session cookie and CLI mint-login"
```

---

### Task 5: REST middleware and projects/actors routes

**Files:**
- Create: `src/rest/api-routes.ts`
- Modify: `src/services/actors.ts` (add `listActors`), `src/server.ts` (mount `/api`)
- Test: `tests/rest/api-projects.test.ts`

**Interfaces:**
- Consumes: `authenticate` (bearer), `getSessionActor` (cookie), services.
- Produces: `buildApiRoutes(db: Db): Hono` — auth middleware that resolves the actor from `Authorization: Bearer` first, then the `switchyard_session` cookie, 401 otherwise, and stores it in `c.var.actor`; `onError` mapping `SwitchyardError` → 400 `{error}`, others → 500 `{error:"internal error"}` + `console.error`. Routes this task: `GET /projects`, `POST /projects {key,name}`, `GET /actors` (id/name/type only, no token hashes). `listActors(db): Actor[]` added to `actors.ts`. Later tasks add issue and webhook routes to this same file.

- [ ] **Step 1: Write the failing test**

`tests/rest/api-projects.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createLoginLink, redeemLoginLink } from "../../src/services/auth.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

let db: Db, app: ReturnType<typeof buildApiRoutes>, bearer: string, cookie: string;

beforeEach(() => {
  db = openDb(":memory:");
  bearer = createActor(db, { name: "claude/dev", type: "agent" }).token;
  createActor(db, { name: "sean", type: "human" });
  const { token } = createLoginLink(db, "sean");
  cookie = `switchyard_session=${redeemLoginLink(db, token).sessionToken}`;
  app = buildApiRoutes(db);
});

describe("api auth + projects", () => {
  it("401s without credentials, works with bearer or cookie", async () => {
    expect((await app.request("/projects")).status).toBe(401);
    const viaBearer = await app.request("/projects", { headers: { authorization: `Bearer ${bearer}` } });
    expect(viaBearer.status).toBe(200);
    const created = await app.request("/projects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ key: "SYD", name: "Switchyard" }),
    });
    expect(created.status).toBe(200);
    expect(((await created.json()) as { key: string }).key).toBe("SYD");
  });

  it("maps SwitchyardError to 400 with the message", async () => {
    const res = await app.request("/projects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ key: "bad key", name: "x" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/2–10 uppercase letters/);
  });

  it("lists actors without leaking token hashes", async () => {
    const res = await app.request("/actors", { headers: { cookie } });
    const list = (await res.json()) as Record<string, unknown>[];
    expect(list.map((a) => a.name).sort()).toEqual(["claude/dev", "sean"]);
    for (const a of list) expect(a).not.toHaveProperty("tokenHash");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rest/api-projects.test.ts` — FAIL, module not found.

- [ ] **Step 3: Implement**

Add to `src/services/actors.ts`:

```ts
export function listActors(db: Db): Actor[] {
  return db.select().from(actors).all().map((r) => ({ id: r.id, name: r.name, type: r.type }));
}
```

`src/rest/api-routes.ts`:

```ts
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Db } from "../db/index.js";
import { SwitchyardError } from "../services/errors.js";
import { authenticate, listActors, type Actor } from "../services/actors.js";
import { getSessionActor } from "../services/auth.js";
import { createProject, listProjects } from "../services/projects.js";
import { SESSION_COOKIE } from "./auth-routes.js";

type Env = { Variables: { actor: Actor } };

export function buildApiRoutes(db: Db) {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    const authz = c.req.header("authorization") ?? "";
    let actor: Actor | null = null;
    if (authz.startsWith("Bearer ")) actor = authenticate(db, authz.slice(7));
    if (!actor) {
      const st = getCookie(c, SESSION_COOKIE);
      if (st) actor = getSessionActor(db, st);
    }
    if (!actor) {
      return c.json({ error: "Authentication required — pass a bearer token or log in via a login link." }, 401);
    }
    c.set("actor", actor);
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof SwitchyardError) return c.json({ error: err.message }, 400);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/projects", (c) => c.json(listProjects(db)));
  app.post("/projects", async (c) => {
    const body = (await c.req.json()) as { key: string; name: string };
    return c.json(createProject(db, body));
  });
  app.get("/actors", (c) => c.json(listActors(db)));

  return app;
}
```

In `src/server.ts`, inside `createApp`, after the auth-routes mount, add:

```ts
  app.route("/api", buildApiRoutes(db));
```

with the import `import { buildApiRoutes } from "./rest/api-routes.js";`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/rest/api-projects.test.ts` — PASS (3 tests). `npx vitest run` — all green.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: authenticated REST base with projects and actors routes"
```

---

### Task 6: REST issue routes

**Files:**
- Modify: `src/rest/api-routes.ts` (add routes before `return app`)
- Test: `tests/rest/api-issues.test.ts`

**Interfaces:**
- Consumes: `searchIssues`, `createIssue`, `getIssue`, `updateIssue`, `claimIssue`, `addComment`, `getActivity`, `nextTask`, `addDependency`.
- Produces routes:
  - `GET /issues?project=&status=&assignee=&label=&text=` → `IssueView[]`
  - `POST /issues` body `{ projectKey, title, description?, priority?, labels?, parentRef?, provenance? }` → `IssueView` (service enforces agent provenance/triage)
  - `GET /issues/:ref` → `IssueView & { activity }`
  - `PATCH /issues/:ref` body = `UpdateIssueInput` (with `assigneeName`) → `IssueView`
  - `POST /issues/:ref/claim` → `IssueView`
  - `POST /issues/:ref/comments` body `{ body }` → `{ ok: true }`
  - `GET /next-task?project=` → `IssueView | null`
  - `POST /dependencies` body `{ blockerRef, blockedRef }` → `{ ok: true }`

- [ ] **Step 1: Write the failing test**

`tests/rest/api-issues.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

let db: Db, app: ReturnType<typeof buildApiRoutes>;
let agentH: Record<string, string>, humanH: Record<string, string>;

beforeEach(() => {
  db = openDb(":memory:");
  const agent = createActor(db, { name: "claude/dev", type: "agent" });
  const human = createActor(db, { name: "sean", type: "human" });
  agentH = { authorization: `Bearer ${agent.token}`, "content-type": "application/json" };
  humanH = { authorization: `Bearer ${human.token}`, "content-type": "application/json" };
  createProject(db, { key: "SYD", name: "Switchyard" });
  app = buildApiRoutes(db);
});

async function body<T>(r: Response): Promise<T> { return (await r.json()) as T; }

describe("issue routes", () => {
  it("drives the core loop over REST", async () => {
    const filed = await body<{ ref: string; status: string }>(await app.request("/issues", {
      method: "POST", headers: agentH,
      body: JSON.stringify({
        projectKey: "SYD", title: "Flaky test",
        provenance: { sourceType: "todo", detail: "src/x.ts:1" },
      }),
    }));
    expect(filed.status).toBe("triage");

    // agent cannot exit triage (SYD-8, over REST)
    const denied = await app.request(`/issues/${filed.ref}`, {
      method: "PATCH", headers: agentH, body: JSON.stringify({ status: "todo" }),
    });
    expect(denied.status).toBe(400);
    expect((await body<{ error: string }>(denied)).error).toMatch(/only humans/i);

    const accepted = await app.request(`/issues/${filed.ref}`, {
      method: "PATCH", headers: humanH, body: JSON.stringify({ status: "todo", priority: "high" }),
    });
    expect((await body<{ status: string }>(accepted)).status).toBe("todo");

    const next = await body<{ ref: string }>(await app.request("/next-task", { headers: agentH }));
    expect(next.ref).toBe(filed.ref);

    await app.request(`/issues/${filed.ref}/claim`, { method: "POST", headers: agentH });
    await app.request(`/issues/${filed.ref}/comments`, {
      method: "POST", headers: agentH, body: JSON.stringify({ body: "done, 3 tests green" }),
    });
    const detail = await body<{ status: string; activity: { type: string }[] }>(
      await app.request(`/issues/${filed.ref}`, { headers: humanH })
    );
    expect(detail.status).toBe("in_progress");
    expect(detail.activity.map((a) => a.type)).toContain("comment");

    const search = await body<unknown[]>(
      await app.request("/issues?project=SYD&status=in_progress", { headers: humanH })
    );
    expect(search).toHaveLength(1);
  });

  it("dependencies block claims over REST", async () => {
    for (const title of ["Schema", "API"]) {
      await app.request("/issues", { method: "POST", headers: humanH, body: JSON.stringify({ projectKey: "SYD", title }) });
    }
    for (const ref of ["SYD-1", "SYD-2"]) {
      await app.request(`/issues/${ref}`, { method: "PATCH", headers: humanH, body: JSON.stringify({ status: "todo" }) });
    }
    await app.request("/dependencies", {
      method: "POST", headers: humanH, body: JSON.stringify({ blockerRef: "SYD-1", blockedRef: "SYD-2" }),
    });
    const denied = await app.request("/issues/SYD-2/claim", { method: "POST", headers: agentH });
    expect(denied.status).toBe(400);
    expect((await body<{ error: string }>(denied)).error).toMatch(/blocked by SYD-1/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rest/api-issues.test.ts` — FAIL (404s: routes missing).

- [ ] **Step 3: Implement**

Add to `src/rest/api-routes.ts` before `return app` (and extend imports accordingly):

```ts
  app.get("/issues", (c) =>
    c.json(searchIssues(db, {
      projectKey: c.req.query("project") || undefined,
      status: (c.req.query("status") as Status | undefined) || undefined,
      assigneeName: c.req.query("assignee") || undefined,
      label: c.req.query("label") || undefined,
      text: c.req.query("text") || undefined,
    }))
  );

  app.post("/issues", async (c) => {
    const body = (await c.req.json()) as CreateIssueInput;
    return c.json(createIssue(db, c.var.actor, body));
  });

  app.get("/issues/:ref", (c) => {
    const ref = c.req.param("ref");
    return c.json({ ...getIssue(db, ref), activity: getActivity(db, ref) });
  });

  app.patch("/issues/:ref", async (c) => {
    const body = (await c.req.json()) as UpdateIssueInput;
    return c.json(updateIssue(db, c.var.actor, c.req.param("ref"), body));
  });

  app.post("/issues/:ref/claim", (c) => c.json(claimIssue(db, c.var.actor, c.req.param("ref"))));

  app.post("/issues/:ref/comments", async (c) => {
    const { body } = (await c.req.json()) as { body: string };
    addComment(db, c.var.actor, c.req.param("ref"), body);
    return c.json({ ok: true });
  });

  app.get("/next-task", (c) => c.json(nextTask(db, c.var.actor, c.req.query("project") || undefined)));

  app.post("/dependencies", async (c) => {
    const { blockerRef, blockedRef } = (await c.req.json()) as { blockerRef: string; blockedRef: string };
    addDependency(db, c.var.actor, blockerRef, blockedRef);
    return c.json({ ok: true });
  });
```

Imports to add at the top of `api-routes.ts`:

```ts
import type { Status } from "../db/schema.js";
import {
  createIssue, getIssue, updateIssue, claimIssue,
  type CreateIssueInput, type UpdateIssueInput,
} from "../services/issues.js";
import { addDependency, nextTask } from "../services/dependencies.js";
import { addComment, getActivity } from "../services/comments.js";
import { searchIssues } from "../services/search.js";
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/rest/api-issues.test.ts` — PASS (2 tests). `npx vitest run` — all green.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: REST issue routes covering the full core loop"
```

---

### Task 7: Webhook registration (service + REST + CLI)

**Files:**
- Create: `src/services/webhooks.ts`
- Modify: `src/rest/api-routes.ts` (webhook routes), `src/cli.ts` (webhook commands)
- Test: `tests/services/webhooks.test.ts`, `tests/rest/api-webhooks.test.ts`

**Interfaces:**
- Consumes: `webhooks` table, `getProjectByKey`.
- Produces (`webhooks.ts`): `type Webhook = typeof webhooks.$inferSelect`; `addWebhook(db, input: { url: string; projectKey?: string; secret?: string }): Webhook` (validates `http(s)://`); `listWebhooks(db): Webhook[]`; `removeWebhook(db, id: number): void` (throws legibly if missing). REST: `GET /webhooks`, `POST /webhooks {url, projectKey?, secret?}`, `DELETE /webhooks/:id`. CLI: `add-webhook <url> [PROJECT_KEY]`, `list-webhooks`, `rm-webhook <id>`.

- [ ] **Step 1: Write the failing tests**

`tests/services/webhooks.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { addWebhook, listWebhooks, removeWebhook } from "../../src/services/webhooks.js";

describe("webhooks", () => {
  it("registers, lists, scopes to a project, and removes", () => {
    const db = openDb(":memory:");
    createActor(db, { name: "sean", type: "human" });
    const p = createProject(db, { key: "SYD", name: "Switchyard" });
    const all = addWebhook(db, { url: "http://example.com/hook" });
    const scoped = addWebhook(db, { url: "http://example.com/syd", projectKey: "SYD", secret: "s3cret" });
    expect(all.projectId).toBeNull();
    expect(scoped.projectId).toBe(p.id);
    expect(listWebhooks(db)).toHaveLength(2);
    removeWebhook(db, all.id);
    expect(listWebhooks(db)).toHaveLength(1);
    expect(() => removeWebhook(db, 999)).toThrowError(/no webhook with id 999/i);
    expect(() => addWebhook(db, { url: "ftp://nope" })).toThrowError(/must be http/i);
    expect(() => addWebhook(db, { url: "http://x.com", projectKey: "NOPE" })).toThrowError(/no project with key/i);
  });
});
```

`tests/rest/api-webhooks.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

describe("webhook routes", () => {
  it("creates, lists, deletes", async () => {
    const db = openDb(":memory:");
    const h = {
      authorization: `Bearer ${createActor(db, { name: "sean", type: "human" }).token}`,
      "content-type": "application/json",
    };
    const app = buildApiRoutes(db);
    const created = await app.request("/webhooks", {
      method: "POST", headers: h, body: JSON.stringify({ url: "http://example.com/hook" }),
    });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: number };
    expect((await (await app.request("/webhooks", { headers: h })).json())).toHaveLength(1);
    expect((await app.request(`/webhooks/${id}`, { method: "DELETE", headers: h })).status).toBe(200);
    expect((await (await app.request("/webhooks", { headers: h })).json())).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/services/webhooks.test.ts tests/rest/api-webhooks.test.ts` — FAIL, module not found / 404.

- [ ] **Step 3: Implement**

`src/services/webhooks.ts`:

```ts
import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { webhooks } from "../db/schema.js";
import { SwitchyardError } from "./errors.js";
import { getProjectByKey } from "./projects.js";

export type Webhook = typeof webhooks.$inferSelect;

export function addWebhook(
  db: Db,
  input: { url: string; projectKey?: string; secret?: string }
): Webhook {
  if (!/^https?:\/\//.test(input.url)) {
    throw new SwitchyardError(`Webhook url must be http(s) — got "${input.url}".`);
  }
  const projectId = input.projectKey ? getProjectByKey(db, input.projectKey).id : null;
  return db
    .insert(webhooks)
    .values({ url: input.url, projectId, secret: input.secret ?? null })
    .returning()
    .get();
}

export function listWebhooks(db: Db): Webhook[] {
  return db.select().from(webhooks).all();
}

export function removeWebhook(db: Db, id: number): void {
  const gone = db.delete(webhooks).where(eq(webhooks.id, id)).returning().get();
  if (!gone) throw new SwitchyardError(`There is no webhook with id ${id} — list them with GET /api/webhooks.`);
}
```

Add to `src/rest/api-routes.ts` before `return app`:

```ts
  app.get("/webhooks", (c) => c.json(listWebhooks(db)));
  app.post("/webhooks", async (c) => {
    const body = (await c.req.json()) as { url: string; projectKey?: string; secret?: string };
    return c.json(addWebhook(db, body));
  });
  app.delete("/webhooks/:id", (c) => {
    removeWebhook(db, Number(c.req.param("id")));
    return c.json({ ok: true });
  });
```

with `import { addWebhook, listWebhooks, removeWebhook } from "../services/webhooks.js";`.

Add to `src/cli.ts` (same command-branch style, plus usage lines):

```ts
} else if (cmd === "add-webhook") {
  const [url, projectKey] = args;
  if (!url) { console.error("add-webhook needs: <url> [PROJECT_KEY]"); process.exit(1); }
  const hook = addWebhook(db, { url, projectKey });
  console.log(`webhook ${hook.id} -> ${hook.url}${projectKey ? ` (project ${projectKey})` : " (all projects)"}`);
} else if (cmd === "list-webhooks") {
  for (const h of listWebhooks(db)) console.log(`${h.id}: ${h.url} projectId=${h.projectId ?? "all"}`);
} else if (cmd === "rm-webhook") {
  removeWebhook(db, Number(args[0]));
  console.log("removed");
```

with `import { addWebhook, listWebhooks, removeWebhook } from "./services/webhooks.js";`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/services/webhooks.test.ts tests/rest/api-webhooks.test.ts` — PASS. `npx vitest run` — all green.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: webhook registration via service, REST, and CLI"
```

---

### Task 8: Webhook dispatcher (cursor poller + HMAC delivery)

**Files:**
- Create: `src/services/webhook-dispatcher.ts`
- Test: `tests/services/webhook-dispatcher.test.ts`

**Interfaces:**
- Consumes: `events`, `issues`, `projects`, `actors`, `webhooks`, `webhookCursor` tables.
- Produces: `dispatchPending(db: Db, fetchFn: typeof fetch = fetch): Promise<number>` — delivers events newer than the cursor to matching active webhooks, advances the cursor, returns delivery count; delivery body is JSON `{ event, payload, issue, title, status, project, actor, at }`; `x-switchyard-signature: sha256=<hmac>` header when the webhook has a secret; 5s timeout; failures are logged and NOT retried (cursor still advances — best-effort v1). `startWebhookDispatcher(db: Db, intervalMs = 2000): () => void` — unref'd interval, returns a stop function.

- [ ] **Step 1: Write the failing test**

`tests/services/webhook-dispatcher.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue } from "../../src/services/issues.js";
import { addWebhook } from "../../src/services/webhooks.js";
import { dispatchPending } from "../../src/services/webhook-dispatcher.js";

describe("webhook dispatcher", () => {
  it("delivers signed events once, then advances the cursor", async () => {
    const received: { body: string; sig: string | null }[] = [];
    const receiver = new Hono().post("/hook", async (c) => {
      received.push({ body: await c.req.text(), sig: c.req.header("x-switchyard-signature") ?? null });
      return c.json({ ok: true });
    });
    let port = 0;
    const server: ServerType = await new Promise((resolve) => {
      const s = serve({ fetch: receiver.fetch, port: 0 }, (i) => { port = i.port; resolve(s); });
    });

    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    createProject(db, { key: "SYD", name: "Switchyard" });
    addWebhook(db, { url: `http://127.0.0.1:${port}/hook`, secret: "s3cret" });
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });          // 1 event
    updateIssue(db, human, "SYD-1", { status: "todo" });                       // 1 event

    expect(await dispatchPending(db)).toBe(2);
    expect(received).toHaveLength(2);
    const first = JSON.parse(received[0].body);
    expect(first).toMatchObject({ event: "created", issue: "SYD-1", project: "SYD", actor: "sean" });
    const expected = "sha256=" + createHmac("sha256", "s3cret").update(received[0].body).digest("hex");
    expect(received[0].sig).toBe(expected);

    // cursor advanced: nothing new
    expect(await dispatchPending(db)).toBe(0);
    expect(received).toHaveLength(2);

    server.close();
  });

  it("skips webhooks scoped to another project and survives dead endpoints", async () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    createProject(db, { key: "SYD", name: "Switchyard" });
    createProject(db, { key: "AIPI", name: "aipi" });
    addWebhook(db, { url: "http://127.0.0.1:1/dead", projectKey: "AIPI" }); // scoped elsewhere + dead
    createIssue(db, human, { projectKey: "SYD", title: "One" });
    expect(await dispatchPending(db)).toBe(0); // no matching hook, no throw
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/webhook-dispatcher.test.ts` — FAIL, module not found.

- [ ] **Step 3: Implement**

`src/services/webhook-dispatcher.ts`:

```ts
import { createHmac } from "node:crypto";
import { asc, eq, gt } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { actors, events, issues, projects, webhooks, webhookCursor } from "../db/schema.js";

export async function dispatchPending(db: Db, fetchFn: typeof fetch = fetch): Promise<number> {
  let cursor = db.select().from(webhookCursor).where(eq(webhookCursor.id, 1)).get();
  if (!cursor) {
    db.insert(webhookCursor).values({ id: 1, lastEventId: 0 }).run();
    cursor = { id: 1, lastEventId: 0 };
  }
  const rows = db
    .select({ e: events, i: issues, p: projects, a: actors })
    .from(events)
    .innerJoin(issues, eq(events.issueId, issues.id))
    .innerJoin(projects, eq(issues.projectId, projects.id))
    .innerJoin(actors, eq(events.actorId, actors.id))
    .where(gt(events.id, cursor.lastEventId))
    .orderBy(asc(events.id))
    .limit(100)
    .all();
  if (rows.length === 0) return 0;

  const hooks = db.select().from(webhooks).where(eq(webhooks.active, true)).all();
  let delivered = 0;
  for (const r of rows) {
    const body = JSON.stringify({
      event: r.e.type,
      payload: r.e.payload,
      issue: `${r.p.key}-${r.i.number}`,
      title: r.i.title,
      status: r.i.status,
      project: r.p.key,
      actor: r.a.name,
      at: r.e.createdAt,
    });
    for (const h of hooks) {
      if (h.projectId !== null && h.projectId !== r.i.projectId) continue;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (h.secret) {
        headers["x-switchyard-signature"] =
          "sha256=" + createHmac("sha256", h.secret).update(body).digest("hex");
      }
      try {
        await fetchFn(h.url, { method: "POST", headers, body, signal: AbortSignal.timeout(5000) });
        delivered++;
      } catch (err) {
        console.error(`webhook ${h.id} -> ${h.url} failed: ${(err as Error).message}`);
      }
    }
    db.update(webhookCursor).set({ lastEventId: r.e.id }).where(eq(webhookCursor.id, 1)).run();
  }
  return delivered;
}

export function startWebhookDispatcher(db: Db, intervalMs = 2000): () => void {
  const timer = setInterval(() => {
    dispatchPending(db).catch((err) => console.error("webhook dispatch:", err));
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/services/webhook-dispatcher.test.ts` — PASS (2 tests). `npx vitest run` — all green.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: cursor-based webhook dispatcher with HMAC signatures"
```

---

### Task 9: Wire-up, integration test, README

**Files:**
- Modify: `src/server.ts` (start dispatcher in the entrypoint only), `README.md`
- Test: `tests/integration/rest-loop.test.ts`

**Interfaces:**
- Consumes: everything.
- Produces: entrypoint starts the webhook dispatcher (`startWebhookDispatcher(db)`) — NOT inside `createApp` (tests drive `dispatchPending` manually); README documents auth flow, REST endpoints, webhooks, and the new CLI commands.

- [ ] **Step 1: Write the failing integration test**

`tests/integration/rest-loop.test.ts` — the Plan 2 product loop over a real listening server: mint link → login cookie → human works over REST, agent over bearer, triage gate enforced end-to-end, webhook delivered:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createLoginLink } from "../../src/services/auth.js";
import { addWebhook } from "../../src/services/webhooks.js";
import { dispatchPending } from "../../src/services/webhook-dispatcher.js";
import { createApp } from "../../src/server.js";

let db: Db, server: ServerType, base: string, agentToken: string;
let receiver: ServerType;
const hookBodies: string[] = [];

beforeAll(async () => {
  db = openDb(":memory:");
  agentToken = createActor(db, { name: "claude/dev", type: "agent" }).token;
  createActor(db, { name: "sean", type: "human" });
  createProject(db, { key: "SYD", name: "Switchyard" });

  server = await new Promise((resolve) => {
    const s = serve({ fetch: createApp(db).fetch, port: 0 }, (i) => {
      base = `http://127.0.0.1:${i.port}`;
      resolve(s);
    });
  });
  const rec = new Hono().post("/hook", async (c) => {
    hookBodies.push(await c.req.text());
    return c.json({ ok: true });
  });
  receiver = await new Promise((resolve) => {
    const s = serve({ fetch: rec.fetch, port: 0 }, (i) => {
      addWebhook(db, { url: `http://127.0.0.1:${i.port}/hook` });
      resolve(s);
    });
  });
});

afterAll(() => { server.close(); receiver.close(); });

describe("plan 2 loop", () => {
  it("login link -> cookie -> full REST loop with triage gate and webhooks", async () => {
    const { path } = createLoginLink(db, "sean");
    const login = await fetch(base + path);
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];

    const agentH = { authorization: `Bearer ${agentToken}`, "content-type": "application/json" };
    const humanH = { cookie, "content-type": "application/json" };

    const filed = await (await fetch(`${base}/api/issues`, {
      method: "POST", headers: agentH,
      body: JSON.stringify({
        projectKey: "SYD", title: "Found a bug",
        provenance: { sourceType: "session", detail: "rest-loop test" },
      }),
    })).json() as { ref: string; status: string };
    expect(filed.status).toBe("triage");

    const denied = await fetch(`${base}/api/issues/${filed.ref}`, {
      method: "PATCH", headers: agentH, body: JSON.stringify({ status: "todo" }),
    });
    expect(denied.status).toBe(400);

    const ok = await fetch(`${base}/api/issues/${filed.ref}`, {
      method: "PATCH", headers: humanH, body: JSON.stringify({ status: "todo" }),
    });
    expect(ok.status).toBe(200);

    await fetch(`${base}/api/issues/${filed.ref}/claim`, { method: "POST", headers: agentH });

    expect(await dispatchPending(db)).toBeGreaterThanOrEqual(3);
    const eventsSeen = hookBodies.map((b) => JSON.parse(b).event);
    expect(eventsSeen).toContain("created");
    expect(eventsSeen).toContain("status_changed");
  });

  it("unauthenticated API requests 401", async () => {
    expect((await fetch(`${base}/api/issues`)).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/rest-loop.test.ts`
Expected: FAIL only if Tasks 4–8 aren't wired into `createApp` — if Tasks 4/5 were done correctly this passes; treat a pass here as the signal to proceed to Step 3.

- [ ] **Step 3: Start the dispatcher in the entrypoint**

In `src/server.ts`, in the `import.meta.url` entrypoint block, after `startServer(...)`, add:

```ts
  const { startWebhookDispatcher } = await import("./services/webhook-dispatcher.js");
  startWebhookDispatcher(db);
```

- [ ] **Step 4: Update README**

Add to `README.md` after the "Connect Claude Code" section:

````markdown
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
````

Also add the new CLI commands to the usage lines in `src/cli.ts` if not already done in Tasks 4/7.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run` — ALL green. `npx tsc --noEmit` — clean.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: wire dispatcher into entrypoint, integration test, README for plan 2"
```

---

## After this plan

Redeploy the NAS container (copy source via tar-over-ssh to `~/mcps/switchyard/`, then `sudo env DOCKER_BUILDKIT=0 docker compose up -d --build switchyard` — Synology needs the legacy builder). Then: mint a login link with `SWITCHYARD_URL=http://100.85.158.109:3300`, mark SYD-8 and the Plan 2 roadmap issue done, and start Plan 3 (web UI on top of these REST routes).
