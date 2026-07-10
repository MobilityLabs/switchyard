# Agent Sessions Panel (SYD-43) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While an agent works an issue, humans can watch: the dispatch worker reports session lifecycle (start/exit) to a new `agent_sessions` table, sessions post `progress_note` events as they work, and the UI grows an Agents panel (nav badge = live count) plus a live strip on the issue detail page.

**Architecture:** Mirrors the delivery-events pattern (SYD-54): a service in `src/services/agent-sessions.ts` is the single source of business logic; REST exposes it to the worker and UI; a new MCP tool (`progress_note`) exposes note-posting to dispatched sessions. Sessions get a real table (they're worker-process state: pid, exit code); progress notes ride the append-only `events` table like all other issue history, so the activity feed and the live strip read the same data. UI is polling only (usePoll), no websockets.

**Design deviations from the issue text (justify in the PR):** the issue sketches statuses `dispatched/running/exited`; `dispatched → running` is milliseconds apart (spawn → 'spawn' event), and the UI only distinguishes live vs done, so the table has `running/exited` only. Answer sessions (SYD-56) are out of scope — they never claim an issue; file a follow-up if we want them visible too.

**Tech Stack:** Drizzle/SQLite, Hono + zod, MCP SDK, React 19 + usePoll, vitest.

## Global Constraints

- Work on branch `feat/syd-43-agent-sessions` (interactive-work convention; `agent/<REF>` is reserved for dispatched workers).
- All business logic in `src/services/*`; REST/MCP/UI are thin adapters. Services throw `SwitchyardError` for user-facing failures.
- Mutate issue history only via services (`recordEvent`), never direct `events` inserts from routes.
- Schema change flow: edit `src/db/schema.ts` → `npm run db:generate` → commit the generated SQL in `drizzle/`.
- **Before every commit run all three gates in-transcript and show output:** `npm run typecheck && npm run build:ui && npx vitest run`. Never report unrun evidence.
- Node 24 (Node 25 breaks jsdom tests). No symlinked node_modules if using a worktree — `npm install` fresh, and stage specific files only (never `git add -A`).
- Worker reporting must be best-effort: a visibility-reporting failure must never break or delay dispatch.
- Timestamps are unix **seconds** (`unixepoch()`), matching every other table.

---

### Task 1: `agent_sessions` table + service

**Files:**
- Modify: `src/db/schema.ts` (append after `githubRepos`, ~line 117)
- Create: `src/services/agent-sessions.ts`
- Test: `tests/services/agent-sessions.test.ts`
- Generated: `drizzle/<n>_*.sql` via `npm run db:generate`

**Interfaces:**
- Consumes: `getIssue(db, ref)` from `services/issues.ts` (returns `{ id, ref, title, ... }`), `recordEvent(db, {issueId, actorId, type, payload})` from `services/events.ts`.
- Produces (later tasks rely on these exact signatures):
  - `AGENT_SESSION_MODES = ["cli", "container", "sdk"] as const`, `type AgentSessionMode`
  - `AGENT_SESSION_STALE_SECONDS: number`
  - `type AgentSessionView = { id: number; ref: string; issueTitle: string; mode: AgentSessionMode; pid: number | null; status: "running" | "exited"; exitCode: number | null; startedAt: number; endedAt: number | null; lastNote: { note: string; createdAt: number } | null }`
  - `startAgentSession(db, actor, { ref, mode, pid? }): AgentSessionView` (agent actors only)
  - `endAgentSession(db, actor, id, exitCode: number | null): AgentSessionView` (agent actors only)
  - `listAgentSessions(db, filters?: { active?: boolean; ref?: string }, nowSeconds?: number): AgentSessionView[]`
  - `recordProgressNote(db, actor, ref, note): void`

- [ ] **Step 1: Add the table to `src/db/schema.ts`**

```ts
// Live agent-session lifecycle (SYD-43): worker-process state (pid, exit
// code), not issue history — hence a table, unlike progress notes which ride
// the events table.
export const agentSessions = sqliteTable("agent_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  issueId: integer("issue_id").notNull().references(() => issues.id),
  actorId: integer("actor_id").notNull().references(() => actors.id),
  mode: text("mode", { enum: ["cli", "container", "sdk"] }).notNull(),
  pid: integer("pid"),
  status: text("status", { enum: ["running", "exited"] }).notNull().default("running"),
  exitCode: integer("exit_code"),
  startedAt: integer("started_at").notNull().default(now()),
  endedAt: integer("ended_at"),
});
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`
Expected: a new SQL file in `drizzle/` containing `CREATE TABLE agent_sessions`. (Migrations auto-apply via `openDb()`, including the temp DBs tests open.)

- [ ] **Step 3: Write the failing service test**

Create `tests/services/agent-sessions.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue } from "../../src/services/issues.js";
import { getActivity } from "../../src/services/comments.js";
import {
  startAgentSession, endAgentSession, listAgentSessions, recordProgressNote,
  AGENT_SESSION_STALE_SECONDS,
} from "../../src/services/agent-sessions.js";

let db: Db, human: Actor, agent: Actor;

beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, { key: "SYD", name: "Switchyard" });
  createIssue(db, agent, {
    projectKey: "SYD", title: "Ship v1", description: "x",
    provenance: { sourceType: "session" },
  });
});

describe("startAgentSession", () => {
  it("creates a running session joined with the issue ref and title", () => {
    const s = startAgentSession(db, agent, { ref: "SYD-1", mode: "cli", pid: 4242 });
    expect(s).toMatchObject({
      ref: "SYD-1", issueTitle: "Ship v1", mode: "cli", pid: 4242,
      status: "running", exitCode: null, endedAt: null, lastNote: null,
    });
    expect(s.startedAt).toBeGreaterThan(0);
  });

  it("rejects human actors — only workers report sessions", () => {
    expect(() => startAgentSession(db, human, { ref: "SYD-1", mode: "cli" }))
      .toThrow(/agent actors/i);
  });

  it("rejects an unknown ref", () => {
    expect(() => startAgentSession(db, agent, { ref: "SYD-999", mode: "cli" })).toThrow();
  });
});

describe("endAgentSession", () => {
  it("marks the session exited with its exit code and end time", () => {
    const s = startAgentSession(db, agent, { ref: "SYD-1", mode: "sdk" });
    const ended = endAgentSession(db, agent, s.id, 0);
    expect(ended.status).toBe("exited");
    expect(ended.exitCode).toBe(0);
    expect(ended.endedAt).toBeGreaterThan(0);
  });

  it("accepts a null exit code (spawn error, unknown outcome)", () => {
    const s = startAgentSession(db, agent, { ref: "SYD-1", mode: "cli" });
    expect(endAgentSession(db, agent, s.id, null).exitCode).toBeNull();
  });

  it("rejects an unknown session id", () => {
    expect(() => endAgentSession(db, agent, 999, 0)).toThrow(/does not exist/);
  });
});

describe("listAgentSessions", () => {
  it("active filter returns only running sessions", () => {
    const a = startAgentSession(db, agent, { ref: "SYD-1", mode: "cli" });
    const b = startAgentSession(db, agent, { ref: "SYD-1", mode: "cli" });
    endAgentSession(db, agent, b.id, 1);
    const active = listAgentSessions(db, { active: true });
    expect(active.map((s) => s.id)).toEqual([a.id]);
    expect(listAgentSessions(db).length).toBe(2);
  });

  it("active filter drops zombie sessions the worker never closed out", () => {
    startAgentSession(db, agent, { ref: "SYD-1", mode: "cli" });
    const farFuture = Math.floor(Date.now() / 1000) + AGENT_SESSION_STALE_SECONDS + 60;
    expect(listAgentSessions(db, { active: true }, farFuture)).toEqual([]);
  });

  it("filters by ref", () => {
    createIssue(db, agent, {
      projectKey: "SYD", title: "Other", description: "y",
      provenance: { sourceType: "session" },
    });
    startAgentSession(db, agent, { ref: "SYD-1", mode: "cli" });
    startAgentSession(db, agent, { ref: "SYD-2", mode: "cli" });
    const only = listAgentSessions(db, { ref: "SYD-2" });
    expect(only.length).toBe(1);
    expect(only[0].ref).toBe("SYD-2");
  });
});

describe("recordProgressNote", () => {
  it("records a progress_note event onto the activity feed", () => {
    recordProgressNote(db, agent, "SYD-1", "tests written, implementing the service");
    const ev = getActivity(db, "SYD-1").find((a) => a.type === "progress_note");
    expect(ev?.payload).toEqual({ note: "tests written, implementing the service" });
  });

  it("rejects an empty note", () => {
    expect(() => recordProgressNote(db, agent, "SYD-1", "   ")).toThrow(/empty/i);
  });

  it("surfaces the latest note on the session view", () => {
    const s = startAgentSession(db, agent, { ref: "SYD-1", mode: "cli" });
    recordProgressNote(db, agent, "SYD-1", "first");
    recordProgressNote(db, agent, "SYD-1", "second");
    const [view] = listAgentSessions(db, { ref: "SYD-1" });
    expect(view.id).toBe(s.id);
    expect(view.lastNote?.note).toBe("second");
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run tests/services/agent-sessions.test.ts`
Expected: FAIL — cannot resolve `../../src/services/agent-sessions.js`.

- [ ] **Step 5: Implement `src/services/agent-sessions.ts`**

```ts
// Agent-session lifecycle (SYD-43): the dispatch worker reports when a session
// starts and exits so the UI can show live "an agent is working this" state.
// Progress notes ride the events table (type "progress_note") like all other
// issue history; sessions get a real table because they are worker-process
// state (pid, exit code), not issue history.
import { and, desc, eq, gt, gte, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { agentSessions, events, issues, projects } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { getIssue } from "./issues.js";
import { recordEvent } from "./events.js";

export const AGENT_SESSION_MODES = ["cli", "container", "sdk"] as const;
export type AgentSessionMode = (typeof AGENT_SESSION_MODES)[number];

// A "running" session older than this is presumed lost (the worker died
// before reporting the exit) and drops out of active lists rather than
// showing a zombie "live" strip forever.
export const AGENT_SESSION_STALE_SECONDS = 12 * 60 * 60;

const LIST_LIMIT = 50;

export type AgentSessionView = {
  id: number;
  ref: string;
  issueTitle: string;
  mode: AgentSessionMode;
  pid: number | null;
  status: "running" | "exited";
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  lastNote: { note: string; createdAt: number } | null;
};

function requireAgent(actor: Actor): void {
  if (actor.type !== "agent") {
    throw new SwitchyardError("Only agent actors report agent sessions.");
  }
}

// Notes are per-issue events; scoping to createdAt >= startedAt attributes
// them to this session (good enough — one work session per issue at a time
// is already enforced by the claim gate).
function lastNoteFor(db: Db, issueId: number, startedAt: number): AgentSessionView["lastNote"] {
  const [row] = db
    .select({ payload: events.payload, createdAt: events.createdAt })
    .from(events)
    .where(and(eq(events.issueId, issueId), eq(events.type, "progress_note"), gte(events.createdAt, startedAt)))
    .orderBy(desc(events.id))
    .limit(1)
    .all();
  if (!row) return null;
  return { note: String((row.payload as Record<string, unknown>).note ?? ""), createdAt: row.createdAt };
}

function queryViews(db: Db, conditions: SQL[]): AgentSessionView[] {
  const rows = db
    .select({ s: agentSessions, key: projects.key, number: issues.number, issueTitle: issues.title })
    .from(agentSessions)
    .innerJoin(issues, eq(agentSessions.issueId, issues.id))
    .innerJoin(projects, eq(issues.projectId, projects.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(agentSessions.id))
    .limit(LIST_LIMIT)
    .all();
  return rows.map((r) => ({
    id: r.s.id,
    ref: `${r.key}-${r.number}`,
    issueTitle: r.issueTitle,
    mode: r.s.mode,
    pid: r.s.pid,
    status: r.s.status,
    exitCode: r.s.exitCode,
    startedAt: r.s.startedAt,
    endedAt: r.s.endedAt,
    lastNote: lastNoteFor(db, r.s.issueId, r.s.startedAt),
  }));
}

export function startAgentSession(
  db: Db,
  actor: Actor,
  input: { ref: string; mode: AgentSessionMode; pid?: number | null }
): AgentSessionView {
  requireAgent(actor);
  const issue = getIssue(db, input.ref);
  const row = db
    .insert(agentSessions)
    .values({ issueId: issue.id, actorId: actor.id, mode: input.mode, pid: input.pid ?? null })
    .returning()
    .get();
  return queryViews(db, [eq(agentSessions.id, row.id)])[0];
}

export function endAgentSession(db: Db, actor: Actor, id: number, exitCode: number | null): AgentSessionView {
  requireAgent(actor);
  const existing = db.select().from(agentSessions).where(eq(agentSessions.id, id)).get();
  if (!existing) throw new SwitchyardError(`Agent session ${id} does not exist.`);
  db.update(agentSessions)
    .set({ status: "exited", exitCode, endedAt: sql`(unixepoch())` })
    .where(eq(agentSessions.id, id))
    .run();
  return queryViews(db, [eq(agentSessions.id, id)])[0];
}

export function listAgentSessions(
  db: Db,
  filters: { active?: boolean; ref?: string } = {},
  nowSeconds: number = Math.floor(Date.now() / 1000)
): AgentSessionView[] {
  const conditions: SQL[] = [];
  if (filters.ref) conditions.push(eq(agentSessions.issueId, getIssue(db, filters.ref).id));
  if (filters.active) {
    conditions.push(eq(agentSessions.status, "running"));
    conditions.push(gt(agentSessions.startedAt, nowSeconds - AGENT_SESSION_STALE_SECONDS));
  }
  return queryViews(db, conditions);
}

export function recordProgressNote(db: Db, actor: Actor, ref: string, note: string): void {
  const trimmed = note.trim();
  if (!trimmed) throw new SwitchyardError("A progress note must not be empty.");
  const issue = getIssue(db, ref);
  recordEvent(db, { issueId: issue.id, actorId: actor.id, type: "progress_note", payload: { note: trimmed } });
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/services/agent-sessions.test.ts`
Expected: PASS (all cases).

- [ ] **Step 7: Gates, then commit**

Run: `npm run typecheck && npm run build:ui && npx vitest run`
Expected: both tsconfigs clean, UI builds, full suite green.

```bash
git add src/db/schema.ts src/services/agent-sessions.ts tests/services/agent-sessions.test.ts drizzle/
git commit -m "feat: agent_sessions table + lifecycle/progress-note service (SYD-43)"
```

---

### Task 2: REST endpoints

**Files:**
- Modify: `src/rest/schemas.ts` (append near `deliveryEventBody`, ~line 49)
- Modify: `src/rest/api-routes.ts` (imports ~line 15; routes near the delivery-events route, ~line 131)
- Test: `tests/rest/api-agent-sessions.test.ts`

**Interfaces:**
- Consumes: Task 1's service exports.
- Produces: `POST /api/agent-sessions` `{ref, mode, pid?}` → `AgentSessionView`; `PATCH /api/agent-sessions/:id` `{exitCode: number|null}` → `AgentSessionView`; `GET /api/agent-sessions?active=true&ref=SYD-1` → `AgentSessionView[]`; `POST /api/issues/:ref/progress-note` `{note}` → `{ok: true}`.

- [ ] **Step 1: Write the failing REST test**

Create `tests/rest/api-agent-sessions.test.ts` (same harness as `tests/rest/api-delivery-events.test.ts`):

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue } from "../../src/services/issues.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

let db: Db, app: ReturnType<typeof buildApiRoutes>;
let workerH: Record<string, string>, humanH: Record<string, string>;

beforeEach(() => {
  db = openDb(":memory:");
  const worker = createActor(db, { name: "claude/worker", type: "agent" });
  const human = createActor(db, { name: "sean", type: "human" });
  workerH = { authorization: `Bearer ${worker.token}`, "content-type": "application/json" };
  humanH = { authorization: `Bearer ${human.token}`, "content-type": "application/json" };
  createProject(db, { key: "SYD", name: "Switchyard" });
  createIssue(db, worker.actor, {
    projectKey: "SYD", title: "Ship v1", description: "x",
    provenance: { sourceType: "session" },
  });
  app = buildApiRoutes(db);
});

async function body<T>(r: Response): Promise<T> { return (await r.json()) as T; }

async function startSession(): Promise<{ id: number }> {
  return body(await app.request("/agent-sessions", {
    method: "POST", headers: workerH,
    body: JSON.stringify({ ref: "SYD-1", mode: "cli", pid: 4242 }),
  }));
}

describe("POST /agent-sessions", () => {
  it("creates a running session", async () => {
    const res = await app.request("/agent-sessions", {
      method: "POST", headers: workerH,
      body: JSON.stringify({ ref: "SYD-1", mode: "cli", pid: 4242 }),
    });
    expect(res.status).toBe(200);
    const s = await body<Record<string, unknown>>(res);
    expect(s).toMatchObject({ ref: "SYD-1", mode: "cli", pid: 4242, status: "running" });
  });

  it("rejects human actors", async () => {
    const res = await app.request("/agent-sessions", {
      method: "POST", headers: humanH,
      body: JSON.stringify({ ref: "SYD-1", mode: "cli" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown mode", async () => {
    const res = await app.request("/agent-sessions", {
      method: "POST", headers: workerH,
      body: JSON.stringify({ ref: "SYD-1", mode: "carrier-pigeon" }),
    });
    expect(res.status).toBe(400);
  });

  it("requires authentication", async () => {
    const res = await app.request("/agent-sessions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "SYD-1", mode: "cli" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("PATCH /agent-sessions/:id", () => {
  it("ends the session with an exit code", async () => {
    const { id } = await startSession();
    const res = await app.request(`/agent-sessions/${id}`, {
      method: "PATCH", headers: workerH, body: JSON.stringify({ exitCode: 0 }),
    });
    expect(res.status).toBe(200);
    expect(await body<Record<string, unknown>>(res)).toMatchObject({ status: "exited", exitCode: 0 });
  });

  it("404-shapes an unknown id as a SwitchyardError (400)", async () => {
    const res = await app.request("/agent-sessions/999", {
      method: "PATCH", headers: workerH, body: JSON.stringify({ exitCode: 0 }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /agent-sessions", () => {
  it("lists sessions, filterable to active ones and by ref", async () => {
    const { id } = await startSession();
    await startSession().then(({ id: second }) =>
      app.request(`/agent-sessions/${second}`, {
        method: "PATCH", headers: workerH, body: JSON.stringify({ exitCode: 1 }),
      })
    );
    const all = await body<unknown[]>(await app.request("/agent-sessions", { headers: workerH }));
    expect(all.length).toBe(2);
    const active = await body<{ id: number }[]>(
      await app.request("/agent-sessions?active=true&ref=SYD-1", { headers: workerH })
    );
    expect(active.map((s) => s.id)).toEqual([id]);
  });
});

describe("POST /issues/:ref/progress-note", () => {
  it("records a progress_note event onto the activity feed", async () => {
    const res = await app.request("/issues/SYD-1/progress-note", {
      method: "POST", headers: workerH, body: JSON.stringify({ note: "building the UI" }),
    });
    expect(res.status).toBe(200);
    const issue = await body<{ activity: { type: string; payload: Record<string, unknown> }[] }>(
      await app.request("/issues/SYD-1", { headers: workerH })
    );
    expect(issue.activity.find((a) => a.type === "progress_note")?.payload).toEqual({ note: "building the UI" });
  });

  it("rejects an empty note", async () => {
    const res = await app.request("/issues/SYD-1/progress-note", {
      method: "POST", headers: workerH, body: JSON.stringify({ note: "" }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/rest/api-agent-sessions.test.ts`
Expected: FAIL — 404s (routes don't exist yet).

- [ ] **Step 3: Add the zod schemas to `src/rest/schemas.ts`**

Add the import at the top and the schemas after `deliveryEventBody`:

```ts
import { AGENT_SESSION_MODES } from "../services/agent-sessions.js";
```

```ts
export const agentSessionCreateBody = z.object({
  ref: z.string(),
  mode: z.enum(AGENT_SESSION_MODES),
  pid: z.number().int().positive().nullable().optional(),
});
export const agentSessionEndBody = z.object({ exitCode: z.number().int().nullable() });
export const progressNoteBody = z.object({ note: z.string().min(1) });
```

- [ ] **Step 4: Wire the routes in `src/rest/api-routes.ts`**

Add to the service imports:

```ts
import { startAgentSession, endAgentSession, listAgentSessions, recordProgressNote } from "../services/agent-sessions.js";
```

Add `agentSessionCreateBody, agentSessionEndBody, progressNoteBody` to the `./schemas.js` import list. Then add routes after the delivery-events route (~line 134):

```ts
  app.get("/agent-sessions", (c) =>
    c.json(listAgentSessions(db, {
      active: c.req.query("active") === "true" ? true : undefined,
      ref: c.req.query("ref") || undefined,
    }))
  );

  app.post("/agent-sessions", body(agentSessionCreateBody), (c) =>
    c.json(startAgentSession(db, c.var.actor, c.req.valid("json")))
  );

  app.patch("/agent-sessions/:id", body(agentSessionEndBody), (c) =>
    c.json(endAgentSession(db, c.var.actor, Number(c.req.param("id")), c.req.valid("json").exitCode))
  );

  app.post("/issues/:ref/progress-note", body(progressNoteBody), (c) => {
    recordProgressNote(db, c.var.actor, c.req.param("ref"), c.req.valid("json").note);
    return c.json({ ok: true });
  });
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/rest/api-agent-sessions.test.ts`
Expected: PASS.

- [ ] **Step 6: Gates, then commit**

Run: `npm run typecheck && npm run build:ui && npx vitest run`

```bash
git add src/rest/schemas.ts src/rest/api-routes.ts tests/rest/api-agent-sessions.test.ts
git commit -m "feat: REST endpoints for agent sessions + progress notes (SYD-43)"
```

---

### Task 3: MCP `progress_note` tool

**Files:**
- Modify: `src/mcp/server.ts` (import ~line 16; register after the `comment` tool, ~line 205)
- Test: `tests/mcp/write-tools.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `recordProgressNote` from Task 1.
- Produces: MCP tool `progress_note` with `inputSchema: { ref, note }` returning `{ ok: true }`.

- [ ] **Step 1: Write the failing test** (append to `tests/mcp/write-tools.test.ts`; add `import { getActivity } from "../../src/services/comments.js";` to its imports)

```ts
describe("progress_note (SYD-43)", () => {
  it("records a progress_note event on the activity feed", async () => {
    const filed = JSON.parse(text(await client.callTool({
      name: "file_issue",
      arguments: { project_key: "AIPI", title: "T", description: "d", source_type: "session" },
    })));
    const r = await client.callTool({
      name: "progress_note",
      arguments: { ref: filed.ref, note: "tests written, implementing the service" },
    });
    expect(JSON.parse(text(r))).toEqual({ ok: true });
    const ev = getActivity(db, filed.ref).find((a) => a.type === "progress_note");
    expect(ev?.payload).toEqual({ note: "tests written, implementing the service" });
  });

  it("returns an isError result for an empty note", async () => {
    const filed = JSON.parse(text(await client.callTool({
      name: "file_issue",
      arguments: { project_key: "AIPI", title: "T2", description: "d", source_type: "session" },
    })));
    const r = await client.callTool({ name: "progress_note", arguments: { ref: filed.ref, note: " " } });
    expect(r.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/mcp/write-tools.test.ts`
Expected: FAIL — tool `progress_note` not found.

- [ ] **Step 3: Register the tool in `src/mcp/server.ts`**

Add the import:

```ts
import { recordProgressNote } from "../services/agent-sessions.js";
```

Register after the `comment` tool:

```ts
  server.registerTool(
    "progress_note",
    {
      description:
        "Record a one-line note about what you are doing right now on an issue you are working " +
        '(e.g. "tests written, implementing the service"). Shown live in the app while your ' +
        "session runs — call it each time you start a new step so humans can follow along. " +
        "Use comment for anything a human should read later; progress notes are ephemeral status.",
      inputSchema: { ref: z.string(), note: z.string() },
    },
    guard(({ ref, note }: { ref: string; note: string }) => {
      recordProgressNote(db, actor, ref, note);
      return { ok: true };
    })
  );
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mcp/write-tools.test.ts`
Expected: PASS. Note: `tests/mcp/read-tools.test.ts` or docs may assert the tool count ("12 tools") — if a test breaks on tool count, update it to 13.

- [ ] **Step 5: Gates, then commit**

Run: `npm run typecheck && npm run build:ui && npx vitest run`

```bash
git add src/mcp/server.ts tests/mcp/write-tools.test.ts
git commit -m "feat: progress_note MCP tool (SYD-43)"
```

---

### Task 4: Worker lifecycle reporting + prompt convention

**Files:**
- Modify: `scripts/agent-worker.ts` (helpers near `postDeliveryEvent` ~line 154; `buildPrompt` ~line 199; `dispatch` ~line 225; `dispatchSdk` ~line 328)
- Test: `tests/scripts/agent-worker.test.ts` (append)

**Interfaces:**
- Consumes: REST endpoints from Task 2; `withRetry`, `HttpStatusError` already imported from `./worker-select.js` (verify first: `withRetry` must not retry 4xx — see the comment at `scripts/worker-select.ts:570`; if it retries everything, the "returns null" test below will be slow — pass `HttpStatusError` with a 400 either way, which is the documented permanent-failure path).
- Produces: exported `reportSessionStart(config, token, {ref, mode, pid}): Promise<number | null>` and `reportSessionEnd(config, token, sessionId: Promise<number | null>, exitCode: number | null): Promise<void>` — both never throw.

- [ ] **Step 1: Write the failing tests** (append to `tests/scripts/agent-worker.test.ts`; add `reportSessionStart, reportSessionEnd` to the `await import("../../scripts/agent-worker.js")` destructure, and `afterEach` to the vitest import if missing)

```ts
describe("buildPrompt progress-note convention (SYD-43)", () => {
  it("tells the session to record progress notes as it works", () => {
    expect(buildPrompt("SYD-7")).toContain("progress_note");
  });
});

describe("session lifecycle reporting (SYD-43)", () => {
  const config: WorkerConfig = {
    url: "http://localhost:3300",
    label: "auto",
    intervalSeconds: 300,
    maxConcurrent: 2,
    projects: { SYD: { repo: "/repo/syd" } },
  };

  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the session start and resolves the new id", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ id: 12 }), text: async () => "" }));
    vi.stubGlobal("fetch", fetchMock);
    const id = await reportSessionStart(config, "tok", { ref: "SYD-7", mode: "cli", pid: 4242 });
    expect(id).toBe(12);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3300/api/agent-sessions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("resolves null instead of throwing when the server rejects the report", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}), text: async () => "no" }));
    vi.stubGlobal("fetch", fetchMock);
    const id = await reportSessionStart(config, "tok", { ref: "SYD-7", mode: "cli", pid: null });
    expect(id).toBeNull();
    errorSpy.mockRestore();
  });

  it("PATCHes the exit code once the session id resolves", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}), text: async () => "" }));
    vi.stubGlobal("fetch", fetchMock);
    await reportSessionEnd(config, "tok", Promise.resolve(12), 0);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3300/api/agent-sessions/12",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ exitCode: 0 }) }),
    );
  });

  it("skips the PATCH entirely when the start was never recorded", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await reportSessionEnd(config, "tok", Promise.resolve(null), 0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/scripts/agent-worker.test.ts`
Expected: FAIL — `reportSessionStart` is not exported; prompt lacks `progress_note`.

- [ ] **Step 3: Implement the helpers in `scripts/agent-worker.ts`** (below `postDeliveryEvent`)

```ts
/** Session-lifecycle reporting (SYD-43): tells the tracker a session started
 * so the UI can show a live Agents panel. Best-effort — visibility must never
 * break dispatch — so every failure resolves to null after logging. */
export async function reportSessionStart(
  config: WorkerConfig, token: string, input: { ref: string; mode: "cli" | "container" | "sdk"; pid: number | null }
): Promise<number | null> {
  const url = `${config.url.replace(/\/$/, "")}/api/agent-sessions`;
  try {
    return await withRetry(async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        throw new HttpStatusError(res.status, `POST agent-sessions for ${input.ref} failed: ${res.status} ${await res.text()}`);
      }
      return ((await res.json()) as { id: number }).id;
    });
  } catch (err) {
    console.error(`could not report session start for ${input.ref}: ${(err as Error).message}`);
    return null;
  }
}

/** Closes out a session started by reportSessionStart. Takes the id as a
 * promise so callers can wire it straight from the (unawaited) start call;
 * a null id (start never landed) is a silent no-op. Never rejects. */
export async function reportSessionEnd(
  config: WorkerConfig, token: string, sessionId: Promise<number | null>, exitCode: number | null
): Promise<void> {
  const id = await sessionId;
  if (id === null) return;
  const url = `${config.url.replace(/\/$/, "")}/api/agent-sessions/${id}`;
  try {
    await withRetry(async () => {
      const res = await fetch(url, {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ exitCode }),
      });
      if (!res.ok) {
        throw new HttpStatusError(res.status, `PATCH agent-sessions/${id} failed: ${res.status} ${await res.text()}`);
      }
    });
  } catch (err) {
    console.error(`could not report session end ${id}: ${(err as Error).message}`);
  }
}
```

- [ ] **Step 4: Add the prompt line in `buildPrompt`**

In the returned string, after the `claim_issue first.` sentence, add:

```ts
    `Record a one-line note with the progress_note tool each time you start a new ` +
    `step (reading code, writing tests, implementing, verifying) so humans can ` +
    `watch progress live. ` +
```

- [ ] **Step 5: Wire `dispatch()` (CLI/container branch)**

After the existing `active.set(issue.ref, child)` / `console.log` lines, add:

```ts
  // 'spawn' only fires once the OS actually launched the process (see the
  // SYD-74 note in dispatchAnswer) — a failed spawn never creates a session.
  let sessionId: Promise<number | null> = Promise.resolve(null);
  child.on("spawn", () => {
    sessionId = reportSessionStart(config, token, {
      ref: issue.ref,
      mode: config.containerized ? "container" : "cli",
      pid: child.pid ?? null,
    });
  });
```

At the top of the existing `child.on("exit", (code) => {` handler, add:

```ts
    void reportSessionEnd(config, token, sessionId, code);
```

- [ ] **Step 6: Wire `dispatchSdk()`**

After its `active.set(issue.ref, "sdk")` line:

```ts
  const sessionId = reportSessionStart(config, token, { ref: issue.ref, mode: "sdk", pid: null });
```

In its `.then(` success handler add `void reportSessionEnd(config, token, sessionId, code);` and in the failure handler add `void reportSessionEnd(config, token, sessionId, null);`.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/scripts/agent-worker.test.ts`
Expected: PASS (existing buildPrompt tests must still pass — the added sentence must not introduce the word "escalat…" or break them).

- [ ] **Step 8: Gates, then commit**

Run: `npm run typecheck && npm run build:ui && npx vitest run`

```bash
git add scripts/agent-worker.ts tests/scripts/agent-worker.test.ts
git commit -m "feat: worker reports session lifecycle + progress-note prompt convention (SYD-43)"
```

---

### Task 5: UI plumbing — types, api client, router, Shell nav badge

**Files:**
- Modify: `ui/src/types.ts`, `ui/src/api.ts`, `ui/src/router.ts`, `ui/src/Shell.tsx`
- Test: `ui/src/router.test.tsx` (append), `ui/src/Shell.test.tsx` (append)

**Interfaces:**
- Consumes: `GET /api/agent-sessions` from Task 2.
- Produces: `type AgentSession` (mirror of `AgentSessionView`), `listAgentSessions(filters?)` in `api.ts`, route `{ view: "agents" }` at `/agents`, Shell nav link labeled `Agents` with a live-count badge.

- [ ] **Step 1: Write the failing tests**

Append to `ui/src/router.test.tsx` (match its existing describe/it style):

```ts
describe("agents route (SYD-43)", () => {
  it("parses /agents", () => {
    expect(parsePath("/agents")).toEqual({ view: "agents" });
  });
  it("round-trips through href", () => {
    expect(href({ view: "agents" })).toBe("/agents");
  });
});
```

Append to `ui/src/Shell.test.tsx` (reuses its `renderShell`/`navLink` helpers):

```tsx
describe("Shell agents nav (SYD-43)", () => {
  beforeEach(() => {
    localStorage.clear();
    history.replaceState(null, "", "/");
  });

  it("links to /agents and polls the active session count", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => [] } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const container = await renderShell();
      await act(async () => {});
      expect(navLink(container, "Agents").getAttribute("href")).toBe("/agents");
      expect(calls.some((u) => u.startsWith("/api/agent-sessions?active=true"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
```

Run: `npx vitest run ui/src/router.test.tsx ui/src/Shell.test.tsx` — expected: FAIL.

- [ ] **Step 2: Add the type to `ui/src/types.ts`**

```ts
export type AgentSession = {
  id: number; ref: string; issueTitle: string;
  mode: "cli" | "container" | "sdk";
  pid: number | null; status: "running" | "exited"; exitCode: number | null;
  startedAt: number; endedAt: number | null;
  lastNote: { note: string; createdAt: number } | null;
};
```

- [ ] **Step 3: Add the client call to `ui/src/api.ts`** (add `AgentSession` to the type import)

```ts
export const listAgentSessions = (filters: { active?: boolean; ref?: string } = {}) => {
  const q = new URLSearchParams();
  if (filters.active) q.set("active", "true");
  if (filters.ref) q.set("ref", filters.ref);
  const qs = q.toString();
  return api<AgentSession[]>(`/api/agent-sessions${qs ? `?${qs}` : ""}`);
};
```

- [ ] **Step 4: Add the route to `ui/src/router.ts`**

Route union: add `| { view: "agents" }`. In `matchRoute` (before the final `return null`):

```ts
  if (parts[0] === "agents" && parts.length === 1) return { view: "agents" };
```

In `href` (before the final fallback):

```ts
  if (route.view === "agents") return "/agents";
```

- [ ] **Step 5: Add the nav link + badge to `ui/src/Shell.tsx`**

Add `listAgentSessions` to the `./api` import. Inside `Shell`, next to the `inReview` poll:

```tsx
  const liveSessions = usePoll(() => listAgentSessions({ active: true }), [], 15000);
```

In the `<nav>`, after the Review link:

```tsx
          <a href={href({ view: "agents" })} className={route.view === "agents" ? "active" : ""}>
            Agents{liveSessions.data && liveSessions.data.length > 0 && (
              <span className="badge">{liveSessions.data.length}</span>
            )}
          </a>
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run ui/src/router.test.tsx ui/src/Shell.test.tsx`
Expected: PASS (existing Shell tests tolerate the extra failed poll — jsdom fetch errors land in usePoll's error state, which the badge simply doesn't render).

- [ ] **Step 7: Gates, then commit**

Run: `npm run typecheck && npm run build:ui && npx vitest run`

```bash
git add ui/src/types.ts ui/src/api.ts ui/src/router.ts ui/src/Shell.tsx ui/src/router.test.tsx ui/src/Shell.test.tsx
git commit -m "feat: agents route, api client, and nav badge (SYD-43)"
```

---

### Task 6: Agents view

**Files:**
- Create: `ui/src/views/Agents.tsx`
- Modify: `ui/src/App.tsx` (import + render), `ui/src/styles.css` (append)
- Test: `ui/src/views/Agents.test.tsx`

**Interfaces:**
- Consumes: `listAgentSessions` from Task 5.
- Produces: default export `Agents` component; named export `formatElapsed(startedAt: number, endedAt: number | null, nowSeconds?: number): string` (Task 7 imports it).

- [ ] **Step 1: Write the failing test**

Create `ui/src/views/Agents.test.tsx`:

```tsx
// @vitest-environment jsdom
//
// SYD-43: the Agents panel shows live worker sessions (issue ref, elapsed,
// last progress note) split from recently-exited ones.
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AgentSession } from "../types";

vi.mock("../api", () => ({
  listAgentSessions: vi.fn(() => Promise.resolve([])),
}));

import { listAgentSessions } from "../api";
import Agents, { formatElapsed } from "./Agents";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function session(overrides: Partial<AgentSession>): AgentSession {
  return {
    id: 1, ref: "SYD-1", issueTitle: "Ship v1", mode: "cli",
    pid: 4242, status: "running", exitCode: null,
    startedAt: Math.floor(Date.now() / 1000) - 90, endedAt: null, lastNote: null,
    ...overrides,
  };
}

async function renderAgents(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<Agents />); });
  return container;
}

afterEach(() => vi.mocked(listAgentSessions).mockReset());

describe("formatElapsed", () => {
  it("renders seconds, minutes, and hours", () => {
    expect(formatElapsed(1000, 1042)).toBe("42s");
    expect(formatElapsed(1000, 1000 + 7 * 60)).toBe("7m");
    expect(formatElapsed(1000, 1000 + 3600 + 12 * 60)).toBe("1h 12m");
  });
  it("uses now for a still-running session", () => {
    expect(formatElapsed(1000, null, 1090)).toBe("1m");
  });
});

describe("Agents view", () => {
  it("splits running sessions from exited ones and links the ref", async () => {
    vi.mocked(listAgentSessions).mockResolvedValue([
      session({ id: 2, status: "running", lastNote: { note: "writing tests", createdAt: 0 } }),
      session({ id: 1, ref: "SYD-9", status: "exited", exitCode: 0, endedAt: Math.floor(Date.now() / 1000) }),
    ]);
    const container = await renderAgents();
    const text = container.textContent ?? "";
    expect(text).toContain("writing tests");
    expect(text).toContain("SYD-9");
    expect(container.querySelector('a[href="/issue/SYD-1"]')).not.toBeNull();
    const sections = [...container.querySelectorAll("h2")].map((h) => h.textContent);
    expect(sections).toEqual(["Active sessions", "Recent"]);
  });

  it("shows empty states when nothing is running", async () => {
    vi.mocked(listAgentSessions).mockResolvedValue([]);
    const container = await renderAgents();
    expect(container.textContent).toContain("No agent sessions");
  });
});
```

Run: `npx vitest run ui/src/views/Agents.test.tsx` — expected: FAIL (module doesn't exist).

- [ ] **Step 2: Implement `ui/src/views/Agents.tsx`**

```tsx
import { listAgentSessions } from "../api";
import { usePoll } from "../usePoll";
import { PollErrorBar } from "../PollErrorBar";
import { href } from "../router";
import type { AgentSession } from "../types";

// Exported for the issue-detail live strip (SYD-43). "42s", "7m", "1h 12m".
export function formatElapsed(
  startedAt: number,
  endedAt: number | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const secs = Math.max(0, (endedAt ?? nowSeconds) - startedAt);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

function SessionRow({ s }: { s: AgentSession }) {
  const elapsed = formatElapsed(s.startedAt, s.endedAt);
  return (
    <li className="session-row panel">
      <a className="ref" href={href({ view: "issue", ref: s.ref })}>{s.ref}</a>{" "}
      {s.issueTitle}
      <span className="badge">{s.mode}</span>
      {s.status === "running"
        ? <span className="badge session-live">live · {elapsed}</span>
        : <span className="badge">exit {s.exitCode ?? "?"} · ran {elapsed}</span>}
      {s.lastNote && <span className="session-note">“{s.lastNote.note}”</span>}
    </li>
  );
}

// The Agents panel (SYD-43): live worker sessions, then recently-exited ones.
// One unfiltered poll, split client-side — the nav badge (Shell) uses the
// server's active filter, which also drops zombie sessions; here a zombie
// showing hours of "live" elapsed is itself useful signal.
export default function Agents() {
  const { data, error } = usePoll(() => listAgentSessions(), []);
  if (error && !data) return <p className="error-bar">{error}</p>;
  if (!data) return <p>Loading…</p>;
  const running = data.filter((s) => s.status === "running");
  const exited = data.filter((s) => s.status === "exited");
  return (
    <section className="agents">
      <PollErrorBar error={error} />
      <h2>Active sessions</h2>
      {running.length === 0 && <p className="empty">No agent sessions running.</p>}
      {running.length > 0 && <ul className="session-list">{running.map((s) => <SessionRow key={s.id} s={s} />)}</ul>}
      <h2>Recent</h2>
      {exited.length === 0 && <p className="empty">No finished sessions yet.</p>}
      {exited.length > 0 && <ul className="session-list">{exited.map((s) => <SessionRow key={s.id} s={s} />)}</ul>}
    </section>
  );
}
```

- [ ] **Step 3: Wire it into `ui/src/App.tsx`**

Add `import Agents from "./views/Agents";` and, in `ShellRouter`'s children:

```tsx
      {route.view === "agents" && <Agents />}
```

- [ ] **Step 4: Append styles to `ui/src/styles.css`** (match existing class idioms; adjust only if the names collide)

```css
/* Agents panel (SYD-43) */
.session-list { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.session-row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.session-live { background: #1a7f37; color: #fff; }
.session-note { font-style: italic; opacity: 0.8; }
.agent-session-strip { display: flex; flex-direction: column; gap: 0.25rem; }
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run ui/src/views/Agents.test.tsx`
Expected: PASS.

- [ ] **Step 6: Gates, then commit**

Run: `npm run typecheck && npm run build:ui && npx vitest run`

```bash
git add ui/src/views/Agents.tsx ui/src/views/Agents.test.tsx ui/src/App.tsx ui/src/styles.css
git commit -m "feat: Agents panel view (SYD-43)"
```

---

### Task 7: Issue-detail live strip + progress_note activity rendering

**Files:**
- Modify: `ui/src/views/IssueDetail.tsx` (new `AgentSessionStrip` component; a `progress_note` case in `Event`; render the strip after `DeliveryStrip`, ~line 233)
- Test: `ui/src/views/IssueDetail.test.tsx` (append; also add `listAgentSessions: vi.fn(() => Promise.resolve([]))` to its existing `vi.mock("../api", ...)` factory — and to any other view test whose mock factory the new import breaks)

**Interfaces:**
- Consumes: `listAgentSessions` (Task 5), `formatElapsed` (Task 6).
- Produces: exported `AgentSessionStrip({ refId })` component.

- [ ] **Step 1: Write the failing tests** (append to `ui/src/views/IssueDetail.test.tsx`, following its existing render helpers; the exact mount helper may differ — reuse whatever the file already uses to render components)

```tsx
describe("progress_note activity rendering (SYD-43)", () => {
  it("renders the note text as a status line", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <Event
          ev={{ type: "progress_note", actorName: "claude/worker", payload: { note: "compiling" }, createdAt: 0 }}
          projectKey="SYD"
        />
      );
    });
    expect(container.textContent).toContain("compiling");
    expect(container.querySelector(".progress-note")).not.toBeNull();
  });
});

describe("AgentSessionStrip (SYD-43)", () => {
  it("shows a live line per active session with the last note", async () => {
    vi.mocked(listAgentSessions).mockResolvedValue([{
      id: 1, ref: "SYD-1", issueTitle: "Ship v1", mode: "container",
      pid: null, status: "running", exitCode: null,
      startedAt: Math.floor(Date.now() / 1000) - 300, endedAt: null,
      lastNote: { note: "running the tests", createdAt: 0 },
    }]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(<AgentSessionStrip refId="SYD-1" />); });
    expect(container.textContent).toContain("running the tests");
    expect(container.textContent).toMatch(/5m/);
  });

  it("renders nothing when no session is active", async () => {
    vi.mocked(listAgentSessions).mockResolvedValue([]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(<AgentSessionStrip refId="SYD-1" />); });
    expect(container.textContent).toBe("");
  });
});
```

(Adjust imports at the top of the test file: `Event` and `AgentSessionStrip` from `./IssueDetail`, `listAgentSessions` from `../api`.)

Run: `npx vitest run ui/src/views/IssueDetail.test.tsx` — expected: FAIL.

- [ ] **Step 2: Implement in `ui/src/views/IssueDetail.tsx`**

Add to imports: `listAgentSessions` from `../api`, `formatElapsed` from `./Agents`, `usePoll` is already imported. Add the component near `DeliveryStrip`:

```tsx
/** Live agent-session strip (SYD-43): while the dispatch worker has a session
 * running on this issue, show liveness + the session's latest progress note.
 * Server-side `active` filtering also hides zombie sessions a dead worker
 * never closed out. */
export function AgentSessionStrip({ refId }: { refId: string }) {
  const { data } = usePoll(() => listAgentSessions({ ref: refId, active: true }), [refId]);
  if (!data || data.length === 0) return null;
  return (
    <div className="agent-session-strip panel">
      {data.map((s) => (
        <span key={s.id}>
          🤖 agent session running ({s.mode}) · {formatElapsed(s.startedAt, null)} elapsed
          {s.lastNote && <> · <em>{s.lastNote.note}</em></>}
        </span>
      ))}
    </div>
  );
}
```

Render it in `IssueDetail`'s JSX directly after `{delivery && <DeliveryStrip status={delivery} />}`:

```tsx
      <AgentSessionStrip refId={refId} />
```

Add the `Event` case (before the `attachment_added` case):

```tsx
  if (ev.type === "progress_note") {
    return (
      <p className="event progress-note">
        <strong>{ev.actorName}</strong> ⏱ {String(ev.payload.note ?? "")} <time>{when}</time>
      </p>
    );
  }
```

- [ ] **Step 3: Run the tests — including the other view suites whose `vi.mock("../api")` factories now need the extra export**

Run: `npx vitest run ui/src/views/`
Expected: PASS. If `Review.test.tsx`/`Triage.test.tsx`/`Board.test.tsx` fail with `listAgentSessions is not a function`, add `listAgentSessions: vi.fn(() => Promise.resolve([]))` to their mock factories.

- [ ] **Step 4: Gates, then commit**

Run: `npm run typecheck && npm run build:ui && npx vitest run`

```bash
git add ui/src/views/IssueDetail.tsx ui/src/views/IssueDetail.test.tsx ui/src/views/Agents.tsx
git commit -m "feat: live agent-session strip + progress_note rendering on issue detail (SYD-43)"
```

(Only stage other view test files too if Step 3 required touching them.)

---

### Task 8: Full verification + board handoff

- [ ] **Step 1: Full gates one final time**

Run: `npm run typecheck && npm run build:ui && npx vitest run`
Expected: everything green. Paste the tail of each command's output as evidence.

- [ ] **Step 2: End-to-end smoke** (use the `verify` skill if executing interactively)

```bash
SWITCHYARD_DB=$TMPDIR/syd-43-smoke.db PORT=3311 npm run dev &
# then, with a minted agent token via: npx tsx src/cli.ts $TMPDIR/syd-43-smoke.db add-project SYD Switchyard
#                                      npx tsx src/cli.ts $TMPDIR/syd-43-smoke.db add-actor claude/worker agent
curl -s -X POST localhost:3311/api/issues -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{"projectKey":"SYD","title":"smoke","provenance":{"sourceType":"session"}}'
curl -s -X POST localhost:3311/api/agent-sessions -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{"ref":"SYD-1","mode":"cli","pid":123}'
curl -s -X POST localhost:3311/api/issues/SYD-1/progress-note -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{"note":"smoke note"}'
curl -s "localhost:3311/api/agent-sessions?active=true"   # expect: one session, lastNote "smoke note"
```

Then load `/agents` in the browser (or `npm run dev:ui`) and confirm the panel renders the live session and the SYD-1 issue page shows the strip. Kill the dev server after.

- [ ] **Step 3: Update the board and hand off**

- Comment on SYD-43 (via `mcp__switchyard__comment`) with what was built and the verification evidence (test run results + smoke output).
- Push the branch, open a PR titled `feat: agent progress visibility — sessions panel + live strip (SYD-43)`.
- Move SYD-43 to `in_review` (via `mcp__switchyard__update_issue`) — never `done`; a human stamps that.
