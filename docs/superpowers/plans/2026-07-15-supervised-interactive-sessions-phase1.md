# Supervised Interactive Sessions — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Switchyard a first-class *supervised interactive session* — one human driving one Claude, bound into a single principal — that preserves "an agent edited this, under a named human" provenance, relaxes the guardrails that only exist because dispatched workers are unattended, and coexists cleanly with headless dispatch.

**Architecture:** A supervised session is a **session-kind that binds two actors** (human + agent), not a new actor type. The MCP `/mcp` endpoint resolves a supervised-session token to a **Principal** `{ actor: human, viaAgent: agent, sessionId }`. Every service guard keeps seeing the *human* `actor`, so full-absorption is free (no guard edits). The *agent* rides alongside as `viaAgent`, threaded only into the audit choke point (`recordEvent`) so provenance stays honest. A per-install **hard-gate** list names action-types that, even in a supervised session, divert to a `pending_actions` row and require a fresh human affirmation (Phase 1: web-board button carrying the human's own credential; the native/Touch-ID surface is Phase 2).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Drizzle ORM + better-sqlite3, `@modelcontextprotocol/sdk`, Hono (REST), Zod v3 (app), Vitest.

## Global Constraints

- **Node 24** — Node 25's WebStorage breaks jsdom tests (SYD-97). Do not bump.
- **All business logic in `src/services/*`** — MCP/REST/UI are thin adapters over the same functions; no client has private powers.
- **Services throw `SwitchyardError`** for user-facing failures (MCP `guard()` → `isError` result; REST → 4xx). Anything else is a real 500.
- **Mutate issues only through services** — `events` is a co-written append-only audit log; never write it out-of-band.
- **Migrations are additive and generated** — after editing `src/db/schema.ts`, run `npm run db:generate` (drizzle-kit). Never hand-edit generated SQL.
- **Zod v3** in the app (the SDK's zod@4 lives only under `worker-sdk/`).
- **Import specifiers end in `.js`** even for `.ts` sources (ESM/NodeNext).
- **Run `npm run verify` before done-stamping** (TZ=UTC-pinned typecheck/build:ui/test; mirrors CI).

## File Structure

- `src/db/schema.ts` — add `sessions.kind` + `sessions.viaAgentId`; `events.viaAgentId` + `events.sessionId`; new `pendingActions` table (modify).
- `drizzle/00NN_*.sql` — generated migration (create).
- `src/services/principal.ts` — the `Principal` type + `resolvePrincipal` (create).
- `src/services/supervised-sessions.ts` — `openSupervisedSession`, `resolveSupervisedPrincipal`, `closeSupervisedSession` (create).
- `src/services/events.ts` — `recordEvent` gains optional `viaAgentId`/`sessionId` (modify).
- `src/services/provenance.ts` — the `Provenance` context type threaded into mutations (create; tiny, one type + helper).
- `src/services/hard-gate.ts` — hard-gate policy read + pending-action create/list/affirm (create).
- `src/services/issues.ts` — thread `Provenance` into `createIssue`/`updateIssue`/`claimIssue`; hard-gate pre-check on `done` (modify).
- `src/services/dependencies.ts` — thread `Provenance`; hard-gate pre-check on `dependency.remove` (modify).
- `src/services/comments.ts`, `src/services/needs-input.ts`, `src/services/agent-sessions.ts` — thread `Provenance` into their `recordEvent` calls (modify).
- `src/mcp/server.ts` — `buildMcpServer` takes a `Principal`; register `open_supervised_session`; pass `Provenance` on write tools (modify).
- `src/server.ts` — `/mcp` resolves supervised token → `Principal` (modify).
- `src/rest/*` — `POST /api/pending-actions/:id/affirm`, `GET /api/pending-actions` (modify/create).
- `src/services/dispatch selection` (in `settings.ts`/`stale-claims.ts` neighbours) — `workerPreference` positive-lane semantics (modify).

---

## Task 1: Schema + migration for supervised sessions, event provenance, pending actions

**Files:**
- Modify: `src/db/schema.ts`
- Create: `drizzle/00NN_supervised_sessions.sql` (generated)
- Test: `tests/db/supervised-schema.test.ts`

**Interfaces:**
- Produces: `sessions.kind` (`"plain" | "supervised"`, default `"plain"`), `sessions.viaAgentId` (nullable FK actors). `events.viaAgentId` (nullable FK actors), `events.sessionId` (nullable FK sessions). `pendingActions` table with columns below.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/db/supervised-schema.test.ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "../helpers/db.js"; // existing helper that migrates a fresh in-memory db
import { sessions, events, pendingActions } from "../../src/db/schema.js";

describe("supervised-session schema", () => {
  it("sessions has kind and via_agent_id columns", () => {
    const db = makeTestDb();
    // a raw insert exercising the new columns must not throw
    db.run(
      "INSERT INTO actors (name, type) VALUES ('h','human'),('a','agent')",
    );
    db.run(
      "INSERT INTO sessions (token_hash, actor_id, via_agent_id, kind, expires_at) " +
        "VALUES ('th', 1, 2, 'supervised', 9999999999)",
    );
    const row = db.all<{ kind: string; via_agent_id: number }>(
      "SELECT kind, via_agent_id FROM sessions",
    )[0];
    expect(row.kind).toBe("supervised");
    expect(row.via_agent_id).toBe(2);
  });

  it("pending_actions table exists with the expected shape", () => {
    const db = makeTestDb();
    db.run(
      "INSERT INTO actors (name, type) VALUES ('h','human'),('a','agent')",
    );
    db.run(
      "INSERT INTO sessions (token_hash, actor_id, via_agent_id, kind, expires_at) VALUES ('th',1,2,'supervised',9999999999)",
    );
    db.run("INSERT INTO projects (key, name) VALUES ('SYD','Switchyard')");
    db.run(
      "INSERT INTO issues (project_id, number, title, status, creator_id) VALUES (1,1,'t','backlog',1)",
    );
    db.run(
      "INSERT INTO pending_actions (session_id, issue_id, action_type, payload, status) " +
        "VALUES (1, 1, 'done', '{}', 'pending')",
    );
    const row = db.all<{ status: string; action_type: string }>(
      "SELECT status, action_type FROM pending_actions",
    )[0];
    expect(row.status).toBe("pending");
    expect(row.action_type).toBe("done");
  });
});
```

> If `tests/helpers/db.ts`/`makeTestDb` does not exist under that name, use the existing test-db bootstrap (grep `tests/` for how `services/*.test.ts` build a migrated db) and match it — do NOT invent a new harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/supervised-schema.test.ts`
Expected: FAIL — `no such column: via_agent_id` / `no such table: pending_actions`.

- [ ] **Step 3: Add columns and table to schema**

In `src/db/schema.ts`, extend `sessions`:

```typescript
export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tokenHash: text("token_hash").notNull().unique(),
  actorId: integer("actor_id")
    .notNull()
    .references(() => actors.id),
  // Supervised sessions (2026-07-15): a human+agent pair bound into one principal.
  // kind="plain" is the pre-existing single-actor session; "supervised" also sets
  // viaAgentId to the agent doing the editing.
  kind: text("kind", { enum: ["plain", "supervised"] })
    .notNull()
    .default("plain"),
  viaAgentId: integer("via_agent_id").references(() => actors.id),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull().default(now()),
});
```

Extend `events` (add the two nullable columns just before `createdAt`):

```typescript
    // Dual attribution for supervised sessions (2026-07-15): actorId stays the
    // accountable human; viaAgentId records the agent that did the editing;
    // sessionId ties a run of edits to one supervised session. All null for
    // ordinary single-actor events.
    viaAgentId: integer("via_agent_id").references(() => actors.id),
    sessionId: integer("session_id").references(() => sessions.id),
```

Add the new table (after `sessions`, before `loginLinks`):

```typescript
export const pendingActions = sqliteTable("pending_actions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id")
    .notNull()
    .references(() => sessions.id),
  issueId: integer("issue_id")
    .notNull()
    .references(() => issues.id),
  actionType: text("action_type").notNull(), // "done" | "dependency.remove"
  payload: text("payload", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  status: text("status", { enum: ["pending", "affirmed", "expired"] })
    .notNull()
    .default("pending"),
  affirmedById: integer("affirmed_by_id").references(() => actors.id),
  affirmedAt: integer("affirmed_at"),
  createdAt: integer("created_at").notNull().default(now()),
});
```

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate`
Expected: a new `drizzle/00NN_*.sql` adding the columns/table. Do not hand-edit it.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/db/supervised-schema.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts drizzle/ tests/db/supervised-schema.test.ts
git commit -m "feat: schema for supervised sessions, event provenance, pending actions (SYD supervised phase 1)"
```

---

## Task 2: The Principal type and supervised-session service

**Files:**
- Create: `src/services/principal.ts`
- Create: `src/services/supervised-sessions.ts`
- Test: `tests/services/supervised-sessions.test.ts`

**Interfaces:**
- Consumes: `Actor` (from `actors.ts`), `mintToken`/`hashToken` (`tokens.ts`), `getOrCreateActor` (`actors.ts`).
- Produces:
  - `type Principal = { actor: Actor; viaAgent?: Actor; sessionId?: number }`
  - `openSupervisedSession(db, human: Actor, agentName: string): { sessionToken: string; sessionId: number; agent: Actor }`
  - `resolveSupervisedPrincipal(db, sessionToken: string): Principal | null`
  - `closeSupervisedSession(db, sessionToken: string): void`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/services/supervised-sessions.test.ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "../helpers/db.js";
import { createActor } from "../../src/services/actors.js";
import {
  openSupervisedSession,
  resolveSupervisedPrincipal,
} from "../../src/services/supervised-sessions.js";

function human(db: any) {
  return createActor(db, { name: "sean", type: "human" }).actor;
}

describe("supervised sessions", () => {
  it("binds a human and a (declared) agent into one resolvable principal", () => {
    const db = makeTestDb();
    const h = human(db);
    const { sessionToken, agent } = openSupervisedSession(db, h, "claude-code");
    const p = resolveSupervisedPrincipal(db, sessionToken);
    expect(p).not.toBeNull();
    expect(p!.actor.id).toBe(h.id); // accountable actor is the human
    expect(p!.actor.type).toBe("human");
    expect(p!.viaAgent!.id).toBe(agent.id); // editor is the agent
    expect(p!.viaAgent!.type).toBe("agent");
    expect(typeof p!.sessionId).toBe("number");
  });

  it("refuses to open a supervised session for a non-human root", () => {
    const db = makeTestDb();
    const a = createActor(db, { name: "bot", type: "agent" }).actor;
    expect(() => openSupervisedSession(db, a, "claude-code")).toThrow(
      /only a human can open a supervised session/i,
    );
  });

  it("returns null for a plain (non-supervised) session token", () => {
    const db = makeTestDb();
    // a plain session token must not resolve as supervised
    expect(resolveSupervisedPrincipal(db, "sys_not_a_supervised_token")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/supervised-sessions.test.ts`
Expected: FAIL — cannot find module `supervised-sessions.js`.

- [ ] **Step 3: Write `principal.ts`**

```typescript
// src/services/principal.ts
import type { Actor } from "./actors.js";

/**
 * The identity behind a request. For ordinary sessions `viaAgent`/`sessionId`
 * are undefined and `actor` is the sole principal. For a supervised session
 * `actor` is the accountable human, `viaAgent` is the agent that did the
 * editing, and `sessionId` ties the run of edits together. Guards read
 * `actor` only; the audit log reads all three.
 */
export type Principal = { actor: Actor; viaAgent?: Actor; sessionId?: number };
```

- [ ] **Step 4: Write `supervised-sessions.ts`**

```typescript
// src/services/supervised-sessions.ts
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { actors, sessions } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { getOrCreateActor } from "./actors.js";
import type { Principal } from "./principal.js";
import { SwitchyardError } from "./errors.js";
import { hashToken, mintToken } from "./tokens.js";

const SUPERVISED_TTL = 12 * 3600; // a working day; renew by re-opening
const nowSec = () => Math.floor(Date.now() / 1000);

export function openSupervisedSession(
  db: Db,
  human: Actor,
  agentName: string,
): { sessionToken: string; sessionId: number; agent: Actor } {
  if (human.type !== "human") {
    throw new SwitchyardError(
      "Only a human can open a supervised session — the human is the root of trust and the accountable actor.",
    );
  }
  const agent = getOrCreateActor(db, agentName, "agent");
  const sessionToken = mintToken("sup", 32);
  const row = db
    .insert(sessions)
    .values({
      tokenHash: hashToken(sessionToken),
      actorId: human.id,
      viaAgentId: agent.id,
      kind: "supervised",
      expiresAt: nowSec() + SUPERVISED_TTL,
    })
    .returning({ id: sessions.id })
    .get();
  // NB: no `events` row here — events are issue-scoped (issueId NOT NULL); the
  // sessions row (with createdAt) IS the record that human opened this pairing.
  return { sessionToken, sessionId: row.id, agent };
}

export function resolveSupervisedPrincipal(
  db: Db,
  sessionToken: string,
): Principal | null {
  const row = db
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.tokenHash, hashToken(sessionToken)), eq(sessions.kind, "supervised")),
    )
    .get();
  if (!row || row.viaAgentId === null || row.expiresAt < nowSec()) return null;
  const human = db.select().from(actors).where(eq(actors.id, row.actorId)).get();
  const agent = db.select().from(actors).where(eq(actors.id, row.viaAgentId)).get();
  if (!human || !agent) return null;
  return {
    actor: { id: human.id, name: human.name, type: human.type },
    viaAgent: { id: agent.id, name: agent.name, type: agent.type },
    sessionId: row.id,
  };
}

export function closeSupervisedSession(db: Db, sessionToken: string): void {
  db.delete(sessions)
    .where(
      and(eq(sessions.tokenHash, hashToken(sessionToken)), eq(sessions.kind, "supervised")),
    )
    .run();
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/services/supervised-sessions.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/services/principal.ts src/services/supervised-sessions.ts tests/services/supervised-sessions.test.ts
git commit -m "feat: supervised-session principal + open/resolve/close (SYD supervised phase 1)"
```

---

## Task 3: Dual attribution at the audit choke point

**Files:**
- Modify: `src/services/events.ts`
- Create: `src/services/provenance.ts`
- Test: `tests/services/events-provenance.test.ts`

**Interfaces:**
- Consumes: `Principal` (`principal.ts`).
- Produces:
  - `recordEvent(db, e)` where `e` gains optional `viaAgentId?: number` and `sessionId?: number`.
  - `type Provenance = { viaAgentId?: number; sessionId?: number }`
  - `provenanceOf(principal: Principal): Provenance` — pulls the two ids off a principal.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/services/events-provenance.test.ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "../helpers/db.js";
import { recordEvent } from "../../src/services/events.js";

describe("recordEvent dual attribution", () => {
  it("persists viaAgentId and sessionId when supplied", () => {
    const db = makeTestDb();
    db.run("INSERT INTO actors (name,type) VALUES ('h','human'),('a','agent')");
    db.run("INSERT INTO projects (key,name) VALUES ('SYD','Switchyard')");
    db.run(
      "INSERT INTO issues (project_id,number,title,status,creator_id) VALUES (1,1,'t','backlog',1)",
    );
    db.run(
      "INSERT INTO sessions (token_hash,actor_id,via_agent_id,kind,expires_at) VALUES ('t',1,2,'supervised',9999999999)",
    );
    const id = recordEvent(db, {
      issueId: 1,
      actorId: 1,
      type: "status_changed",
      viaAgentId: 2,
      sessionId: 1,
    });
    const row = db.all<{ via_agent_id: number; session_id: number }>(
      "SELECT via_agent_id, session_id FROM events WHERE id = ?",
      [id],
    )[0];
    expect(row.via_agent_id).toBe(2);
    expect(row.session_id).toBe(1);
  });

  it("leaves both null for a plain single-actor event", () => {
    const db = makeTestDb();
    db.run("INSERT INTO actors (name,type) VALUES ('h','human')");
    db.run("INSERT INTO projects (key,name) VALUES ('SYD','Switchyard')");
    db.run(
      "INSERT INTO issues (project_id,number,title,status,creator_id) VALUES (1,1,'t','backlog',1)",
    );
    const id = recordEvent(db, { issueId: 1, actorId: 1, type: "status_changed" });
    const row = db.all<{ via_agent_id: number | null; session_id: number | null }>(
      "SELECT via_agent_id, session_id FROM events WHERE id = ?",
      [id],
    )[0];
    expect(row.via_agent_id).toBeNull();
    expect(row.session_id).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/events-provenance.test.ts`
Expected: FAIL — `recordEvent` ignores the new fields (or type error on unknown property).

- [ ] **Step 3: Extend `recordEvent`**

In `src/services/events.ts`, replace the `recordEvent` signature/body:

```typescript
export function recordEvent(
  db: DbOrTx,
  e: {
    issueId: number;
    actorId: number;
    type: EventKind;
    payload?: Record<string, unknown>;
    viaAgentId?: number;
    sessionId?: number;
  },
): number {
  return db
    .insert(events)
    .values({
      issueId: e.issueId,
      actorId: e.actorId,
      type: e.type,
      payload: e.payload ?? {},
      viaAgentId: e.viaAgentId ?? null,
      sessionId: e.sessionId ?? null,
    })
    .returning({ id: events.id })
    .get().id;
}
```

- [ ] **Step 4: Write `provenance.ts`**

```typescript
// src/services/provenance.ts
import type { Principal } from "./principal.js";

export type Provenance = { viaAgentId?: number; sessionId?: number };

/** The provenance a supervised principal carries; empty for a plain principal. */
export function provenanceOf(principal: Principal): Provenance {
  return { viaAgentId: principal.viaAgent?.id, sessionId: principal.sessionId };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/services/events-provenance.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/services/events.ts src/services/provenance.ts tests/services/events-provenance.test.ts
git commit -m "feat: dual attribution in recordEvent + Provenance context (SYD supervised phase 1)"
```

---

## Task 4: Thread provenance through issue mutations

**Files:**
- Modify: `src/services/issues.ts` (`createIssue`, `updateIssue`, `claimIssue`)
- Modify: `src/services/comments.ts` (`addComment`)
- Test: `tests/services/supervised-provenance-e2e.test.ts`

**Interfaces:**
- Consumes: `Provenance` (`provenance.ts`).
- Produces: `createIssue`, `updateIssue`, `claimIssue`, `addComment` each accept an optional trailing `prov: Provenance = {}` and pass `prov.viaAgentId`/`prov.sessionId` into every `recordEvent` call they make.

**Design note (do not skip):** the `actor` these functions receive stays the **human** for a supervised session — that is what makes all existing `actor.type` guards pass (full absorption). `prov` is *only* forwarded to `recordEvent`; it never influences a guard. Do not branch guard logic on `prov`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/services/supervised-provenance-e2e.test.ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "../helpers/db.js";
import { createActor } from "../../src/services/actors.js";
import { openSupervisedSession, resolveSupervisedPrincipal } from "../../src/services/supervised-sessions.js";
import { provenanceOf } from "../../src/services/provenance.js";
import { createIssue, updateIssue } from "../../src/services/issues.js";
import { seedProject } from "../helpers/seed.js"; // if absent, inline a project insert like other issue tests

describe("supervised provenance end to end", () => {
  it("a supervised human moving an issue to done records via_agent + session", () => {
    const db = makeTestDb();
    const h = createActor(db, { name: "sean", type: "human" }).actor;
    seedProject(db, "SYD");
    const { sessionToken } = openSupervisedSession(db, h, "claude-code");
    const prin = resolveSupervisedPrincipal(db, sessionToken)!;
    const prov = provenanceOf(prin);

    const issue = createIssue(db, prin.actor, { projectKey: "SYD", title: "t", description: "d" }, prov);
    // human in a supervised session can stamp done (full absorption); provenance rides along
    updateIssue(db, prin.actor, issue.ref, { status: "done" }, {}, prov);

    const row = db.all<{ via_agent_id: number; session_id: number; type: string }>(
      "SELECT via_agent_id, session_id, type FROM events WHERE type='status_changed' ORDER BY id DESC LIMIT 1",
    )[0];
    expect(row.via_agent_id).toBe(prin.viaAgent!.id);
    expect(row.session_id).toBe(prin.sessionId);
  });
});
```

> Match the *actual* `createIssue`/`updateIssue` argument order in `src/services/issues.ts` when wiring `prov` as the trailing param. `updateIssue`'s existing 4th param is `lease: LeaseChannel = {}`; add `prov` as the 5th.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/supervised-provenance-e2e.test.ts`
Expected: FAIL — `createIssue`/`updateIssue` don't accept a `prov` arg (type error) or events lack the ids.

- [ ] **Step 3: Thread `prov` into the mutation functions**

For each of `createIssue`, `updateIssue`, `claimIssue` in `src/services/issues.ts` and `addComment` in `src/services/comments.ts`:

1. Add a trailing parameter `prov: Provenance = {}` (import `Provenance` from `./provenance.js`).
2. At **every** `recordEvent(...)` call inside that function, spread the ids:

```typescript
recordEvent(tx, {
  issueId: current.id,
  actorId: actor.id,
  type: "status_changed",
  payload: { from: current.status, to: patch.status },
  viaAgentId: prov.viaAgentId,
  sessionId: prov.sessionId,
});
```

Apply the same `viaAgentId: prov.viaAgentId, sessionId: prov.sessionId` addition to each `recordEvent` call in these functions (status_changed, assigned, commented, created, dependency events routed through here, etc.). Leave guard logic untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/services/supervised-provenance-e2e.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full issue-service suite (no regressions from the new optional param)**

Run: `npx vitest run tests/services/`
Expected: PASS — the new param defaults to `{}`, so existing single-actor callers are unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/services/issues.ts src/services/comments.ts tests/services/supervised-provenance-e2e.test.ts
git commit -m "feat: thread supervised provenance through issue mutations (SYD supervised phase 1)"
```

---

## Task 5: Hard-gate policy + pending-action service

**Files:**
- Modify: `src/services/settings.ts` (register `supervised.hard_gate_actions`)
- Create: `src/services/hard-gate.ts`
- Test: `tests/services/hard-gate.test.ts`

**Design note / spec reconciliation:** the spec calls the hard-gate list *per-project*, but Switchyard's settings registry is install-global (typed key→value). Phase 1 implements it as **one install-global `string[]` setting**; per-project scoping is deferred (flagged in the design's open questions). This is a deliberate, documented narrowing — call it out in the PR.

**Interfaces:**
- Consumes: `getSetting` (`settings.ts`), `Principal` (`principal.ts`).
- Produces:
  - setting `supervised.hard_gate_actions: string[]` (default `[]`).
  - `isHardGated(db, actionType: string): boolean`
  - `createPendingAction(db, sessionId: number, issueId: number, actionType: string, payload: Record<string, unknown>): number`
  - `getPendingAction(db, id: number): PendingActionRow | null`
  - `affirmPendingAction(db, human: Actor, id: number): PendingActionRow` — human-only; marks affirmed. (Execution of the deferred action is Task 7.)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/services/hard-gate.test.ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "../helpers/db.js";
import { createActor } from "../../src/services/actors.js";
import { setSetting } from "../../src/services/settings.js";
import { isHardGated, createPendingAction, affirmPendingAction, getPendingAction } from "../../src/services/hard-gate.js";
import { seedProject, seedIssue } from "../helpers/seed.js";

describe("hard gate", () => {
  it("defaults to no gated actions", () => {
    const db = makeTestDb();
    expect(isHardGated(db, "done")).toBe(false);
  });

  it("reports an action gated once configured", () => {
    const db = makeTestDb();
    const admin = createActor(db, { name: "sean", type: "human" }).actor;
    setSetting(db, admin, "supervised.hard_gate_actions", ["done"]);
    expect(isHardGated(db, "done")).toBe(true);
    expect(isHardGated(db, "dependency.remove")).toBe(false);
  });

  it("a human affirms a pending action; it flips to affirmed with the affirmer recorded", () => {
    const db = makeTestDb();
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    seedProject(db, "SYD");
    const issueId = seedIssue(db, "SYD");
    db.run("INSERT INTO sessions (token_hash,actor_id,via_agent_id,kind,expires_at) VALUES ('t',1,1,'supervised',9999999999)");
    const pid = createPendingAction(db, 1, issueId, "done", { status: "done" });
    const affirmed = affirmPendingAction(db, human, pid);
    expect(affirmed.status).toBe("affirmed");
    expect(affirmed.affirmedById).toBe(human.id);
    expect(getPendingAction(db, pid)!.status).toBe("affirmed");
  });

  it("an agent cannot affirm a pending action", () => {
    const db = makeTestDb();
    const agent = createActor(db, { name: "bot", type: "agent" }).actor;
    seedProject(db, "SYD");
    const issueId = seedIssue(db, "SYD");
    db.run("INSERT INTO sessions (token_hash,actor_id,via_agent_id,kind,expires_at) VALUES ('t',1,1,'supervised',9999999999)");
    const pid = createPendingAction(db, 1, issueId, "done", {});
    expect(() => affirmPendingAction(db, agent, pid)).toThrow(/only a human can affirm/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/hard-gate.test.ts`
Expected: FAIL — module missing / setting key unknown.

- [ ] **Step 3: Register the setting**

In `src/services/settings.ts`, add to the `REGISTRY` object (match the existing entry shape — `type` + `default` + description):

```typescript
  "supervised.hard_gate_actions": {
    type: "string[]",
    default: [] as string[],
    description:
      "Action-types that still require a fresh human affirmation even inside a supervised session (e.g. \"done\", \"dependency.remove\"). Empty = full absorption.",
  },
```

- [ ] **Step 4: Write `hard-gate.ts`**

```typescript
// src/services/hard-gate.ts
import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { pendingActions } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { getSetting } from "./settings.js";

const nowSec = () => Math.floor(Date.now() / 1000);

export type PendingActionRow = typeof pendingActions.$inferSelect;

export function isHardGated(db: Db, actionType: string): boolean {
  return getSetting(db, "supervised.hard_gate_actions").includes(actionType);
}

export function createPendingAction(
  db: Db,
  sessionId: number,
  issueId: number,
  actionType: string,
  payload: Record<string, unknown>,
): number {
  return db
    .insert(pendingActions)
    .values({ sessionId, issueId, actionType, payload, status: "pending" })
    .returning({ id: pendingActions.id })
    .get().id;
}

export function getPendingAction(db: Db, id: number): PendingActionRow | null {
  return db.select().from(pendingActions).where(eq(pendingActions.id, id)).get() ?? null;
}

export function affirmPendingAction(db: Db, human: Actor, id: number): PendingActionRow {
  if (human.type !== "human") {
    throw new SwitchyardError(
      "Only a human can affirm a gated action — this is the presence check the gate exists for.",
    );
  }
  const row = getPendingAction(db, id);
  if (!row) throw new SwitchyardError(`There is no pending action #${id}.`);
  if (row.status !== "pending") {
    throw new SwitchyardError(`Pending action #${id} is already ${row.status}.`);
  }
  db.update(pendingActions)
    .set({ status: "affirmed", affirmedById: human.id, affirmedAt: nowSec() })
    .where(eq(pendingActions.id, id))
    .run();
  return getPendingAction(db, id)!;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/services/hard-gate.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/services/settings.ts src/services/hard-gate.ts tests/services/hard-gate.test.ts
git commit -m "feat: hard-gate policy + pending-action service (SYD supervised phase 1)"
```

---

## Task 6: Divert gated actions to pending instead of committing

**Files:**
- Modify: `src/services/issues.ts` (`updateIssue` — the `done` path)
- Test: `tests/services/hard-gate-divert.test.ts`

**Interfaces:**
- Consumes: `isHardGated`, `createPendingAction` (`hard-gate.ts`); `Provenance` (`provenance.ts`).
- Produces: a supervised (`prov.sessionId != null`) `updateIssue` to a hard-gated status creates a pending action and throws `SwitchyardError("Awaiting human affirmation …", { pendingActionId })` **before** entering the mutation transaction — nothing commits.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/services/hard-gate-divert.test.ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "../helpers/db.js";
import { createActor } from "../../src/services/actors.js";
import { setSetting } from "../../src/services/settings.js";
import { openSupervisedSession, resolveSupervisedPrincipal } from "../../src/services/supervised-sessions.js";
import { provenanceOf } from "../../src/services/provenance.js";
import { createIssue, updateIssue, getIssue } from "../../src/services/issues.js";
import { seedProject } from "../helpers/seed.js";

describe("hard-gated done in a supervised session", () => {
  it("does not commit and creates a pending action", () => {
    const db = makeTestDb();
    const h = createActor(db, { name: "sean", type: "human" }).actor;
    seedProject(db, "SYD");
    setSetting(db, h, "supervised.hard_gate_actions", ["done"]);
    const { sessionToken } = openSupervisedSession(db, h, "claude-code");
    const prin = resolveSupervisedPrincipal(db, sessionToken)!;
    const prov = provenanceOf(prin);
    const issue = createIssue(db, prin.actor, { projectKey: "SYD", title: "t", description: "d" }, prov);
    updateIssue(db, prin.actor, issue.ref, { status: "in_review" }, {}, prov);

    expect(() => updateIssue(db, prin.actor, issue.ref, { status: "done" }, {}, prov)).toThrow(
      /awaiting human affirmation/i,
    );
    // status did NOT change to done
    expect(getIssue(db, issue.ref).status).toBe("in_review");
    // a pending action exists
    const pending = db.all<{ c: number }>("SELECT COUNT(*) c FROM pending_actions WHERE status='pending'")[0];
    expect(pending.c).toBe(1);
  });

  it("a plain (non-supervised) human done-stamp is NOT diverted even when 'done' is gated", () => {
    const db = makeTestDb();
    const h = createActor(db, { name: "sean", type: "human" }).actor;
    seedProject(db, "SYD");
    setSetting(db, h, "supervised.hard_gate_actions", ["done"]);
    const issue = createIssue(db, h, { projectKey: "SYD", title: "t", description: "d" });
    updateIssue(db, h, issue.ref, { status: "in_review" });
    updateIssue(db, h, issue.ref, { status: "done" }); // plain human, no session → commits
    expect(getIssue(db, issue.ref).status).toBe("done");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/hard-gate-divert.test.ts`
Expected: FAIL — the gated `done` currently commits.

- [ ] **Step 3: Add the pre-transaction hard-gate check**

In `src/services/issues.ts` `updateIssue`, **before** the mutation transaction opens, add:

```typescript
  // Supervised hard-gate (2026-07-15): if this is a supervised session
  // (prov.sessionId set) and the target status is on the install's hard-gate
  // list, don't mutate — record a pending action and stop. A human releases it
  // out-of-band (affirm), which re-drives updateIssue with prov.sessionId
  // cleared so this check is skipped on the second pass.
  if (prov.sessionId != null && patch.status !== undefined && isHardGated(db, patch.status)) {
    const target = resolveIssueByRef(db, ref); // existing helper used by updateIssue to load the issue
    const pendingActionId = createPendingAction(db, prov.sessionId, target.id, patch.status, {
      status: patch.status,
      ...(patch.expectedHeadSha !== undefined ? { expectedHeadSha: patch.expectedHeadSha } : {}),
    });
    throw new SwitchyardError(
      `Awaiting human affirmation: ${ref} → ${patch.status} is hard-gated. A human must approve pending action #${pendingActionId} (board approval queue). Nothing was changed.`,
    );
  }
```

> Use whatever ref→issue resolver `updateIssue` already calls (grep the function top). Do not double-open the mutation transaction.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/services/hard-gate-divert.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/issues.ts tests/services/hard-gate-divert.test.ts
git commit -m "feat: divert hard-gated supervised actions to pending (SYD supervised phase 1)"
```

---

## Task 7: Affirm executes the deferred action (web-board fallback)

**Files:**
- Modify: `src/services/hard-gate.ts` (`affirmPendingAction` executes the action)
- Modify: `src/services/issues.ts` (export a status-change that can bypass the gate on the affirmed pass)
- Test: `tests/services/hard-gate-affirm-exec.test.ts`

**Interfaces:**
- Consumes: `updateIssue` (with `prov.sessionId` cleared so the gate is skipped).
- Produces: `affirmPendingAction(db, human, id)` — after flipping to `affirmed`, executes the deferred action by calling `updateIssue(db, human, ref, { status }, {}, {})` (plain human, no session → not re-gated). Records `affirmed`.

**Design note:** the affirmed pass runs *as the human* (their own credential released it) with **no** session provenance — this is exactly the plain-human done-stamp, so the existing Task-6 divert check is skipped (`prov.sessionId == null`). Provenance of the *editing* is already captured on the earlier `status_changed`/work events under the supervised session; the affirmation event is the human's own act.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/services/hard-gate-affirm-exec.test.ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "../helpers/db.js";
import { createActor } from "../../src/services/actors.js";
import { setSetting } from "../../src/services/settings.js";
import { openSupervisedSession, resolveSupervisedPrincipal } from "../../src/services/supervised-sessions.js";
import { provenanceOf } from "../../src/services/provenance.js";
import { createIssue, updateIssue, getIssue } from "../../src/services/issues.js";
import { affirmPendingAction } from "../../src/services/hard-gate.js";
import { seedProject } from "../helpers/seed.js";

describe("affirm executes the gated action", () => {
  it("human affirmation commits the previously-blocked done", () => {
    const db = makeTestDb();
    const h = createActor(db, { name: "sean", type: "human" }).actor;
    seedProject(db, "SYD");
    setSetting(db, h, "supervised.hard_gate_actions", ["done"]);
    const { sessionToken } = openSupervisedSession(db, h, "claude-code");
    const prin = resolveSupervisedPrincipal(db, sessionToken)!;
    const prov = provenanceOf(prin);
    const issue = createIssue(db, prin.actor, { projectKey: "SYD", title: "t", description: "d" }, prov);
    updateIssue(db, prin.actor, issue.ref, { status: "in_review" }, {}, prov);

    let pid = 0;
    try {
      updateIssue(db, prin.actor, issue.ref, { status: "done" }, {}, prov);
    } catch {
      pid = db.all<{ id: number }>("SELECT id FROM pending_actions WHERE status='pending' ORDER BY id DESC LIMIT 1")[0].id;
    }
    expect(getIssue(db, issue.ref).status).toBe("in_review");

    affirmPendingAction(db, h, pid);
    expect(getIssue(db, issue.ref).status).toBe("done");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/hard-gate-affirm-exec.test.ts`
Expected: FAIL — affirm flips status of the pending row but never commits the issue change.

- [ ] **Step 3: Make `affirmPendingAction` execute**

In `src/services/hard-gate.ts`, after flipping to `affirmed`, dispatch by `actionType`. Import `updateIssue` and a ref resolver lazily to avoid a cycle, or accept an executor. Concrete approach — resolve the issue ref and call `updateIssue`:

```typescript
import { updateIssue, refOfIssueId } from "./issues.js"; // add refOfIssueId export: number -> "SYD-42"
// ...
export function affirmPendingAction(db: Db, human: Actor, id: number): PendingActionRow {
  if (human.type !== "human") {
    throw new SwitchyardError("Only a human can affirm a gated action — this is the presence check the gate exists for.");
  }
  const row = getPendingAction(db, id);
  if (!row) throw new SwitchyardError(`There is no pending action #${id}.`);
  if (row.status !== "pending") throw new SwitchyardError(`Pending action #${id} is already ${row.status}.`);

  db.update(pendingActions)
    .set({ status: "affirmed", affirmedById: human.id, affirmedAt: nowSec() })
    .where(eq(pendingActions.id, id))
    .run();

  // Execute as the affirming human, with NO session provenance → not re-gated.
  if (row.actionType === "done" || isStatus(row.actionType)) {
    const ref = refOfIssueId(db, row.issueId);
    const patch: Record<string, unknown> = { status: row.actionType };
    if (row.payload.expectedHeadSha !== undefined) patch.expectedHeadSha = row.payload.expectedHeadSha;
    updateIssue(db, human, ref, patch as never, {}, {});
  }
  // (dependency.remove executes via removeDependency in Task 8's sibling wiring.)
  return getPendingAction(db, id)!;
}
```

Add to `src/services/issues.ts`:

```typescript
export function refOfIssueId(db: Db, issueId: number): string {
  const row = db
    .select({ key: projects.key, number: issues.number })
    .from(issues)
    .innerJoin(projects, eq(issues.projectId, projects.id))
    .where(eq(issues.id, issueId))
    .get();
  if (!row) throw new SwitchyardError(`There is no issue with id ${issueId}.`);
  return `${row.key}-${row.number}`;
}
```

`isStatus` = a small guard: `STATUSES.includes(x as never)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/services/hard-gate-affirm-exec.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/hard-gate.ts src/services/issues.ts tests/services/hard-gate-affirm-exec.test.ts
git commit -m "feat: affirming a pending action commits the deferred change (SYD supervised phase 1)"
```

---

## Task 8: MCP + REST surface — open session, dual-attributed writes, affirm endpoint

**Files:**
- Modify: `src/mcp/server.ts` (`buildMcpServer` takes `Principal`; register `open_supervised_session`; forward `Provenance` on write tools)
- Modify: `src/server.ts` (`/mcp` resolves supervised token → `Principal`)
- Modify/Create: `src/rest/pending-actions.ts` + wire into `buildApiRoutes`
- Test: `tests/mcp/supervised-session.test.ts`, `tests/rest/pending-actions.test.ts`

**Interfaces:**
- Consumes: `openSupervisedSession`, `resolveSupervisedPrincipal`, `provenanceOf`, `affirmPendingAction`, `getPendingAction`.
- Produces:
  - MCP tool `open_supervised_session({ agent_name }) -> { session_token, session_id, agent }` (callable by a human-authenticated connection).
  - `/mcp` accepts a `sup_…` token: resolve via `resolveSupervisedPrincipal`; if it resolves, build the server with that `Principal` (guards see the human, writes carry provenance). Fall back to `authenticate` (plain actor → `Principal { actor }`) otherwise.
  - `POST /api/pending-actions/:id/affirm` (human session only) → `affirmPendingAction`.
  - `GET /api/pending-actions?status=pending` → the approval queue for the board.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/mcp/supervised-session.test.ts — via the in-process MCP harness used by other tests/mcp/*.test.ts
// Assert: open_supervised_session returns a token; a subsequent status change made through the
// supervised connection writes an event with via_agent_id + session_id set.
```

```typescript
// tests/rest/pending-actions.test.ts — via the REST test harness (Hono app + supertest-style fetch)
// Assert: POST /api/pending-actions/:id/affirm with a human session commits the deferred done;
// the same call authenticated as the supervised-session token (or an agent) is refused 4xx.
```

> Fill these bodies by copying the exact bootstrap from a neighbouring `tests/mcp/*.test.ts` and `tests/rest/*.test.ts` — reuse their app/harness builders; do not invent new ones.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/supervised-session.test.ts tests/rest/pending-actions.test.ts`
Expected: FAIL — tool/endpoint/`Principal` param don't exist.

- [ ] **Step 3: `buildMcpServer` takes a `Principal`**

Change the signature and internal actor references:

```typescript
export function buildMcpServer(
  db: Db,
  principal: Principal,
  attachmentsDir: string = defaultAttachmentsDir(),
  connectionLeaseToken?: string,
): McpServer {
  const actor = principal.actor;              // guards & whoami keep using this
  const prov = provenanceOf(principal);       // forwarded to write services
  // ... existing tool registrations ...
```

For each **write** tool (`file_issue`→`createIssue`, `update_issue`→`updateIssue`, `claim_issue`→`claimIssue`, `comment`→`addComment`), pass `prov` as the trailing arg to the service call. Read tools are unchanged.

Register the handshake tool (only meaningful for a human-authenticated connection):

```typescript
server.registerTool(
  "open_supervised_session",
  {
    description:
      "Bind this human connection to an editing agent, returning a supervised-session token. " +
      "Present that token as the bearer for subsequent calls so every write is attributed human-via-agent.",
    inputSchema: { agent_name: z.string().default("claude-code") },
  },
  guard(({ agent_name }: { agent_name: string }) => {
    if (actor.type !== "human") {
      throw new SwitchyardError("Only a human connection can open a supervised session.");
    }
    const { sessionToken, sessionId, agent } = openSupervisedSession(db, actor, agent_name);
    return { session_token: sessionToken, session_id: sessionId, agent };
  }),
);
```

- [ ] **Step 4: `/mcp` resolves a supervised token**

In `src/server.ts` `/mcp` handler, before `buildMcpServer`:

```typescript
  const supervised = token ? resolveSupervisedPrincipal(db, token) : null;
  const principal: Principal | null = supervised
    ? supervised
    : actor
      ? { actor }
      : null;
  if (!principal) {
    return c.json({ error: "Missing or invalid bearer token — mint one with the switchyard CLI." }, 401);
  }
  // note: `actor` above is authenticate(db, token) for the plain path; keep it for the fallback.
  const server = buildMcpServer(db, principal, undefined, leaseToken);
```

(Resolve `supervised` first; only call `authenticate` for the plain fallback.)

- [ ] **Step 5: REST affirm + queue endpoints**

In `src/rest/pending-actions.ts` (wire into `buildApiRoutes`):

```typescript
// POST /api/pending-actions/:id/affirm  — human session only
router.post("/pending-actions/:id/affirm", (c) => {
  const human = requireHumanSession(c); // existing REST helper resolving the session actor; must be human
  const row = affirmPendingAction(db, human, Number(c.req.param("id")));
  return c.json(row);
});

// GET /api/pending-actions?status=pending — the approval queue
router.get("/pending-actions", (c) => {
  const status = c.req.query("status") ?? "pending";
  return c.json(listPendingActions(db, status));
});
```

Add `listPendingActions(db, status)` to `hard-gate.ts` (simple select by status, newest-first).

> `requireHumanSession` must reject the supervised-session token and agent tokens — affirmation is structurally the human's own credential, never the session token. If no such REST helper exists, resolve via `getSessionActor` and assert `type === "human"` AND the token is not a `sup_…` supervised token.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/supervised-session.test.ts tests/rest/pending-actions.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/server.ts src/server.ts src/rest/ src/services/hard-gate.ts tests/mcp/supervised-session.test.ts tests/rest/pending-actions.test.ts
git commit -m "feat: MCP open_supervised_session + provenance writes + REST affirm queue (SYD supervised phase 1)"
```

---

## Task 9: Dispatch coexistence — positive `workerPreference` lane

**Files:**
- Modify: the dispatch selection query (grep for `worker_preference`/`selectDispatchable` — SYD-201 lives near `src/services/` dispatch selection)
- Test: `tests/services/dispatch-interactive-lane.test.ts`

**Interfaces:**
- Produces: an issue with `workerPreference === "interactive"` is **never** selected by headless dispatch (it's a lane marker, not a soft sort hint). All other `workerPreference` values keep their existing soft-sort behaviour.

**Design note:** This is the one behavioural change to dispatch. Today `workerPreference` only *sorts*; `"interactive"` must become an *exclusion*. The claim-by-distinct-principal interlock already prevents double-work once claimed; this closes the window *before* a claim by keeping interactive-lane issues out of the headless queue entirely (they also never enter `todo` in normal flow, but the exclusion is the belt-and-braces).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/services/dispatch-interactive-lane.test.ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "../helpers/db.js";
import { selectDispatchable } from "../../src/services/<dispatch-selection-module>.js"; // resolve exact path via grep
import { seedProject, seedIssue } from "../helpers/seed.js";

describe("interactive lane excluded from dispatch", () => {
  it("does not return an issue marked workerPreference=interactive", () => {
    const db = makeTestDb();
    seedProject(db, "SYD");
    const id = seedIssue(db, "SYD", { status: "todo", workerPreference: "interactive" });
    const picks = selectDispatchable(db, /* worker classification args as the real fn takes */);
    expect(picks.map((p: any) => p.id)).not.toContain(id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/dispatch-interactive-lane.test.ts`
Expected: FAIL — the interactive-lane issue is still selected.

- [ ] **Step 3: Exclude the interactive lane in selection**

In the dispatch selection query, add a `WHERE worker_preference IS DISTINCT FROM 'interactive'` equivalent (SQLite: `WHERE (worker_preference IS NULL OR worker_preference != 'interactive')`). Keep the existing soft-sort for all other values.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/services/dispatch-interactive-lane.test.ts`
Expected: PASS.

- [ ] **Step 5: Full verify**

Run: `npm run verify`
Expected: typecheck + build:ui + full test suite PASS (TZ=UTC).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: workerPreference=interactive excludes an issue from headless dispatch (SYD supervised phase 1)"
```

---

## Deferred to Phase 2 (separate plan)

- Native desktop **notification / menu-bar Approve button** and the **Touch-ID-gated keychain** release (the "try it and see if it feels smooth" slice). Phase 1 ships the already-secure web-board affirmation as the interim surface.
- **Per-project** hard-gate lists (Phase 1 is install-global).
- **Provenance rendering** in the web UI beyond the raw event columns (e.g. "✍️ claude-code · under Sean" chips) — the data is captured in Phase 1; the visual treatment is UI polish.
- Supervised-session **lifecycle niceties** (renewal, auto-close on client disconnect).

## Self-Review

- **Spec coverage:** Pillar 1 → Tasks 2, 8. Pillar 2 → Tasks 1, 3, 4. Pillar 3 (full absorption) → free via human-`actor` resolution (Task 8) + hard-gate list Tasks 5–7. Pillar 4 → Task 9 (+ claim interlock is pre-existing). Pillar 5 web-fallback → Tasks 5–8. Pillar 6 → no code (creds follow the human; documented). Native/Touch-ID (pillar 5 primary) → explicitly Phase 2.
- **Reconciliations flagged:** `supervised_session_opened` is the `sessions` row, not an `events` row (events are issue-scoped) — Task 2. Hard-gate list is install-global, not per-project — Task 5. Both are called out at their tasks and in the design's open questions.
- **Type consistency:** `Principal` (principal.ts) and `Provenance` (provenance.ts) are the two threaded types; `provenanceOf` is the sole bridge; `recordEvent`'s new fields match the schema columns `viaAgentId`/`sessionId`; `updateIssue` gains `prov` as its 5th param consistently in Tasks 4/6/7/8.
- **Placeholder scan:** the only intentionally-unresolved references are exact neighbouring-test harness names (`makeTestDb`, `seedProject`, `requireHumanSession`, the dispatch-selection module path) — each is annotated "resolve via grep / copy the neighbour," because inventing a parallel harness would be the real error. Every new production symbol is fully specified.
