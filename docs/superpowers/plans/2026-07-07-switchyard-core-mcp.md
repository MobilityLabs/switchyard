# Switchyard Core Engine + MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Switchyard service layer (actors, projects, issues, triage gate, dependencies, events) and an MCP server over streamable HTTP, so a Claude Code session can run the full issue loop end to end.

**Architecture:** One TypeScript service. SQLite (better-sqlite3) with Drizzle schema; issue current-state lives in tables, every mutation also appends to an immutable `events` table. Pure service functions take a `Db` handle. The MCP server is a thin adapter over the service layer, authenticated per-request by agent/human bearer tokens. HTTP entry routes `POST /mcp` to the MCP transport.

**Tech Stack:** Node 22+, TypeScript 5, Hono 4 + @hono/node-server, drizzle-orm + drizzle-kit + better-sqlite3, @modelcontextprotocol/sdk (1.x), zod 3, vitest.

**This is Plan 1 of 3.** Plan 2: REST API + magic-link auth + webhooks. Plan 3: React web UI (triage inbox, board, issue detail) + Docker/Tailscale deploy.

## Global Constraints

- Statuses (exact strings, this order): `triage`, `backlog`, `todo`, `in_progress`, `in_review`, `done`, `canceled`.
- Priorities: `none`, `low`, `medium`, `high`, `urgent`.
- Issue refs are `<PROJECT_KEY>-<number>`, e.g. `AIPI-42`. Project keys are 2–10 uppercase letters.
- Agent-created issues MUST start in `triage` and MUST carry provenance. Human-created issues default to `backlog`.
- Every mutation appends a row to `events` in the same transaction. Events are never updated or deleted.
- Errors thrown across the MCP boundary must be agent-legible instructions, never stack traces.
- Tests run against real SQLite `:memory:` databases — no mocking the DB.
- Service functions are permissive about who does what (conventions live in MCP tool descriptions); they always record which actor acted.
- Commit after every task at minimum; steps marked Commit are mandatory.

---

### Task 1: Scaffold, schema, and database opener

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `drizzle.config.ts`, `.gitignore`
- Create: `src/db/schema.ts`, `src/db/index.ts`
- Test: `tests/db/open.test.ts`

**Interfaces:**
- Produces: `openDb(path: string): Db` from `src/db/index.ts`; `Db` type alias; all table objects (`actors`, `projects`, `issues`, `dependencies`, `events`) and const arrays `STATUSES`, `PRIORITIES` from `src/db/schema.ts`. Every later task consumes these.

- [ ] **Step 1: Scaffold the project**

```bash
cd /Users/sean/sites/switchyard
npm init -y
npm i hono @hono/node-server drizzle-orm better-sqlite3 @modelcontextprotocol/sdk zod@^3
npm i -D typescript tsx vitest drizzle-kit @types/better-sqlite3 @types/node
```

Write `package.json` fields (merge into the generated file):

```json
{
  "name": "switchyard",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx src/server.ts",
    "test": "vitest run",
    "db:generate": "drizzle-kit generate"
  }
}
```

Write `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

Write `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });
```

Write `drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
```

Write `.gitignore`:

```
node_modules/
*.db
*.db-*
```

- [ ] **Step 2: Write the failing test**

`tests/db/open.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { sql } from "drizzle-orm";

describe("openDb", () => {
  it("opens an in-memory db with all tables migrated", () => {
    const db = openDb(":memory:");
    const rows = db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    );
    const names = rows.map((r) => r.name);
    for (const t of ["actors", "projects", "issues", "dependencies", "events"]) {
      expect(names).toContain(t);
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/db/open.test.ts`
Expected: FAIL — cannot find module `src/db/index.js`.

- [ ] **Step 4: Write the schema**

`src/db/schema.ts`:

```ts
import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const STATUSES = [
  "triage", "backlog", "todo", "in_progress", "in_review", "done", "canceled",
] as const;
export type Status = (typeof STATUSES)[number];

export const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

const now = () => sql`(unixepoch())`;

export const actors = sqliteTable("actors", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  type: text("type", { enum: ["human", "agent"] }).notNull(),
  tokenHash: text("token_hash"),
  createdAt: integer("created_at").notNull().default(now()),
});

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  nextIssueNumber: integer("next_issue_number").notNull().default(1),
  createdAt: integer("created_at").notNull().default(now()),
});

export const issues = sqliteTable("issues", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull().references(() => projects.id),
  number: integer("number").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: text("status", { enum: STATUSES }).notNull(),
  priority: text("priority", { enum: PRIORITIES }).notNull().default("none"),
  assigneeId: integer("assignee_id").references(() => actors.id),
  creatorId: integer("creator_id").notNull().references(() => actors.id),
  parentId: integer("parent_id"),
  labels: text("labels", { mode: "json" }).$type<string[]>().notNull().default([]),
  sourceType: text("source_type", { enum: ["session", "todo", "ci", "manual"] }),
  sourceDetail: text("source_detail"),
  sourceUrl: text("source_url"),
  createdAt: integer("created_at").notNull().default(now()),
  updatedAt: integer("updated_at").notNull().default(now()),
});

export const dependencies = sqliteTable(
  "dependencies",
  {
    blockerId: integer("blocker_id").notNull().references(() => issues.id),
    blockedId: integer("blocked_id").notNull().references(() => issues.id),
  },
  (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] })]
);

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  issueId: integer("issue_id").notNull().references(() => issues.id),
  actorId: integer("actor_id").notNull().references(() => actors.id),
  type: text("type").notNull(),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  createdAt: integer("created_at").notNull().default(now()),
});
```

- [ ] **Step 5: Generate the migration**

Run: `npx drizzle-kit generate`
Expected: a SQL file appears under `drizzle/`. Commit this folder — `openDb` replays it.

- [ ] **Step 6: Write the opener**

`src/db/index.ts`:

```ts
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "../../drizzle"
);

export function openDb(dbPath: string): Db {
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return db;
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run tests/db/open.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: scaffold project with drizzle schema and migrated sqlite opener"
```

---

### Task 2: Errors and actor service

**Files:**
- Create: `src/services/errors.ts`, `src/services/actors.ts`
- Test: `tests/services/actors.test.ts`

**Interfaces:**
- Consumes: `openDb`, `Db`, `actors` table (Task 1).
- Produces: `SwitchyardError` (class, `message` is agent-legible) from `errors.ts`. From `actors.ts`: `type Actor = { id: number; name: string; type: "human" | "agent" }`; `createActor(db, input: { name: string; type: "human" | "agent" }): { actor: Actor; token: string }`; `authenticate(db, token: string): Actor | null`.

- [ ] **Step 1: Write the failing test**

`tests/services/actors.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor, authenticate } from "../../src/services/actors.js";

describe("actors", () => {
  it("creates an actor and returns a usable token exactly once", () => {
    const db = openDb(":memory:");
    const { actor, token } = createActor(db, { name: "claude/aipi-worker", type: "agent" });
    expect(actor.id).toBeGreaterThan(0);
    expect(token).toMatch(/^syd_[0-9a-f]{48}$/);
    expect(authenticate(db, token)?.name).toBe("claude/aipi-worker");
    expect(authenticate(db, "syd_" + "0".repeat(48))).toBeNull();
  });

  it("rejects duplicate names with an agent-legible error", () => {
    const db = openDb(":memory:");
    createActor(db, { name: "sean", type: "human" });
    expect(() => createActor(db, { name: "sean", type: "human" }))
      .toThrowError(/actor named "sean" already exists/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/actors.test.ts`
Expected: FAIL — cannot find module `src/services/actors.js`.

- [ ] **Step 3: Write the implementation**

`src/services/errors.ts`:

```ts
export class SwitchyardError extends Error {}
```

`src/services/actors.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { actors } from "../db/schema.js";
import { SwitchyardError } from "./errors.js";

export type Actor = { id: number; name: string; type: "human" | "agent" };

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export function createActor(
  db: Db,
  input: { name: string; type: "human" | "agent" }
): { actor: Actor; token: string } {
  const existing = db.select().from(actors).where(eq(actors.name, input.name)).get();
  if (existing) {
    throw new SwitchyardError(
      `An actor named "${input.name}" already exists — pick a different name or use the existing actor's token.`
    );
  }
  const token = "syd_" + randomBytes(24).toString("hex");
  const row = db
    .insert(actors)
    .values({ name: input.name, type: input.type, tokenHash: hash(token) })
    .returning()
    .get();
  return { actor: { id: row.id, name: row.name, type: row.type }, token };
}

export function authenticate(db: Db, token: string): Actor | null {
  const row = db.select().from(actors).where(eq(actors.tokenHash, hash(token))).get();
  return row ? { id: row.id, name: row.name, type: row.type } : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/services/actors.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: actor service with token mint and authenticate"
```

---

### Task 3: Project service

**Files:**
- Create: `src/services/projects.ts`
- Test: `tests/services/projects.test.ts`

**Interfaces:**
- Consumes: `Db`, `projects` table (Task 1); `SwitchyardError` (Task 2).
- Produces: `type Project = typeof projects.$inferSelect`; `createProject(db, input: { key: string; name: string }): Project`; `listProjects(db): Project[]`; `getProjectByKey(db, key: string): Project` (throws if missing); `reserveIssueNumber(db, projectId: number): number` (increments and returns the next number atomically).

- [ ] **Step 1: Write the failing test**

`tests/services/projects.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import {
  createProject, listProjects, getProjectByKey, reserveIssueNumber,
} from "../../src/services/projects.js";

describe("projects", () => {
  it("creates, lists, and fetches by key", () => {
    const db = openDb(":memory:");
    const p = createProject(db, { key: "AIPI", name: "aipi benchmarking" });
    expect(p.key).toBe("AIPI");
    expect(listProjects(db).map((x) => x.key)).toEqual(["AIPI"]);
    expect(getProjectByKey(db, "AIPI").id).toBe(p.id);
    expect(() => getProjectByKey(db, "NOPE")).toThrowError(/no project with key "NOPE"/i);
  });

  it("rejects malformed keys", () => {
    const db = openDb(":memory:");
    expect(() => createProject(db, { key: "bad key", name: "x" }))
      .toThrowError(/2–10 uppercase letters/);
  });

  it("hands out sequential issue numbers", () => {
    const db = openDb(":memory:");
    const p = createProject(db, { key: "HAND", name: "housing atlas" });
    expect(reserveIssueNumber(db, p.id)).toBe(1);
    expect(reserveIssueNumber(db, p.id)).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/projects.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

`src/services/projects.ts`:

```ts
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { projects } from "../db/schema.js";
import { SwitchyardError } from "./errors.js";

export type Project = typeof projects.$inferSelect;

export function createProject(db: Db, input: { key: string; name: string }): Project {
  if (!/^[A-Z]{2,10}$/.test(input.key)) {
    throw new SwitchyardError(
      `Project key "${input.key}" is invalid — use 2–10 uppercase letters, e.g. "AIPI".`
    );
  }
  return db.insert(projects).values(input).returning().get();
}

export function listProjects(db: Db): Project[] {
  return db.select().from(projects).all();
}

export function getProjectByKey(db: Db, key: string): Project {
  const p = db.select().from(projects).where(eq(projects.key, key)).get();
  if (!p) {
    throw new SwitchyardError(
      `There is no project with key "${key}" — call list_projects to see valid keys.`
    );
  }
  return p;
}

export function reserveIssueNumber(db: Db, projectId: number): number {
  const row = db
    .update(projects)
    .set({ nextIssueNumber: sql`${projects.nextIssueNumber} + 1` })
    .where(eq(projects.id, projectId))
    .returning({ next: projects.nextIssueNumber })
    .get();
  if (!row) throw new SwitchyardError(`Project ${projectId} not found.`);
  return row.next - 1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/services/projects.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: project service with key validation and issue numbering"
```

---

### Task 4: Issue creation with the triage gate, and getIssue

**Files:**
- Create: `src/services/events.ts`, `src/services/issues.ts`
- Test: `tests/services/issues-create.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 (`Db`, tables, `Actor`, `SwitchyardError`, `getProjectByKey`, `reserveIssueNumber`).
- Produces:
  - `events.ts`: `recordEvent(db, e: { issueId: number; actorId: number; type: string; payload?: Record<string, unknown> }): void`; `listIssueEvents(db, issueId: number)` returning rows joined with actor name: `{ id, type, payload, createdAt, actorName }[]`.
  - `issues.ts`: `type Provenance = { sourceType: "session" | "todo" | "ci" | "manual"; detail?: string; url?: string }`; `type CreateIssueInput = { projectKey: string; title: string; description?: string; priority?: Priority; labels?: string[]; parentRef?: string; provenance?: Provenance }`; `type IssueView = typeof issues.$inferSelect & { ref: string }`; `createIssue(db, actor: Actor, input: CreateIssueInput): IssueView`; `getIssue(db, ref: string): IssueView`; `parseRef(ref: string): { key: string; number: number }`; `toView(db, row): IssueView` (internal helper, also used by Tasks 5–8).

- [ ] **Step 1: Write the failing test**

`tests/services/issues-create.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, getIssue } from "../../src/services/issues.js";
import { listIssueEvents } from "../../src/services/events.js";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, { key: "AIPI", name: "aipi" });
});

describe("createIssue", () => {
  it("human-created issues land in backlog with a ref and a created event", () => {
    const issue = createIssue(db, human, { projectKey: "AIPI", title: "Ship v1" });
    expect(issue.ref).toBe("AIPI-1");
    expect(issue.status).toBe("backlog");
    const ev = listIssueEvents(db, issue.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: "created", actorName: "sean" });
  });

  it("agent-created issues require provenance and land in triage", () => {
    expect(() => createIssue(db, agent, { projectKey: "AIPI", title: "Flaky test" }))
      .toThrowError(/provenance/i);
    const issue = createIssue(db, agent, {
      projectKey: "AIPI",
      title: "Flaky test in api suite",
      provenance: { sourceType: "todo", detail: "src/api.ts:88" },
    });
    expect(issue.status).toBe("triage");
    expect(issue.sourceType).toBe("todo");
  });

  it("getIssue round-trips by ref and rejects unknown refs legibly", () => {
    createIssue(db, human, { projectKey: "AIPI", title: "One" });
    expect(getIssue(db, "AIPI-1").title).toBe("One");
    expect(() => getIssue(db, "AIPI-99")).toThrowError(/AIPI-99 does not exist/);
    expect(() => getIssue(db, "banana")).toThrowError(/like "AIPI-42"/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/issues-create.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

`src/services/events.ts`:

```ts
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { events, actors } from "../db/schema.js";

export function recordEvent(
  db: Db,
  e: { issueId: number; actorId: number; type: string; payload?: Record<string, unknown> }
): void {
  db.insert(events)
    .values({ issueId: e.issueId, actorId: e.actorId, type: e.type, payload: e.payload ?? {} })
    .run();
}

export function listIssueEvents(db: Db, issueId: number) {
  return db
    .select({
      id: events.id,
      type: events.type,
      payload: events.payload,
      createdAt: events.createdAt,
      actorName: actors.name,
    })
    .from(events)
    .innerJoin(actors, eq(events.actorId, actors.id))
    .where(eq(events.issueId, issueId))
    .orderBy(asc(events.id))
    .all();
}
```

`src/services/issues.ts`:

```ts
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { issues, projects, type Priority } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { getProjectByKey, reserveIssueNumber } from "./projects.js";
import { recordEvent } from "./events.js";

export type Provenance = {
  sourceType: "session" | "todo" | "ci" | "manual";
  detail?: string;
  url?: string;
};

export type CreateIssueInput = {
  projectKey: string;
  title: string;
  description?: string;
  priority?: Priority;
  labels?: string[];
  parentRef?: string;
  provenance?: Provenance;
};

export type IssueView = typeof issues.$inferSelect & { ref: string };

export function parseRef(ref: string): { key: string; number: number } {
  const m = /^([A-Z]{2,10})-(\d+)$/.exec(ref);
  if (!m) {
    throw new SwitchyardError(
      `"${ref}" is not an issue ref — use the form <PROJECT_KEY>-<number>, like "AIPI-42".`
    );
  }
  return { key: m[1], number: Number(m[2]) };
}

export function toView(db: Db, row: typeof issues.$inferSelect): IssueView {
  const project = db.select().from(projects).where(eq(projects.id, row.projectId)).get()!;
  return { ...row, ref: `${project.key}-${row.number}` };
}

export function getIssue(db: Db, ref: string): IssueView {
  const { key, number } = parseRef(ref);
  const project = getProjectByKey(db, key);
  const row = db
    .select()
    .from(issues)
    .where(and(eq(issues.projectId, project.id), eq(issues.number, number)))
    .get();
  if (!row) {
    throw new SwitchyardError(
      `Issue ${ref} does not exist — call search_issues to find valid issues.`
    );
  }
  return toView(db, row);
}

export function createIssue(db: Db, actor: Actor, input: CreateIssueInput): IssueView {
  if (actor.type === "agent" && !input.provenance) {
    throw new SwitchyardError(
      "Agent-created issues require provenance — pass sourceType " +
        '("session" | "todo" | "ci" | "manual") plus a detail (e.g. "src/api.ts:88" or a session id) or url.'
    );
  }
  return db.transaction((tx) => {
    const project = getProjectByKey(tx as Db, input.projectKey);
    const number = reserveIssueNumber(tx as Db, project.id);
    const parentId = input.parentRef ? getIssue(tx as Db, input.parentRef).id : null;
    const row = tx
      .insert(issues)
      .values({
        projectId: project.id,
        number,
        title: input.title,
        description: input.description ?? "",
        status: actor.type === "agent" ? "triage" : "backlog",
        priority: input.priority ?? "none",
        labels: input.labels ?? [],
        creatorId: actor.id,
        parentId,
        sourceType: input.provenance?.sourceType ?? null,
        sourceDetail: input.provenance?.detail ?? null,
        sourceUrl: input.provenance?.url ?? null,
      })
      .returning()
      .get();
    recordEvent(tx as Db, { issueId: row.id, actorId: actor.id, type: "created" });
    return toView(tx as Db, row);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/services/issues-create.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: issue creation with triage gate, provenance, and event log"
```

---

### Task 5: Issue update and claim

**Files:**
- Modify: `src/services/issues.ts` (append functions)
- Test: `tests/services/issues-update.test.ts`

**Interfaces:**
- Consumes: Task 4 (`getIssue`, `toView`, `recordEvent`), Task 1 (`STATUSES`, `PRIORITIES`).
- Produces (from `issues.ts`): `type UpdateIssueInput = { status?: Status; priority?: Priority; title?: string; description?: string; assigneeName?: string | null; labels?: string[] }`; `updateIssue(db, actor: Actor, ref: string, patch: UpdateIssueInput): IssueView`; `claimIssue(db, actor: Actor, ref: string): IssueView`. `claimIssue` throws `SwitchyardError` when the issue has an unresolved blocker (Task 6 wires the check via `getOpenBlockers`; until Task 6 lands, `claimIssue` calls a local placeholder `getOpenBlockers` defined in `issues.ts` that returns `[]` — Task 6 replaces it).

- [ ] **Step 1: Write the failing test**

`tests/services/issues-update.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue, getIssue } from "../../src/services/issues.js";
import { listIssueEvents } from "../../src/services/events.js";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, { key: "AIPI", name: "aipi" });
  createIssue(db, human, { projectKey: "AIPI", title: "Ship v1" });
});

describe("updateIssue", () => {
  it("applies field changes and records one event per changed field", () => {
    const updated = updateIssue(db, human, "AIPI-1", {
      status: "todo",
      priority: "high",
      assigneeName: "claude/worker",
    });
    expect(updated.status).toBe("todo");
    expect(updated.priority).toBe("high");
    expect(updated.assigneeId).toBe(agent.id);
    const types = listIssueEvents(db, updated.id).map((e) => e.type);
    expect(types).toEqual(["created", "status_changed", "priority_changed", "assigned"]);
  });

  it("rejects unknown statuses and assignees legibly", () => {
    expect(() => updateIssue(db, human, "AIPI-1", { status: "doing" as never }))
      .toThrowError(/valid statuses/i);
    expect(() => updateIssue(db, human, "AIPI-1", { assigneeName: "ghost" }))
      .toThrowError(/no actor named "ghost"/i);
  });
});

describe("claimIssue", () => {
  it("assigns the caller and moves to in_progress", () => {
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    const claimed = claimIssue(db, agent, "AIPI-1");
    expect(claimed.assigneeId).toBe(agent.id);
    expect(claimed.status).toBe("in_progress");
    expect(getIssue(db, "AIPI-1").status).toBe("in_progress");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/issues-update.test.ts`
Expected: FAIL — `updateIssue` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/services/issues.ts` (the extended schema import line is given after the code):

```ts
export type UpdateIssueInput = {
  status?: Status;
  priority?: Priority;
  title?: string;
  description?: string;
  assigneeName?: string | null;
  labels?: string[];
};

// Replaced by the real implementation in dependencies.ts in Task 6.
export let getOpenBlockers = (_db: Db, _issueId: number): IssueView[] => [];
export function _setGetOpenBlockers(fn: typeof getOpenBlockers) {
  getOpenBlockers = fn;
}

export function updateIssue(db: Db, actor: Actor, ref: string, patch: UpdateIssueInput): IssueView {
  return db.transaction((tx) => {
    const current = getIssue(tx as Db, ref);
    const changes: Partial<typeof issues.$inferInsert> = {};
    const toRecord: { type: string; payload: Record<string, unknown> }[] = [];

    if (patch.status !== undefined && patch.status !== current.status) {
      if (!STATUSES.includes(patch.status)) {
        throw new SwitchyardError(
          `"${patch.status}" is not a status — valid statuses are: ${STATUSES.join(", ")}.`
        );
      }
      changes.status = patch.status;
      toRecord.push({ type: "status_changed", payload: { from: current.status, to: patch.status } });
    }
    if (patch.priority !== undefined && patch.priority !== current.priority) {
      changes.priority = patch.priority;
      toRecord.push({ type: "priority_changed", payload: { from: current.priority, to: patch.priority } });
    }
    if (patch.title !== undefined && patch.title !== current.title) {
      changes.title = patch.title;
      toRecord.push({ type: "title_changed", payload: { from: current.title, to: patch.title } });
    }
    if (patch.description !== undefined && patch.description !== current.description) {
      changes.description = patch.description;
      toRecord.push({ type: "description_changed", payload: {} });
    }
    if (patch.labels !== undefined) {
      changes.labels = patch.labels;
      toRecord.push({ type: "labels_changed", payload: { to: patch.labels } });
    }
    if (patch.assigneeName !== undefined) {
      let assigneeId: number | null = null;
      if (patch.assigneeName !== null) {
        const a = tx.select().from(actorsTable).where(eq(actorsTable.name, patch.assigneeName)).get();
        if (!a) {
          throw new SwitchyardError(
            `There is no actor named "${patch.assigneeName}" — check the name and try again.`
          );
        }
        assigneeId = a.id;
      }
      if (assigneeId !== current.assigneeId) {
        changes.assigneeId = assigneeId;
        toRecord.push({ type: "assigned", payload: { to: patch.assigneeName } });
      }
    }

    if (Object.keys(changes).length === 0) return current;
    changes.updatedAt = Math.floor(Date.now() / 1000);
    const row = tx.update(issues).set(changes).where(eq(issues.id, current.id)).returning().get();
    for (const e of toRecord) {
      recordEvent(tx as Db, { issueId: current.id, actorId: actor.id, ...e });
    }
    return toView(tx as Db, row);
  });
}

export function claimIssue(db: Db, actor: Actor, ref: string): IssueView {
  const current = getIssue(db, ref);
  const blockers = getOpenBlockers(db, current.id);
  if (blockers.length > 0) {
    throw new SwitchyardError(
      `${ref} is blocked by ${blockers.map((b) => b.ref).join(", ")} — resolve the blocker first, or call next_task for another issue.`
    );
  }
  return updateIssue(db, actor, ref, { status: "in_progress", assigneeName: actor.name });
}
```

Also extend the top-of-file imports in `issues.ts`:

```ts
import { issues, projects, actors as actorsTable, STATUSES, type Status, type Priority } from "../db/schema.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/services/issues-update.test.ts`
Expected: PASS (3 tests). Also run `npx vitest run` — all prior tests still pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: issue update and claim with per-field events"
```

---

### Task 6: Dependencies and next_task

**Files:**
- Create: `src/services/dependencies.ts`
- Test: `tests/services/dependencies.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5. Calls `_setGetOpenBlockers` (Task 5) at module load so `claimIssue` enforces blocking for real.
- Produces (from `dependencies.ts`): `addDependency(db, actor: Actor, blockerRef: string, blockedRef: string): void`; `getOpenBlockers(db, issueId: number): IssueView[]` (blockers whose status is not `done`/`canceled`); `nextTask(db, actor: Actor, projectKey?: string): IssueView | null` — highest-priority `todo` issue that is assigned to `actor` or unassigned and has no open blockers; priority order urgent→none, ties broken by oldest `createdAt`.

- [ ] **Step 1: Write the failing test**

`tests/services/dependencies.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue } from "../../src/services/issues.js";
import { addDependency, getOpenBlockers, nextTask } from "../../src/services/dependencies.js";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, { key: "AIPI", name: "aipi" });
  createIssue(db, human, { projectKey: "AIPI", title: "Schema", priority: "high" });   // AIPI-1
  createIssue(db, human, { projectKey: "AIPI", title: "API", priority: "urgent" });    // AIPI-2
  createIssue(db, human, { projectKey: "AIPI", title: "Docs", priority: "low" });      // AIPI-3
  for (const ref of ["AIPI-1", "AIPI-2", "AIPI-3"]) updateIssue(db, human, ref, { status: "todo" });
});

describe("dependencies", () => {
  it("blocked issues cannot be claimed until the blocker is done", () => {
    addDependency(db, human, "AIPI-1", "AIPI-2"); // schema blocks api
    expect(getOpenBlockers(db, 2).map((b) => b.ref)).toEqual(["AIPI-1"]);
    expect(() => claimIssue(db, agent, "AIPI-2"))
      .toThrowError(/blocked by AIPI-1.*next_task/s);
    updateIssue(db, human, "AIPI-1", { status: "done" });
    expect(claimIssue(db, agent, "AIPI-2").status).toBe("in_progress");
  });

  it("nextTask returns highest-priority unblocked todo, or null", () => {
    addDependency(db, human, "AIPI-1", "AIPI-2");
    expect(nextTask(db, agent)?.ref).toBe("AIPI-1"); // urgent AIPI-2 is blocked
    updateIssue(db, human, "AIPI-1", { status: "done" });
    expect(nextTask(db, agent)?.ref).toBe("AIPI-2");
    expect(nextTask(db, agent, "AIPI")?.ref).toBe("AIPI-2");
    for (const ref of ["AIPI-2", "AIPI-3"]) updateIssue(db, human, ref, { status: "done" });
    expect(nextTask(db, agent)).toBeNull();
  });

  it("nextTask skips issues assigned to someone else", () => {
    updateIssue(db, human, "AIPI-2", { assigneeName: "sean" });
    expect(nextTask(db, agent)?.ref).toBe("AIPI-1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/dependencies.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

`src/services/dependencies.ts`:

```ts
import { and, eq, isNull, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { dependencies, issues } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { getIssue, toView, type IssueView, _setGetOpenBlockers } from "./issues.js";
import { recordEvent } from "./events.js";

const CLOSED = ["done", "canceled"] as const;
const PRIORITY_RANK = sql`CASE ${issues.priority}
  WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;

export function addDependency(db: Db, actor: Actor, blockerRef: string, blockedRef: string): void {
  const blocker = getIssue(db, blockerRef);
  const blocked = getIssue(db, blockedRef);
  if (blocker.id === blocked.id) {
    throw new SwitchyardError(`An issue cannot block itself (${blockerRef}).`);
  }
  db.insert(dependencies)
    .values({ blockerId: blocker.id, blockedId: blocked.id })
    .onConflictDoNothing()
    .run();
  recordEvent(db, {
    issueId: blocked.id, actorId: actor.id,
    type: "blocked_by_added", payload: { blocker: blocker.ref },
  });
}

export function getOpenBlockers(db: Db, issueId: number): IssueView[] {
  const rows = db
    .select({ issue: issues })
    .from(dependencies)
    .innerJoin(issues, eq(dependencies.blockerId, issues.id))
    .where(and(eq(dependencies.blockedId, issueId), notInArray(issues.status, [...CLOSED])))
    .all();
  return rows.map((r) => toView(db, r.issue));
}

// Wire the real blocker check into claimIssue (replaces Task 5's placeholder).
_setGetOpenBlockers(getOpenBlockers);

export function nextTask(db: Db, actor: Actor, projectKey?: string): IssueView | null {
  const candidates = db
    .select()
    .from(issues)
    .where(and(
      eq(issues.status, "todo"),
      or(isNull(issues.assigneeId), eq(issues.assigneeId, actor.id)),
    ))
    .orderBy(PRIORITY_RANK, issues.createdAt)
    .all();
  for (const row of candidates) {
    const view = toView(db, row);
    if (projectKey !== undefined && !view.ref.startsWith(projectKey + "-")) continue;
    if (getOpenBlockers(db, row.id).length === 0) return view;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/services/dependencies.test.ts`
Expected: PASS (3 tests). Note the claim-blocked test exercises Task 5's `claimIssue` against the real blocker check. Run `npx vitest run` — everything green.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: dependencies with open-blocker checks and next_task query"
```

---

### Task 7: Comments and activity feed

**Files:**
- Create: `src/services/comments.ts`
- Test: `tests/services/comments.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces (from `comments.ts`): `addComment(db, actor: Actor, ref: string, body: string): void` (event type `comment`, payload `{ body }`); `getActivity(db, ref: string): { type: string; actorName: string; payload: Record<string, unknown>; createdAt: number }[]` — the full event stream for an issue, oldest first.

- [ ] **Step 1: Write the failing test**

`tests/services/comments.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue } from "../../src/services/issues.js";
import { addComment, getActivity } from "../../src/services/comments.js";

describe("comments and activity", () => {
  it("appends comments and returns the attributed stream", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    const agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
    createProject(db, { key: "AIPI", name: "aipi" });
    createIssue(db, human, { projectKey: "AIPI", title: "Ship v1" });
    addComment(db, agent, "AIPI-1", "Implemented and verified with vitest — 12 tests pass.");
    const activity = getActivity(db, "AIPI-1");
    expect(activity.map((a) => a.type)).toEqual(["created", "comment"]);
    expect(activity[1].actorName).toBe("claude/worker");
    expect(activity[1].payload.body).toMatch(/12 tests pass/);
    expect(() => addComment(db, agent, "AIPI-1", "  ")).toThrowError(/empty/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/comments.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

`src/services/comments.ts`:

```ts
import type { Db } from "../db/index.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { getIssue } from "./issues.js";
import { listIssueEvents, recordEvent } from "./events.js";

export function addComment(db: Db, actor: Actor, ref: string, body: string): void {
  if (!body.trim()) {
    throw new SwitchyardError("Comment body is empty — write what you did or what you need.");
  }
  const issue = getIssue(db, ref);
  recordEvent(db, { issueId: issue.id, actorId: actor.id, type: "comment", payload: { body } });
}

export function getActivity(db: Db, ref: string) {
  const issue = getIssue(db, ref);
  return listIssueEvents(db, issue.id).map((e) => ({
    type: e.type,
    actorName: e.actorName,
    payload: e.payload,
    createdAt: e.createdAt,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/services/comments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: comments and activity feed over the event log"
```

---

### Task 8: Search

**Files:**
- Create: `src/services/search.ts`
- Test: `tests/services/search.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces (from `search.ts`): `type SearchFilters = { projectKey?: string; status?: Status; assigneeName?: string; label?: string; text?: string }`; `searchIssues(db, filters: SearchFilters): IssueView[]` — all filters ANDed; `text` is case-insensitive substring match on title and description; results newest-first.

- [ ] **Step 1: Write the failing test**

`tests/services/search.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue } from "../../src/services/issues.js";
import { searchIssues } from "../../src/services/search.js";

let db: Db, human: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  createProject(db, { key: "AIPI", name: "aipi" });
  createProject(db, { key: "HAND", name: "housing" });
  createIssue(db, human, { projectKey: "AIPI", title: "Fix flaky API test", labels: ["testing"] });
  createIssue(db, human, { projectKey: "AIPI", title: "Write docs" });
  createIssue(db, human, { projectKey: "HAND", title: "Map layer bug" });
  updateIssue(db, human, "AIPI-1", { status: "todo", assigneeName: "sean" });
});

describe("searchIssues", () => {
  it("filters by project, status, assignee, label, and text — ANDed", () => {
    expect(searchIssues(db, { projectKey: "AIPI" })).toHaveLength(2);
    expect(searchIssues(db, { status: "todo" }).map((i) => i.ref)).toEqual(["AIPI-1"]);
    expect(searchIssues(db, { assigneeName: "sean" }).map((i) => i.ref)).toEqual(["AIPI-1"]);
    expect(searchIssues(db, { label: "testing" }).map((i) => i.ref)).toEqual(["AIPI-1"]);
    expect(searchIssues(db, { text: "FLAKY" }).map((i) => i.ref)).toEqual(["AIPI-1"]);
    expect(searchIssues(db, { projectKey: "HAND", status: "todo" })).toHaveLength(0);
  });

  it("returns everything with no filters, newest first", () => {
    const all = searchIssues(db, {});
    expect(all).toHaveLength(3);
    expect(all[0].ref).toBe("HAND-1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/search.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

`src/services/search.ts`:

```ts
import { and, desc, eq, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { actors, issues, projects, type Status } from "../db/schema.js";
import { toView, type IssueView } from "./issues.js";
import { getProjectByKey } from "./projects.js";
import { SwitchyardError } from "./errors.js";

export type SearchFilters = {
  projectKey?: string;
  status?: Status;
  assigneeName?: string;
  label?: string;
  text?: string;
};

export function searchIssues(db: Db, filters: SearchFilters): IssueView[] {
  const conditions: SQL[] = [];
  if (filters.projectKey) conditions.push(eq(issues.projectId, getProjectByKey(db, filters.projectKey).id));
  if (filters.status) conditions.push(eq(issues.status, filters.status));
  if (filters.assigneeName) {
    const a = db.select().from(actors).where(eq(actors.name, filters.assigneeName)).get();
    if (!a) throw new SwitchyardError(`There is no actor named "${filters.assigneeName}".`);
    conditions.push(eq(issues.assigneeId, a.id));
  }
  if (filters.label) {
    conditions.push(sql`EXISTS (SELECT 1 FROM json_each(${issues.labels}) WHERE json_each.value = ${filters.label})`);
  }
  if (filters.text) {
    const pattern = `%${filters.text.toLowerCase()}%`;
    conditions.push(
      or(
        sql`lower(${issues.title}) LIKE ${pattern}`,
        sql`lower(${issues.description}) LIKE ${pattern}`
      )!
    );
  }
  const rows = db
    .select()
    .from(issues)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(issues.id))
    .all();
  return rows.map((r) => toView(db, r));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/services/search.test.ts`
Expected: PASS. Run `npx vitest run` — all green.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: issue search with ANDed filters and text match"
```

---

### Task 9: MCP server with read tools

**Files:**
- Create: `src/mcp/server.ts`
- Test: `tests/mcp/read-tools.test.ts`

**Interfaces:**
- Consumes: all service functions (Tasks 2–8).
- Produces: `buildMcpServer(db: Db, actor: Actor): McpServer` from `src/mcp/server.ts` — one MCP server instance scoped to the authenticated actor, with tools `list_projects`, `get_issue`, `search_issues`, `next_task` (this task) and the five write tools (Task 10). All tools return `{ content: [{ type: "text", text: JSON.stringify(result) }] }` on success; `SwitchyardError`s are returned as `isError: true` results with the plain message.

- [ ] **Step 1: Write the failing test**

`tests/mcp/read-tools.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue } from "../../src/services/issues.js";
import { buildMcpServer } from "../../src/mcp/server.js";

let db: Db, human: Actor, agent: Actor, client: Client;

async function connect(actor: Actor) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer(db, actor);
  await server.connect(st);
  const c = new Client({ name: "test", version: "0.0.0" });
  await c.connect(ct);
  return c;
}

const text = (r: Awaited<ReturnType<Client["callTool"]>>) =>
  (r.content as { type: string; text: string }[])[0].text;

beforeEach(async () => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, { key: "AIPI", name: "aipi" });
  createIssue(db, human, { projectKey: "AIPI", title: "Ship v1", priority: "high" });
  updateIssue(db, human, "AIPI-1", { status: "todo" });
  client = await connect(agent);
});

describe("MCP read tools", () => {
  it("list_projects returns project keys", async () => {
    const r = await client.callTool({ name: "list_projects", arguments: {} });
    expect(JSON.parse(text(r))[0].key).toBe("AIPI");
  });

  it("get_issue returns the issue by ref", async () => {
    const r = await client.callTool({ name: "get_issue", arguments: { ref: "AIPI-1" } });
    expect(JSON.parse(text(r)).title).toBe("Ship v1");
  });

  it("search_issues applies filters", async () => {
    const r = await client.callTool({
      name: "search_issues",
      arguments: { project_key: "AIPI", status: "todo" },
    });
    expect(JSON.parse(text(r))).toHaveLength(1);
  });

  it("next_task returns the workable issue", async () => {
    const r = await client.callTool({ name: "next_task", arguments: {} });
    expect(JSON.parse(text(r)).ref).toBe("AIPI-1");
  });

  it("errors are agent-legible, not stack traces", async () => {
    const r = await client.callTool({ name: "get_issue", arguments: { ref: "AIPI-99" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/AIPI-99 does not exist/);
    expect(text(r)).not.toMatch(/at .*\.ts/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/read-tools.test.ts`
Expected: FAIL — cannot find module `src/mcp/server.js`.

- [ ] **Step 3: Write the implementation**

`src/mcp/server.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { STATUSES, PRIORITIES } from "../db/schema.js";
import type { Actor } from "../services/actors.js";
import { SwitchyardError } from "../services/errors.js";
import { listProjects } from "../services/projects.js";
import {
  createIssue, getIssue, updateIssue, claimIssue,
} from "../services/issues.js";
import { nextTask } from "../services/dependencies.js";
import { addComment, getActivity } from "../services/comments.js";
import { searchIssues } from "../services/search.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});

function guard<A>(fn: (args: A) => unknown): (args: A) => ToolResult {
  return (args) => {
    try {
      return ok(fn(args));
    } catch (err) {
      if (err instanceof SwitchyardError) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      throw err;
    }
  };
}

export function buildMcpServer(db: Db, actor: Actor): McpServer {
  const server = new McpServer({ name: "switchyard", version: "0.1.0" });

  server.registerTool(
    "list_projects",
    { description: "List all projects with their keys. Issue refs are <KEY>-<number>." },
    guard(() => listProjects(db))
  );

  server.registerTool(
    "get_issue",
    {
      description: "Get one issue by ref (e.g. AIPI-42), including its full activity history.",
      inputSchema: { ref: z.string() },
    },
    guard(({ ref }: { ref: string }) => ({
      ...getIssue(db, ref),
      activity: getActivity(db, ref),
    }))
  );

  server.registerTool(
    "search_issues",
    {
      description: "Search issues. All filters are ANDed; text matches title/description.",
      inputSchema: {
        project_key: z.string().optional(),
        status: z.enum(STATUSES).optional(),
        assignee: z.string().optional(),
        label: z.string().optional(),
        text: z.string().optional(),
      },
    },
    guard((a: { project_key?: string; status?: (typeof STATUSES)[number]; assignee?: string; label?: string; text?: string }) =>
      searchIssues(db, {
        projectKey: a.project_key, status: a.status,
        assigneeName: a.assignee, label: a.label, text: a.text,
      })
    )
  );

  server.registerTool(
    "next_task",
    {
      description:
        "Get the highest-priority issue in `todo` that is assigned to you or unassigned and not blocked. " +
        "Call this when you want work. Returns null when nothing is workable.",
      inputSchema: { project_key: z.string().optional() },
    },
    guard(({ project_key }: { project_key?: string }) => nextTask(db, actor, project_key))
  );

  return server;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp/read-tools.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: MCP server with read tools and agent-legible errors"
```

---

### Task 10: MCP write tools

**Files:**
- Modify: `src/mcp/server.ts` (add five `registerTool` calls inside `buildMcpServer`, before `return server`)
- Test: `tests/mcp/write-tools.test.ts`

**Interfaces:**
- Consumes: Task 9's `buildMcpServer`, `guard`, `ok`; services from Tasks 4–7.
- Produces: MCP tools `file_issue`, `claim_issue`, `update_issue`, `comment`, `triage_queue`, `add_dependency`. Tool descriptions carry the behavioral conventions verbatim (see code — comment-before-review, never self-done, when to file). Import `addDependency` from `../services/dependencies.js` in `server.ts`.

- [ ] **Step 1: Write the failing test**

`tests/mcp/write-tools.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { getIssue } from "../../src/services/issues.js";
import { buildMcpServer } from "../../src/mcp/server.js";

let db: Db, human: Actor, agent: Actor, client: Client;

async function connect(actor: Actor) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(db, actor).connect(st);
  const c = new Client({ name: "test", version: "0.0.0" });
  await c.connect(ct);
  return c;
}

const text = (r: Awaited<ReturnType<Client["callTool"]>>) =>
  (r.content as { type: string; text: string }[])[0].text;

beforeEach(async () => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, { key: "AIPI", name: "aipi" });
  client = await connect(agent);
});

describe("MCP write tools", () => {
  it("file_issue creates a triage issue with provenance", async () => {
    const r = await client.callTool({
      name: "file_issue",
      arguments: {
        project_key: "AIPI",
        title: "Flaky test in api suite",
        source_type: "todo",
        source_detail: "src/api.ts:88",
      },
    });
    const issue = JSON.parse(text(r));
    expect(issue.status).toBe("triage");
    expect(getIssue(db, issue.ref).sourceDetail).toBe("src/api.ts:88");
  });

  it("claim, comment, and move to in_review as an agent", async () => {
    const humanClient = await connect(human);
    await humanClient.callTool({
      name: "file_issue",
      arguments: { project_key: "AIPI", title: "Ship v1" },
    });
    // human-created issues start in backlog; move to todo, then agent claims
    await humanClient.callTool({
      name: "update_issue",
      arguments: { ref: "AIPI-1", status: "todo" },
    });
    const claimed = JSON.parse(text(await client.callTool({
      name: "claim_issue", arguments: { ref: "AIPI-1" },
    })));
    expect(claimed.status).toBe("in_progress");
    await client.callTool({
      name: "comment",
      arguments: { ref: "AIPI-1", body: "Done, verified: 3 tests pass." },
    });
    const reviewed = JSON.parse(text(await client.callTool({
      name: "update_issue", arguments: { ref: "AIPI-1", status: "in_review" },
    })));
    expect(reviewed.status).toBe("in_review");
  });

  it("add_dependency makes next_task skip the blocked issue", async () => {
    const humanClient = await connect(human);
    for (const title of ["Schema", "API"]) {
      await humanClient.callTool({ name: "file_issue", arguments: { project_key: "AIPI", title } });
    }
    for (const ref of ["AIPI-1", "AIPI-2"]) {
      await humanClient.callTool({ name: "update_issue", arguments: { ref, status: "todo" } });
    }
    await client.callTool({
      name: "add_dependency",
      arguments: { blocker_ref: "AIPI-1", blocked_ref: "AIPI-2" },
    });
    const r = await client.callTool({ name: "claim_issue", arguments: { ref: "AIPI-2" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/blocked by AIPI-1/);
  });

  it("triage_queue lists triage issues with provenance", async () => {
    await client.callTool({
      name: "file_issue",
      arguments: { project_key: "AIPI", title: "A", source_type: "manual", source_detail: "x" },
    });
    const r = await client.callTool({ name: "triage_queue", arguments: {} });
    const queue = JSON.parse(text(r));
    expect(queue).toHaveLength(1);
    expect(queue[0].sourceType).toBe("manual");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/write-tools.test.ts`
Expected: FAIL — `file_issue` tool not found.

- [ ] **Step 3: Write the implementation**

Add inside `buildMcpServer` in `src/mcp/server.ts`, before `return server`:

```ts
  server.registerTool(
    "file_issue",
    {
      description:
        "Create an issue. ALWAYS file discovered work (TODOs, flaky tests, follow-ups, bugs you " +
        "noticed but did not fix) instead of only mentioning it in chat. Agent-filed issues go to " +
        "the triage inbox for human review, so file freely but with clear titles and provenance. " +
        "Provenance: source_type is where this came from; source_detail is a file:line, session id, " +
        "or short note; source_url is a CI run or PR link.",
      inputSchema: {
        project_key: z.string(),
        title: z.string(),
        description: z.string().optional(),
        priority: z.enum(PRIORITIES).optional(),
        labels: z.array(z.string()).optional(),
        parent_ref: z.string().optional(),
        source_type: z.enum(["session", "todo", "ci", "manual"]).optional(),
        source_detail: z.string().optional(),
        source_url: z.string().optional(),
      },
    },
    guard((a: {
      project_key: string; title: string; description?: string;
      priority?: (typeof PRIORITIES)[number]; labels?: string[]; parent_ref?: string;
      source_type?: "session" | "todo" | "ci" | "manual";
      source_detail?: string; source_url?: string;
    }) =>
      createIssue(db, actor, {
        projectKey: a.project_key, title: a.title, description: a.description,
        priority: a.priority, labels: a.labels, parentRef: a.parent_ref,
        provenance: a.source_type
          ? { sourceType: a.source_type, detail: a.source_detail, url: a.source_url }
          : undefined,
      })
    )
  );

  server.registerTool(
    "claim_issue",
    {
      description:
        "Assign yourself to an issue and move it to in_progress. Fails with guidance if the issue " +
        "is blocked. Prefer next_task to pick what to claim.",
      inputSchema: { ref: z.string() },
    },
    guard(({ ref }: { ref: string }) => claimIssue(db, actor, ref))
  );

  server.registerTool(
    "update_issue",
    {
      description:
        "Update an issue's fields. Conventions: before moving an issue to in_review, post a comment " +
        "saying what was done and how it was verified. NEVER move an issue you worked on to done — " +
        "a human or a review step does that.",
      inputSchema: {
        ref: z.string(),
        status: z.enum(STATUSES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        assignee: z.string().nullable().optional(),
        labels: z.array(z.string()).optional(),
      },
    },
    guard((a: {
      ref: string; status?: (typeof STATUSES)[number]; priority?: (typeof PRIORITIES)[number];
      title?: string; description?: string; assignee?: string | null; labels?: string[];
    }) =>
      updateIssue(db, actor, a.ref, {
        status: a.status, priority: a.priority, title: a.title,
        description: a.description, assigneeName: a.assignee, labels: a.labels,
      })
    )
  );

  server.registerTool(
    "comment",
    {
      description:
        "Add a comment to an issue. Use for progress notes, questions for humans, and final " +
        "summaries (what was done, how it was verified).",
      inputSchema: { ref: z.string(), body: z.string() },
    },
    guard(({ ref, body }: { ref: string; body: string }) => {
      addComment(db, actor, ref, body);
      return { ok: true };
    })
  );

  server.registerTool(
    "add_dependency",
    {
      description:
        "Declare that one issue blocks another (blocker must finish first). Blocked issues are " +
        "skipped by next_task and cannot be claimed until the blocker is done or canceled.",
      inputSchema: { blocker_ref: z.string(), blocked_ref: z.string() },
    },
    guard(({ blocker_ref, blocked_ref }: { blocker_ref: string; blocked_ref: string }) => {
      addDependency(db, actor, blocker_ref, blocked_ref);
      return { ok: true };
    })
  );

  server.registerTool(
    "triage_queue",
    {
      description:
        "List issues waiting in triage (agent-filed, pending human review), with provenance. Use " +
        "when a human asks you to help triage: suggest duplicates, priorities, and merges — but " +
        "the accept/dismiss decision is theirs.",
      inputSchema: { project_key: z.string().optional() },
    },
    guard(({ project_key }: { project_key?: string }) =>
      searchIssues(db, { projectKey: project_key, status: "triage" })
    )
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp/write-tools.test.ts`
Expected: PASS (4 tests). Run `npx vitest run` — all green.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: MCP write tools with behavioral conventions in descriptions"
```

---

### Task 11: HTTP entry, bearer auth, admin CLI, and the core-loop integration test

**Files:**
- Create: `src/server.ts`, `src/cli.ts`, `README.md`
- Test: `tests/integration/core-loop.test.ts`

**Interfaces:**
- Consumes: everything.
- Produces: `createApp(db: Db): Hono` and `startServer(db: Db, port: number)` from `src/server.ts`. `POST /mcp` requires `Authorization: Bearer syd_...`; each request builds a stateless MCP transport bound to the authenticated actor. `GET /health` returns `{ ok: true }`. `src/cli.ts` is the bootstrap admin tool: `tsx src/cli.ts <db-path> add-actor <name> <human|agent>` (prints the token once) and `tsx src/cli.ts <db-path> add-project <KEY> <name>`.

- [ ] **Step 1: Write the failing integration test**

The core loop is the product: agent files → human accepts → agent claims → comments → in_review. This drives it through the real HTTP server with two different tokens.

`tests/integration/core-loop.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { getIssue } from "../../src/services/issues.js";
import { getActivity } from "../../src/services/comments.js";
import { createApp } from "../../src/server.js";

let db: Db, server: ServerType, port: number;
let humanToken: string, agentToken: string;

async function mcpClient(token: string) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
  );
  const c = new Client({ name: "test", version: "0.0.0" });
  await c.connect(transport);
  return c;
}

const text = (r: Awaited<ReturnType<Client["callTool"]>>) =>
  (r.content as { type: string; text: string }[])[0].text;

beforeAll(async () => {
  db = openDb(":memory:");
  humanToken = createActor(db, { name: "sean", type: "human" }).token;
  agentToken = createActor(db, { name: "claude/worker", type: "agent" }).token;
  createProject(db, { key: "AIPI", name: "aipi" });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: createApp(db).fetch, port: 0 }, (info) => {
      port = info.port;
      resolve();
    });
  });
});

afterAll(() => server.close());

describe("core loop over HTTP", () => {
  it("rejects missing or bad tokens", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("agent files -> human accepts -> agent claims, comments, moves to review", async () => {
    const agent = await mcpClient(agentToken);
    const human = await mcpClient(humanToken);

    const filed = JSON.parse(text(await agent.callTool({
      name: "file_issue",
      arguments: {
        project_key: "AIPI", title: "Flaky retry test",
        source_type: "session", source_detail: "session-abc123",
      },
    })));
    expect(filed.status).toBe("triage");

    await human.callTool({
      name: "update_issue",
      arguments: { ref: filed.ref, status: "todo", priority: "high" },
    });

    const next = JSON.parse(text(await agent.callTool({ name: "next_task", arguments: {} })));
    expect(next.ref).toBe(filed.ref);

    await agent.callTool({ name: "claim_issue", arguments: { ref: filed.ref } });
    await agent.callTool({
      name: "comment",
      arguments: { ref: filed.ref, body: "Fixed the retry logic; vitest 14/14 green." },
    });
    await agent.callTool({
      name: "update_issue",
      arguments: { ref: filed.ref, status: "in_review" },
    });

    const final = getIssue(db, filed.ref);
    expect(final.status).toBe("in_review");
    const actorNames = getActivity(db, filed.ref).map((a) => a.actorName);
    expect(actorNames).toContain("sean");
    expect(actorNames).toContain("claude/worker");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/core-loop.test.ts`
Expected: FAIL — cannot find module `src/server.js`.

- [ ] **Step 3: Write the server**

`src/server.ts`:

```ts
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toReqRes, toFetchResponse } from "fetch-to-node";
import type { Db } from "./db/index.js";
import { authenticate } from "./services/actors.js";
import { buildMcpServer } from "./mcp/server.js";

export function createApp(db: Db) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/mcp", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const actor = token ? authenticate(db, token) : null;
    if (!actor) {
      return c.json(
        { error: "Missing or invalid bearer token — mint one with the switchyard CLI." },
        401
      );
    }
    const { req, res } = toReqRes(c.req.raw);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildMcpServer(db, actor);
    await server.connect(transport);
    await transport.handleRequest(req, res, await c.req.json());
    res.on("close", () => {
      transport.close();
      server.close();
    });
    return toFetchResponse(res);
  });

  return app;
}

export function startServer(db: Db, port: number) {
  return serve({ fetch: createApp(db).fetch, port }, (info) =>
    console.log(`switchyard listening on :${info.port}`)
  );
}

// Entrypoint: `npm run dev` (tsx src/server.ts)
if (import.meta.url === `file://${process.argv[1]}`) {
  const { openDb } = await import("./db/index.js");
  const db = openDb(process.env.SWITCHYARD_DB ?? "switchyard.db");
  startServer(db, Number(process.env.PORT ?? 3300));
}
```

Install the bridge dependency used above:

```bash
npm i fetch-to-node
```

- [ ] **Step 4: Write the admin CLI**

`src/cli.ts`:

```ts
import { openDb } from "./db/index.js";
import { createActor } from "./services/actors.js";
import { createProject } from "./services/projects.js";

const [dbPath, cmd, ...args] = process.argv.slice(2);
if (!dbPath || !cmd) {
  console.log("usage: tsx src/cli.ts <db-path> add-actor <name> <human|agent>");
  console.log("       tsx src/cli.ts <db-path> add-project <KEY> <name...>");
  process.exit(1);
}
const db = openDb(dbPath);

if (cmd === "add-actor") {
  const [name, type] = args;
  if (!name || (type !== "human" && type !== "agent")) {
    console.error("add-actor needs: <name> <human|agent>");
    process.exit(1);
  }
  const { actor, token } = createActor(db, { name, type });
  console.log(`created ${actor.type} actor "${actor.name}" (id ${actor.id})`);
  console.log(`token (shown once, store it now): ${token}`);
} else if (cmd === "add-project") {
  const [key, ...nameParts] = args;
  const project = createProject(db, { key, name: nameParts.join(" ") || key });
  console.log(`created project ${project.key}: ${project.name}`);
} else {
  console.error(`unknown command "${cmd}"`);
  process.exit(1);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run`
Expected: ALL tests pass, including `tests/integration/core-loop.test.ts` (2 tests).

- [ ] **Step 6: Write the README**

`README.md`:

````markdown
# Switchyard

Self-hosted, agent-native project tracker. Humans plan on a shared board;
Claude Code agents file, triage, claim, and work issues through MCP —
gated by human triage, with provenance on everything.

Spec: `docs/superpowers/specs/2026-07-07-switchyard-design.md`

## Quick start

```bash
npm install
npx tsx src/cli.ts switchyard.db add-project AIPI "aipi benchmarking"
npx tsx src/cli.ts switchyard.db add-actor sean human
npx tsx src/cli.ts switchyard.db add-actor claude/worker agent
npm run dev   # listens on :3300
```

## Connect Claude Code

```bash
claude mcp add switchyard --transport http http://localhost:3300/mcp \
  --header "Authorization: Bearer <token from add-actor>"
```

Tools: `list_projects`, `get_issue`, `search_issues`, `next_task`,
`file_issue`, `claim_issue`, `update_issue`, `comment`, `triage_queue`,
`add_dependency`.

## Development

```bash
npm test
```
````

- [ ] **Step 7: Manual smoke test**

```bash
npx tsx src/cli.ts /tmp/syd-smoke.db add-project TEST smoke
npx tsx src/cli.ts /tmp/syd-smoke.db add-actor smoke-agent agent
SWITCHYARD_DB=/tmp/syd-smoke.db PORT=3311 npx tsx src/server.ts &
sleep 1 && curl -s http://localhost:3311/health
# expect {"ok":true}; then stop the background server
kill %1 && rm -f /tmp/syd-smoke.db*
```

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: HTTP entry with bearer-authed MCP endpoint, admin CLI, README"
```

---

## After this plan

Dogfood immediately: run the server on the NAS or locally, `claude mcp add` it, and migrate one real project (e.g. aipi) onto it. Friction found while dogfooding becomes the input to Plan 2 (REST + magic-link auth + webhooks) and Plan 3 (web UI: triage inbox first, then board, then issue detail; Docker/Tailscale deploy).
