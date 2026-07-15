# Supervised Interactive Sessions — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Switchyard a first-class *supervised interactive session* — one human driving one Claude, bound into a single principal — that preserves "an agent edited this, under a named human" provenance, relaxes the guardrails that only exist because dispatched workers are unattended, and coexists cleanly with headless dispatch.

**Architecture:** A supervised session is a **session-kind that binds two actors** (human + agent). The `/mcp` endpoint resolves a supervised-session token to a **Principal** `{ actor: human, viaAgent: agent, sessionId }`. **Human-gated guards keep reading the *human* `actor`** — so full-absorption needs no guard edits — while **agent-scoped tools read `principal.viaAgent`**. The agent identity is threaded into the audit choke point (`recordEvent`) as `Attribution`, so provenance stays honest. A hard-gate list names status transitions that, even in a supervised session, divert to a `pending_actions` row and require a fresh human affirmation by the session's own accountable human (Phase 1: web-board button; the native/Touch-ID surface is Phase 2).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Drizzle ORM + better-sqlite3, `@modelcontextprotocol/sdk`, Hono (REST), Zod v3 (app), Vitest.

## Revision note (Round 1 debate → this plan)

This plan was revised after a five-reviewer debate (codex, gemini, fable, opus, pentester — all REVISE). The structural changes vs. the first draft:

1. **CRITICAL credential-boundary fix.** Supervised tokens live in the shared `sessions` table, and `getSessionActor` (`src/services/auth.ts:55`) resolves *any* session row with **no `kind` filter** — so a `sup_` token presented as the `switchyard_session` cookie authenticated as the full human across the whole REST surface (Task 2 hardens `getSessionActor` to `kind='plain'` + regression test).
2. **Handshake moved out-of-band.** The `open_supervised_session` MCP tool is **removed**. The `sup_` token is minted by the **admin CLI** (like `mint-login`) and the human configures it as their MCP bearer. This fixes both transcript exposure of a high-power token *and* the fact that an MCP client cannot hot-swap its bearer from a tool result.
3. **Affirm lifecycle made transaction-safe** (execute-then-mark, conditional `WHERE status='pending'`), **tied to the session's accountable human**, **deduped**, and **scoped to `done` only** — `dependency.remove` is dropped from Phase 1 entirely (it was advertised but no task implemented it).
4. **`progress_note` (and every agent-scoped tool) reads `viaAgent`**, not the human `actor`, so full absorption doesn't break `requireAgent`.
5. **Default `hard_gate_actions = ["done"]`** — the "agents can't stamp done" invariant stays enforced by default; empty (full absorption) is an explicit opt-in.
6. **Plan-accuracy fixes:** the `Provenance` type is renamed `Attribution` (avoids colliding with the existing `Provenance` at `issues.ts:24`); `buildMcpServer`'s signature is kept backward-compatible (extra optional params, so the 3 existing `tests/mcp/*` don't break); the fabricated `resolveIssueByRef` is `getIssue`; the fabricated `tests/helpers/*` harness is replaced with the repo's real `openDb(":memory:")` idiom; drizzle raw reads use `sql\`…\``; `closeSupervisedSession` soft-closes (FK-safe) instead of deleting; **Task 9 (dispatch exclusion) is deleted** — it already ships at `scripts/worker-select.ts:414`.

## Global Constraints

- **Node 24** — Node 25's WebStorage breaks jsdom tests (SYD-97). Do not bump.
- **All business logic in `src/services/*`** — MCP/REST/UI are thin adapters; no client has private powers.
- **Services throw `SwitchyardError`** for user-facing failures (MCP `guard()` → `isError`; REST → 4xx). `SwitchyardError` carries **only a message** (`src/services/errors.ts:1` — `class SwitchyardError extends Error {}`); it has no structured payload, so any id a client must read goes **in the message string**.
- **Mutate issues only through services** — `events` is a co-written append-only audit log; never write it out-of-band.
- **Migrations are additive and generated** — after editing `src/db/schema.ts`, run `npm run db:generate`. Never hand-edit generated SQL.
- **FKs are enforced at runtime** — `src/db/index.ts:45` runs `PRAGMA foreign_keys = ON` after migrate, in `:memory:` tests too. A row referenced by an FK **cannot be `DELETE`d**; use soft-close.
- **Real test idiom** (no invented harness): `const db = openDb(":memory:")` then `createActor(db, {name,type})`, `createProject(db, human, {key,name})`, `createIssue(db, human, {projectKey,title})` — pattern lives in `tests/services/issues-update.test.ts:19-30`. Raw reads use drizzle `db.all(sql\`… ${x}\`)` / `db.get(sql\`…\`)` — **never** `db.all("SELECT …", [params])` (unsupported).
- **Commit with explicit path lists** — never `git add -A` (stages unrelated worktree changes).
- **Zod v3** in the app; import specifiers end in `.js` (ESM/NodeNext).
- **Run `npm run verify` before done-stamping** (TZ=UTC-pinned typecheck/build:ui/test; mirrors CI).

## File Structure

- `src/db/schema.ts` — `sessions`: add `kind`, `viaAgentId`, `closedAt`; `events`: add `viaAgentId`, `sessionId`; new `pendingActions` table (modify).
- `drizzle/00NN_*.sql` — generated migration (create).
- `src/services/principal.ts` — the `Principal` type (create).
- `src/services/supervised-sessions.ts` — `openSupervisedSession`, `resolveSupervisedPrincipal`, `closeSupervisedSession` (create).
- `src/services/auth.ts` — `getSessionActor` filters `kind='plain'` (modify — the CRITICAL fix).
- `src/services/events.ts` — `recordEvent` gains optional `viaAgentId`/`sessionId` (modify).
- `src/services/attribution.ts` — the `Attribution` type + `attributionOf(principal)` (create).
- `src/services/issues.ts` — thread `Attribution` into `createIssue`/`updateIssue`/`claimIssue` (+ its `updateIssue` delegation); hard-gate divert on `done`; add `refOfIssueId` (modify).
- `src/services/comments.ts`, `needs-input.ts`, `dependencies.ts`, `attachments.ts` — thread `Attribution` into their `recordEvent` calls (modify).
- `src/services/agent-sessions.ts` — `recordProgressNote` acts on the **agent** identity (`viaAgent`), threading attribution (modify).
- `src/services/hard-gate.ts` — hard-gate policy + pending-action create/dedup/list/affirm-and-execute (create).
- `src/services/settings.ts` — register `supervised.hard_gate_actions` (default `["done"]`) (modify).
- `src/mcp/server.ts` — `buildMcpServer` gains optional `attribution` + `viaAgent` params; write tools forward attribution; agent-scoped tools use `viaAgent` (modify).
- `src/server.ts` — `/mcp` resolves supervised token → `Principal`, passes actor+attribution+viaAgent (modify).
- `src/rest/pending-actions.ts` — `POST /api/pending-actions/:id/affirm`, `GET /api/pending-actions` (create; wire into `buildApiRoutes`).
- `src/cli.ts` — `mint-supervised-session <human> <agent>` subcommand (modify).

---

## Task 1: Schema + migration

**Files:**
- Modify: `src/db/schema.ts`
- Create: `drizzle/00NN_supervised_sessions.sql` (generated)
- Test: `tests/db/supervised-schema.test.ts`

**Interfaces:**
- Produces: `sessions.kind` (`"plain"|"supervised"`, default `"plain"`), `sessions.viaAgentId` (nullable FK actors), `sessions.closedAt` (nullable int). `events.viaAgentId` (nullable FK actors), `events.sessionId` (nullable FK sessions). `pendingActions` table.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/db/supervised-schema.test.ts
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { openDb } from "../../src/db/index.js";

describe("supervised-session schema", () => {
  it("sessions has kind, via_agent_id, closed_at", () => {
    const db = openDb(":memory:");
    db.run(sql`INSERT INTO actors (name,type) VALUES ('h','human'),('a','agent')`);
    db.run(sql`INSERT INTO sessions (token_hash,actor_id,via_agent_id,kind,expires_at)
               VALUES ('th',1,2,'supervised',9999999999)`);
    const row = db.get<{ kind: string; via_agent_id: number; closed_at: number | null }>(
      sql`SELECT kind, via_agent_id, closed_at FROM sessions`,
    );
    expect(row!.kind).toBe("supervised");
    expect(row!.via_agent_id).toBe(2);
    expect(row!.closed_at).toBeNull();
  });

  it("pending_actions table exists with the expected shape", () => {
    const db = openDb(":memory:");
    db.run(sql`INSERT INTO actors (name,type) VALUES ('h','human'),('a','agent')`);
    db.run(sql`INSERT INTO sessions (token_hash,actor_id,via_agent_id,kind,expires_at) VALUES ('th',1,2,'supervised',9999999999)`);
    db.run(sql`INSERT INTO projects (key,name) VALUES ('SYD','Switchyard')`);
    db.run(sql`INSERT INTO issues (project_id,number,title,status,creator_id) VALUES (1,1,'t','backlog',1)`);
    db.run(sql`INSERT INTO pending_actions (session_id,issue_id,action_type,payload,status)
               VALUES (1,1,'done','{}','pending')`);
    const row = db.get<{ status: string; action_type: string }>(
      sql`SELECT status, action_type FROM pending_actions`,
    );
    expect(row!.status).toBe("pending");
    expect(row!.action_type).toBe("done");
  });
});
```

> Confirm `openDb` and `db.get(sql\`…\`)`/`db.run(sql\`…\`)` are the real API before running (grep `tests/services/issues-update.test.ts` and `src/services/events.ts:31`). If `openDb` isn't exported from `../../src/db/index.js`, use the exact import the existing service tests use.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/supervised-schema.test.ts`
Expected: FAIL — `no such column: via_agent_id` / `no such table: pending_actions`.

- [ ] **Step 3: Add columns and table to schema**

`sessions` — add after `actorId`:

```typescript
  // Supervised sessions (2026-07-15): a human+agent pair bound into one principal.
  // kind="plain" is the pre-existing single-actor (web login / agent) session;
  // "supervised" also sets viaAgentId. closedAt soft-closes (FKs forbid deleting
  // a session once it has events — see closeSupervisedSession).
  kind: text("kind", { enum: ["plain", "supervised"] }).notNull().default("plain"),
  viaAgentId: integer("via_agent_id").references(() => actors.id),
  closedAt: integer("closed_at"),
```

`events` — add before `createdAt`:

```typescript
    // Dual attribution for supervised sessions (2026-07-15): actorId stays the
    // accountable human; viaAgentId is the agent that did the editing; sessionId
    // ties a run of edits to one supervised session. Null for plain events.
    viaAgentId: integer("via_agent_id").references(() => actors.id),
    sessionId: integer("session_id").references(() => sessions.id),
```

New table (after `sessions`):

```typescript
export const pendingActions = sqliteTable("pending_actions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id").notNull().references(() => sessions.id),
  issueId: integer("issue_id").notNull().references(() => issues.id),
  actionType: text("action_type").notNull(), // Phase 1: "done" only
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  status: text("status", { enum: ["pending", "affirmed", "expired"] }).notNull().default("pending"),
  affirmedById: integer("affirmed_by_id").references(() => actors.id),
  affirmedAt: integer("affirmed_at"),
  createdAt: integer("created_at").notNull().default(now()),
});
```

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate` → new `drizzle/00NN_*.sql`. Do not hand-edit.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/db/supervised-schema.test.ts` → PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts drizzle/ tests/db/supervised-schema.test.ts
git commit -m "feat: schema for supervised sessions, event provenance, pending actions (supervised phase 1)"
```

---

## Task 2: Supervised-session service + the credential-boundary fix

**Files:**
- Create: `src/services/principal.ts`, `src/services/supervised-sessions.ts`
- Modify: `src/services/auth.ts` (`getSessionActor` → `kind='plain'` only), `src/cli.ts` (mint subcommand)
- Test: `tests/services/supervised-sessions.test.ts`, `tests/services/auth-kind-isolation.test.ts`

**Interfaces:**
- Produces:
  - `type Principal = { actor: Actor; viaAgent?: Actor; sessionId?: number }`
  - `openSupervisedSession(db, human: Actor, agentName: string): { sessionToken: string; sessionId: number; agent: Actor }` — human-only root; resolves `agentName` and **requires it be an agent** (rejects a human/service collision); mints `sup_` token.
  - `resolveSupervisedPrincipal(db, token): Principal | null` — resolves only `kind='supervised'`, not closed, not expired, `viaAgent.type==='agent'`.
  - `closeSupervisedSession(db, token): void` — **soft-close** (`closedAt = now`), never `DELETE`.
  - `getSessionActor` resolves **only `kind='plain'`** rows (the CRITICAL fix).

**Design note (security):** `getSessionActor` is the web/REST cookie resolver (`src/rest/api-routes.ts:138`). Supervised tokens must be structurally unresolvable there — filtered by the `kind` **column**, not a token-prefix string check. `resolveSupervisedPrincipal` filters `kind='supervised'`; the two are mutually exclusive by column.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/services/supervised-sessions.test.ts
import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { openSupervisedSession, resolveSupervisedPrincipal, closeSupervisedSession } from "../../src/services/supervised-sessions.js";

const human = (db: any) => createActor(db, { name: "sean", type: "human" }).actor;

describe("supervised sessions", () => {
  it("binds a human and an agent into one resolvable principal", () => {
    const db = openDb(":memory:");
    const h = human(db);
    const { sessionToken, agent } = openSupervisedSession(db, h, "claude-code");
    const p = resolveSupervisedPrincipal(db, sessionToken)!;
    expect(p.actor.id).toBe(h.id);
    expect(p.actor.type).toBe("human");
    expect(p.viaAgent!.id).toBe(agent.id);
    expect(p.viaAgent!.type).toBe("agent");
    expect(typeof p.sessionId).toBe("number");
  });

  it("refuses a non-human root", () => {
    const db = openDb(":memory:");
    const a = createActor(db, { name: "bot", type: "agent" }).actor;
    expect(() => openSupervisedSession(db, a, "claude-code")).toThrow(/only a human can open/i);
  });

  it("refuses to bind a non-agent as the editor (name collision with a human)", () => {
    const db = openDb(":memory:");
    const h = human(db);
    createActor(db, { name: "alice", type: "human" });
    expect(() => openSupervisedSession(db, h, "alice")).toThrow(/must be an agent/i);
  });

  it("does not resolve a closed session", () => {
    const db = openDb(":memory:");
    const h = human(db);
    const { sessionToken } = openSupervisedSession(db, h, "claude-code");
    closeSupervisedSession(db, sessionToken);
    expect(resolveSupervisedPrincipal(db, sessionToken)).toBeNull();
  });
});
```

```typescript
// tests/services/auth-kind-isolation.test.ts  — the CRITICAL regression
import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { openSupervisedSession } from "../../src/services/supervised-sessions.js";
import { getSessionActor } from "../../src/services/auth.js";

describe("supervised token is NOT a web/REST credential", () => {
  it("getSessionActor refuses a supervised (sup_) token", () => {
    const db = openDb(":memory:");
    const h = createActor(db, { name: "sean", type: "human" }).actor;
    const { sessionToken } = openSupervisedSession(db, h, "claude-code");
    // presenting the supervised token on the web cookie path must NOT resolve as the human
    expect(getSessionActor(db, sessionToken)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/services/supervised-sessions.test.ts tests/services/auth-kind-isolation.test.ts`
Expected: FAIL — module missing; and `getSessionActor` currently returns the human for the `sup_` token (the vulnerability).

- [ ] **Step 3: `principal.ts`**

```typescript
// src/services/principal.ts
import type { Actor } from "./actors.js";
/** actor = accountable principal (guards read this). viaAgent = the agent that
 *  did the editing (audit + agent-scoped tools read this). Both undefined for a
 *  plain session. */
export type Principal = { actor: Actor; viaAgent?: Actor; sessionId?: number };
```

- [ ] **Step 4: `supervised-sessions.ts`**

```typescript
// src/services/supervised-sessions.ts
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { actors, sessions } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { getOrCreateActor } from "./actors.js";
import type { Principal } from "./principal.js";
import { SwitchyardError } from "./errors.js";
import { hashToken, mintToken } from "./tokens.js";

const SUPERVISED_TTL = 12 * 3600;
const nowSec = () => Math.floor(Date.now() / 1000);

export function openSupervisedSession(
  db: Db,
  human: Actor,
  agentName: string,
): { sessionToken: string; sessionId: number; agent: Actor } {
  if (human.type !== "human") {
    throw new SwitchyardError("Only a human can open a supervised session — the human is the root of trust.");
  }
  const agent = getOrCreateActor(db, agentName, "agent");
  if (agent.type !== "agent") {
    throw new SwitchyardError(
      `"${agentName}" is a ${agent.type} actor — the supervised editor must be an agent. Pick a distinct agent name.`,
    );
  }
  const sessionToken = mintToken("sup", 32);
  const row = db
    .insert(sessions)
    .values({ tokenHash: hashToken(sessionToken), actorId: human.id, viaAgentId: agent.id, kind: "supervised", expiresAt: nowSec() + SUPERVISED_TTL })
    .returning({ id: sessions.id })
    .get();
  return { sessionToken, sessionId: row.id, agent };
}

export function resolveSupervisedPrincipal(db: Db, sessionToken: string): Principal | null {
  const row = db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, hashToken(sessionToken)), eq(sessions.kind, "supervised"), isNull(sessions.closedAt)))
    .get();
  if (!row || row.viaAgentId === null || row.expiresAt < nowSec()) return null;
  const humanRow = db.select().from(actors).where(eq(actors.id, row.actorId)).get();
  const agentRow = db.select().from(actors).where(eq(actors.id, row.viaAgentId)).get();
  if (!humanRow || !agentRow || humanRow.type !== "human" || agentRow.type !== "agent") return null;
  return {
    actor: { id: humanRow.id, name: humanRow.name, type: humanRow.type },
    viaAgent: { id: agentRow.id, name: agentRow.name, type: agentRow.type },
    sessionId: row.id,
  };
}

export function closeSupervisedSession(db: Db, sessionToken: string): void {
  // Soft-close: FKs (events.session_id, pending_actions.session_id) forbid deleting
  // a session that did work. closedAt makes resolveSupervisedPrincipal return null.
  db.update(sessions).set({ closedAt: nowSec() })
    .where(and(eq(sessions.tokenHash, hashToken(sessionToken)), eq(sessions.kind, "supervised")))
    .run();
}
```

- [ ] **Step 5: Harden `getSessionActor` (the CRITICAL fix)**

In `src/services/auth.ts`, add a `kind='plain'` predicate to the `getSessionActor` query:

```typescript
export function getSessionActor(db: Db, sessionToken: string): Actor | null {
  const row = db
    .select({ s: sessions, a: actors })
    .from(sessions)
    .innerJoin(actors, eq(sessions.actorId, actors.id))
    .where(and(eq(sessions.tokenHash, hashToken(sessionToken)), eq(sessions.kind, "plain")))
    .get();
  if (!row || row.s.expiresAt < nowSec()) return null;
  return { id: row.a.id, name: row.a.name, type: row.a.type };
}
```

(Add `and` to the `drizzle-orm` import in `auth.ts`.)

- [ ] **Step 6: CLI mint subcommand**

In `src/cli.ts`, register `mint-supervised-session <humanName> <agentName>` alongside the existing `mint-login` handler (match that command's shape). It calls `openSupervisedSession(db, human, agentName)` (resolve `human` via the actors table; assert `type==='human'`) and prints the `sup_` token with a note: *"Set this as your MCP client's bearer token. It authorizes supervised writes for <TTL>h; it is NOT a web login."*

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/services/supervised-sessions.test.ts tests/services/auth-kind-isolation.test.ts` → PASS (5 tests).

- [ ] **Step 8: Full auth/session regression**

Run: `npx vitest run tests/services/ tests/rest/` — confirm the `getSessionActor` change didn't break web login (login sessions are `kind='plain'` by default, so they still resolve).

- [ ] **Step 9: Commit**

```bash
git add src/services/principal.ts src/services/supervised-sessions.ts src/services/auth.ts src/cli.ts tests/services/supervised-sessions.test.ts tests/services/auth-kind-isolation.test.ts
git commit -m "feat: supervised-session service + CLI mint + kind-isolated getSessionActor (supervised phase 1)"
```

---

## Task 3: Dual attribution at the audit choke point

**Files:**
- Modify: `src/services/events.ts`
- Create: `src/services/attribution.ts`
- Test: `tests/services/events-attribution.test.ts`

**Interfaces:**
- Produces: `recordEvent(db, e)` with optional `viaAgentId?: number`, `sessionId?: number`; `type Attribution = { viaAgentId?: number; sessionId?: number }`; `attributionOf(principal: Principal): Attribution`.

**Naming note:** the type is `Attribution`, **not** `Provenance` — `src/services/issues.ts:24` already exports a `Provenance` type (issue source), and Task 4 imports into that file.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/services/events-attribution.test.ts
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { openDb } from "../../src/db/index.js";
import { recordEvent } from "../../src/services/events.js";

describe("recordEvent dual attribution", () => {
  it("persists viaAgentId and sessionId when supplied", () => {
    const db = openDb(":memory:");
    db.run(sql`INSERT INTO actors (name,type) VALUES ('h','human'),('a','agent')`);
    db.run(sql`INSERT INTO projects (key,name) VALUES ('SYD','Switchyard')`);
    db.run(sql`INSERT INTO issues (project_id,number,title,status,creator_id) VALUES (1,1,'t','backlog',1)`);
    db.run(sql`INSERT INTO sessions (token_hash,actor_id,via_agent_id,kind,expires_at) VALUES ('t',1,2,'supervised',9999999999)`);
    const id = recordEvent(db, { issueId: 1, actorId: 1, type: "status_changed", viaAgentId: 2, sessionId: 1 });
    const row = db.get<{ via_agent_id: number; session_id: number }>(sql`SELECT via_agent_id, session_id FROM events WHERE id = ${id}`);
    expect(row!.via_agent_id).toBe(2);
    expect(row!.session_id).toBe(1);
  });

  it("leaves both null for a plain event", () => {
    const db = openDb(":memory:");
    db.run(sql`INSERT INTO actors (name,type) VALUES ('h','human')`);
    db.run(sql`INSERT INTO projects (key,name) VALUES ('SYD','Switchyard')`);
    db.run(sql`INSERT INTO issues (project_id,number,title,status,creator_id) VALUES (1,1,'t','backlog',1)`);
    const id = recordEvent(db, { issueId: 1, actorId: 1, type: "status_changed" });
    const row = db.get<{ via_agent_id: number | null; session_id: number | null }>(sql`SELECT via_agent_id, session_id FROM events WHERE id = ${id}`);
    expect(row!.via_agent_id).toBeNull();
    expect(row!.session_id).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/events-attribution.test.ts` → FAIL.

- [ ] **Step 3: Extend `recordEvent`**

```typescript
export function recordEvent(
  db: DbOrTx,
  e: { issueId: number; actorId: number; type: EventKind; payload?: Record<string, unknown>; viaAgentId?: number; sessionId?: number },
): number {
  return db
    .insert(events)
    .values({ issueId: e.issueId, actorId: e.actorId, type: e.type, payload: e.payload ?? {}, viaAgentId: e.viaAgentId ?? null, sessionId: e.sessionId ?? null })
    .returning({ id: events.id })
    .get().id;
}
```

- [ ] **Step 4: `attribution.ts`**

```typescript
// src/services/attribution.ts
import type { Principal } from "./principal.js";
export type Attribution = { viaAgentId?: number; sessionId?: number };
/** The attribution a supervised principal carries; empty for a plain principal. */
export function attributionOf(principal: Principal): Attribution {
  return { viaAgentId: principal.viaAgent?.id, sessionId: principal.sessionId };
}
```

- [ ] **Step 5: Run test to verify it passes** → PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/services/events.ts src/services/attribution.ts tests/services/events-attribution.test.ts
git commit -m "feat: dual attribution in recordEvent + Attribution context (supervised phase 1)"
```

---

## Task 4: Thread attribution through every event-writing mutation

**Files:**
- Modify: `src/services/issues.ts` (`createIssue`, `updateIssue`, `claimIssue` — incl. the internal `updateIssue` delegation), `comments.ts` (`addComment`), `needs-input.ts` (`requestHumanInput`), `dependencies.ts` (`addDependency`), `attachments.ts` (`saveAttachment`)
- Modify: `src/services/agent-sessions.ts` (`recordProgressNote` — see Design note)
- Test: `tests/services/supervised-attribution-e2e.test.ts`

**Interfaces:**
- Consumes: `Attribution`.
- Produces: each event-writing service fn accepts a trailing `attr: Attribution = {}` and spreads `viaAgentId: attr.viaAgentId, sessionId: attr.sessionId` into **every** `recordEvent` call it makes — including through delegations.

**Design note 1 (human-gated vs agent-scoped):** the `actor` passed to human-gated fns stays the **human** (guards pass — full absorption). But `recordProgressNote` requires `actor.type === "agent"` (`src/services/agent-sessions.ts:45-49`). Agent-scoped tools must therefore act on the **agent** identity, not the human. Do **not** pass the human `actor` to `recordProgressNote` for a supervised session — the MCP layer (Task 7) passes `viaAgent` as the actor. `recordProgressNote` still gains the `attr` param so its event carries `sessionId` (its `actorId` is already the agent).

**Design note 2 (delegation):** `claimIssue`'s fresh-claim path delegates to `updateIssue` (`src/services/issues.ts:661`). Forward `attr` into that nested `updateIssue(...)` call, or the `assigned`/`status_changed` events of a supervised claim are unattributed.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/services/supervised-attribution-e2e.test.ts
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { openSupervisedSession, resolveSupervisedPrincipal } from "../../src/services/supervised-sessions.js";
import { attributionOf } from "../../src/services/attribution.js";
import { createIssue, updateIssue } from "../../src/services/issues.js";

describe("supervised attribution end to end", () => {
  it("a supervised status change records via_agent + session", () => {
    const db = openDb(":memory:");
    const h = createActor(db, { name: "sean", type: "human" }).actor;
    createProject(db, h, { key: "SYD", name: "Switchyard" });
    const { sessionToken } = openSupervisedSession(db, h, "claude-code");
    const prin = resolveSupervisedPrincipal(db, sessionToken)!;
    const attr = attributionOf(prin);
    const issue = createIssue(db, prin.actor, { projectKey: "SYD", title: "t", description: "d" }, attr);
    updateIssue(db, prin.actor, issue.ref, { status: "in_review" }, {}, attr);
    const row = db.get<{ via_agent_id: number; session_id: number }>(
      sql`SELECT via_agent_id, session_id FROM events WHERE type='status_changed' ORDER BY id DESC LIMIT 1`,
    );
    expect(row!.via_agent_id).toBe(prin.viaAgent!.id);
    expect(row!.session_id).toBe(prin.sessionId);
  });
});
```

> Confirm the real `createProject` signature (`src/services/projects.ts`) and `createIssue`/`updateIssue` arg order before wiring. `updateIssue` is `(db, actor, ref, patch, lease, attr)` — `attr` is the **6th** param (after `lease`, the 5th).

- [ ] **Step 2: Run test to verify it fails** → FAIL (attr arg not accepted / events lack ids).

- [ ] **Step 3: Thread `attr`**

For `createIssue`, `updateIssue`, `claimIssue` (`issues.ts`), `addComment` (`comments.ts`), `requestHumanInput` (`needs-input.ts`), `addDependency` (`dependencies.ts`), `saveAttachment` (`attachments.ts`), and `recordProgressNote` (`agent-sessions.ts`):

1. Add a trailing `attr: Attribution = {}` (import from `./attribution.js`). For `updateIssue` add it as the **6th** parameter, after `lease`.
2. Spread into every `recordEvent(...)` in the fn body:
   ```typescript
   recordEvent(tx, { issueId: current.id, actorId: actor.id, type: "status_changed",
     payload: { from: current.status, to: patch.status },
     viaAgentId: attr.viaAgentId, sessionId: attr.sessionId });
   ```
   (`updateIssue` funnels through one loop `for (const e of toRecord) recordEvent(tx, …)` at `src/services/issues.ts:581-582` — add the two fields there once. `createIssue` records at :189, `claimIssue` at :644.)
3. `claimIssue`'s fresh-claim delegation to `updateIssue` (`issues.ts:661`) must pass `attr` through.
4. Leave all guard logic untouched.

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Full service suite (no regressions from the new optional param)**

Run: `npx vitest run tests/services/` → PASS (default `{}` keeps existing callers unaffected).

- [ ] **Step 6: Commit**

```bash
git add src/services/issues.ts src/services/comments.ts src/services/needs-input.ts src/services/dependencies.ts src/services/attachments.ts src/services/agent-sessions.ts tests/services/supervised-attribution-e2e.test.ts
git commit -m "feat: thread supervised attribution through all event-writing mutations (supervised phase 1)"
```

---

## Task 5: Hard-gate policy + pending-action service (done-scoped, transaction-safe)

**Files:**
- Modify: `src/services/settings.ts` (register the setting, default `["done"]`)
- Create: `src/services/hard-gate.ts`
- Test: `tests/services/hard-gate.test.ts`

**Scope:** Phase 1 gates **status transitions only**, and ships `done` as the sole supported action-type. `dependency.remove` is explicitly **out** of Phase 1 (no schema/settings/File-Structure reference to it). `affirmPendingAction` refuses any action-type it has no executor for.

**Interfaces:**
- Produces:
  - setting `supervised.hard_gate_actions: string[]` (default `["done"]`).
  - `isHardGated(db, actionType): boolean`
  - `findOrCreatePendingAction(db, sessionId, issueId, actionType, payload): number` — **deduped**: returns an existing `pending` row for the same `(sessionId, issueId, actionType)` instead of inserting a duplicate.
  - `getPendingAction(db, id): PendingActionRow | null`
  - `listPendingActions(db, status): PendingActionRow[]`
  - `affirmPendingAction(db, human, id): PendingActionRow` — see Design note.

**Design note (affirm must be correct):**
1. **Owner tie:** the affirming `human.id` must equal the pending action's session `actorId` (the accountable human). A different human is refused.
2. **Transaction-safe execute-then-mark:** run inside `db.transaction`; conditionally claim the row (`UPDATE … SET status='affirmed' … WHERE id=? AND status='pending'` — 0 rows changed ⇒ already taken ⇒ throw); then execute; if execution throws, the transaction rolls back the claim so the row stays `pending` and re-affirmable.
3. **Executor guard:** only `actionType==='done'` (a status) has an executor in Phase 1; anything else throws (never silently no-ops).
4. **Stale SHA:** the executor re-drives `updateIssue` **as the human, no session attr** (so the Task-6 divert is skipped). If `updateIssue` throws "head moved"/"pass expectedHeadSha", that propagates out and the rollback leaves the action re-affirmable — the human re-reviews and re-affirms.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/services/hard-gate.test.ts
import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { setSetting } from "../../src/services/settings.js";
import { openSupervisedSession, resolveSupervisedPrincipal } from "../../src/services/supervised-sessions.js";
import { isHardGated, findOrCreatePendingAction, affirmPendingAction, getPendingAction } from "../../src/services/hard-gate.js";

function setup() {
  const db = openDb(":memory:");
  const h = createActor(db, { name: "sean", type: "human" }).actor;
  createProject(db, h, { key: "SYD", name: "Switchyard" });
  const { sessionToken } = openSupervisedSession(db, h, "claude-code");
  const prin = resolveSupervisedPrincipal(db, sessionToken)!;
  return { db, h, prin };
}

describe("hard gate", () => {
  it("defaults to gating done", () => {
    const { db } = setup();
    expect(isHardGated(db, "done")).toBe(true);
  });

  it("dedups pending actions for the same (session, issue, action)", () => {
    const { db, h, prin } = setup();
    db.run(sqlInsertIssue()); // helper below, or inline a createIssue
    const a = findOrCreatePendingAction(db, prin.sessionId!, 1, "done", { status: "done" });
    const b = findOrCreatePendingAction(db, prin.sessionId!, 1, "done", { status: "done" });
    expect(a).toBe(b);
  });

  it("a different human cannot affirm another human's action", () => {
    const { db, prin } = setup();
    db.run(sqlInsertIssue());
    const other = createActor(db, { name: "mallory", type: "human" }).actor;
    const pid = findOrCreatePendingAction(db, prin.sessionId!, 1, "done", { status: "done" });
    expect(() => affirmPendingAction(db, other, pid)).toThrow(/only the accountable human/i);
  });

  it("an agent cannot affirm", () => {
    const { db, prin } = setup();
    db.run(sqlInsertIssue());
    const agent = createActor(db, { name: "bot", type: "agent" }).actor;
    const pid = findOrCreatePendingAction(db, prin.sessionId!, 1, "done", { status: "done" });
    expect(() => affirmPendingAction(db, agent, pid)).toThrow(/only .*human/i);
  });
});
```

> Replace `sqlInsertIssue()` with a real `createIssue(db, h, { projectKey: "SYD", title: "t", description: "d" })` (issue id 1) — inline it; the placeholder is shorthand, not a helper to create.

- [ ] **Step 2: Run test to verify it fails** → FAIL (module/setting missing).

- [ ] **Step 3: Register the setting (default `["done"]`)**

In `src/services/settings.ts` `REGISTRY`:

```typescript
  "supervised.hard_gate_actions": {
    type: "string[]",
    default: ["done"] as string[],
    description:
      "Status transitions that still require a fresh human affirmation inside a supervised session. Default [\"done\"] keeps the human-only done-stamp enforced; set [] for full absorption (opt-in).",
  },
```

- [ ] **Step 4: Write `hard-gate.ts`**

```typescript
// src/services/hard-gate.ts
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { pendingActions, sessions } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { getSetting } from "./settings.js";
import { updateIssue, refOfIssueId } from "./issues.js";

const nowSec = () => Math.floor(Date.now() / 1000);
export type PendingActionRow = typeof pendingActions.$inferSelect;

export function isHardGated(db: Db, actionType: string): boolean {
  return getSetting(db, "supervised.hard_gate_actions").includes(actionType);
}

export function findOrCreatePendingAction(
  db: Db, sessionId: number, issueId: number, actionType: string, payload: Record<string, unknown>,
): number {
  const existing = db.select({ id: pendingActions.id }).from(pendingActions)
    .where(and(eq(pendingActions.sessionId, sessionId), eq(pendingActions.issueId, issueId), eq(pendingActions.actionType, actionType), eq(pendingActions.status, "pending")))
    .get();
  if (existing) return existing.id;
  return db.insert(pendingActions).values({ sessionId, issueId, actionType, payload, status: "pending" }).returning({ id: pendingActions.id }).get().id;
}

export function getPendingAction(db: Db, id: number): PendingActionRow | null {
  return db.select().from(pendingActions).where(eq(pendingActions.id, id)).get() ?? null;
}

export function listPendingActions(db: Db, status = "pending"): PendingActionRow[] {
  return db.select().from(pendingActions).where(eq(pendingActions.status, status as PendingActionRow["status"])).all();
}

export function affirmPendingAction(db: Db, human: Actor, id: number): PendingActionRow {
  if (human.type !== "human") {
    throw new SwitchyardError("Only a human can affirm a gated action — this is the presence check the gate exists for.");
  }
  const row = getPendingAction(db, id);
  if (!row) throw new SwitchyardError(`There is no pending action #${id}.`);
  if (row.status !== "pending") throw new SwitchyardError(`Pending action #${id} is already ${row.status}.`);
  const owner = db.select({ actorId: sessions.actorId }).from(sessions).where(eq(sessions.id, row.sessionId)).get();
  if (!owner || owner.actorId !== human.id) {
    throw new SwitchyardError("Only the accountable human who opened this supervised session can affirm its gated actions.");
  }
  if (row.actionType !== "done") {
    throw new SwitchyardError(`Pending action #${id} has action-type "${row.actionType}", which has no executor in this version.`);
  }
  db.transaction((tx) => {
    // Conditionally claim the row; 0 rows changed means a concurrent affirm won.
    const claimed = tx.update(pendingActions).set({ status: "affirmed", affirmedById: human.id, affirmedAt: nowSec() })
      .where(and(eq(pendingActions.id, id), eq(pendingActions.status, "pending"))).run();
    if (claimed.changes === 0) throw new SwitchyardError(`Pending action #${id} was already taken.`);
    // Execute as the human, NO session attribution → Task-6 divert is skipped.
    const ref = refOfIssueId(tx, row.issueId);
    const patch: Record<string, unknown> = { status: "done" };
    if (row.payload.expectedHeadSha !== undefined) patch.expectedHeadSha = row.payload.expectedHeadSha;
    updateIssue(tx, human, ref, patch as never, {}, {}); // throws here → tx rolls back the claim → still pending
  });
  return getPendingAction(db, id)!;
}
```

> `refOfIssueId` is added in Task 6 (Task 5 and 6 land together if the implementer prefers; the import is forward-declared here). `updateIssue` must accept a `DbOrTx` first arg — confirm it does (it opens its own `db.transaction`; nested better-sqlite3 transactions are savepoints, which is fine, but **verify** by running the affirm test, not by assumption).

- [ ] **Step 5: Run test to verify it passes** → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/settings.ts src/services/hard-gate.ts tests/services/hard-gate.test.ts
git commit -m "feat: hard-gate policy + transaction-safe, owner-tied, deduped pending actions (supervised phase 1)"
```

---

## Task 6: Divert a gated `done` to pending; add `refOfIssueId`; execute on affirm

**Files:**
- Modify: `src/services/issues.ts` (`updateIssue` pre-transaction divert; add `refOfIssueId`)
- Test: `tests/services/hard-gate-divert.test.ts`, `tests/services/hard-gate-affirm-exec.test.ts`

**Interfaces:**
- Consumes: `isHardGated`, `findOrCreatePendingAction` (`hard-gate.ts`); `Attribution`.
- Produces: `refOfIssueId(db: DbOrTx, issueId): string`; a supervised (`attr.sessionId != null`) `updateIssue` to a hard-gated status **that actually changes status** creates/reuses a pending action and throws, committing nothing.

**Design note (avoid three sub-bugs the reviewers flagged):**
- Fire only when `patch.status !== undefined && patch.status !== current.status && isHardGated(db, patch.status)` — never on a `done → done` no-op.
- **Reject mixed patches:** if the patch also sets non-status fields (priority/labels/title/assignee/parent/description), throw "split the gated status change into its own call" — Phase 1 only defers `status`, so a mixed patch would silently drop the rest.
- Load the issue with `getIssue(db, ref)` (there is no `resolveIssueByRef`).

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/services/hard-gate-divert.test.ts
import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { openSupervisedSession, resolveSupervisedPrincipal } from "../../src/services/supervised-sessions.js";
import { attributionOf } from "../../src/services/attribution.js";
import { createIssue, updateIssue, getIssue } from "../../src/services/issues.js";
import { sql } from "drizzle-orm";

function supervised() {
  const db = openDb(":memory:");
  const h = createActor(db, { name: "sean", type: "human" }).actor;
  createProject(db, h, { key: "SYD", name: "Switchyard" });
  const { sessionToken } = openSupervisedSession(db, h, "claude-code");
  const prin = resolveSupervisedPrincipal(db, sessionToken)!;
  return { db, h, prin, attr: attributionOf(prin) };
}

describe("hard-gated done in a supervised session", () => {
  it("does not commit; creates exactly one pending action; dedups on retry", () => {
    const { db, prin, attr } = supervised();
    const issue = createIssue(db, prin.actor, { projectKey: "SYD", title: "t", description: "d" }, attr);
    updateIssue(db, prin.actor, issue.ref, { status: "in_review" }, {}, attr);
    expect(() => updateIssue(db, prin.actor, issue.ref, { status: "done" }, {}, attr)).toThrow(/awaiting human affirmation/i);
    expect(() => updateIssue(db, prin.actor, issue.ref, { status: "done" }, {}, attr)).toThrow(/awaiting human affirmation/i);
    expect(getIssue(db, issue.ref).status).toBe("in_review");
    const n = db.get<{ c: number }>(sql`SELECT COUNT(*) c FROM pending_actions WHERE status='pending'`);
    expect(n!.c).toBe(1); // deduped
  });

  it("a plain human done-stamp is NOT diverted even when done is gated", () => {
    const { db, h } = supervised();
    const issue = createIssue(db, h, { projectKey: "SYD", title: "t", description: "d" });
    updateIssue(db, h, issue.ref, { status: "in_review" });
    updateIssue(db, h, issue.ref, { status: "done" });
    expect(getIssue(db, issue.ref).status).toBe("done");
  });
});
```

```typescript
// tests/services/hard-gate-affirm-exec.test.ts
import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { openSupervisedSession, resolveSupervisedPrincipal } from "../../src/services/supervised-sessions.js";
import { attributionOf } from "../../src/services/attribution.js";
import { createIssue, updateIssue, getIssue } from "../../src/services/issues.js";
import { affirmPendingAction, listPendingActions } from "../../src/services/hard-gate.js";

describe("affirm executes the gated done", () => {
  it("the session's human affirmation commits the blocked done", () => {
    const db = openDb(":memory:");
    const h = createActor(db, { name: "sean", type: "human" }).actor;
    createProject(db, h, { key: "SYD", name: "Switchyard" });
    const { sessionToken } = openSupervisedSession(db, h, "claude-code");
    const prin = resolveSupervisedPrincipal(db, sessionToken)!;
    const attr = attributionOf(prin);
    const issue = createIssue(db, prin.actor, { projectKey: "SYD", title: "t", description: "d" }, attr);
    updateIssue(db, prin.actor, issue.ref, { status: "in_review" }, {}, attr);
    try { updateIssue(db, prin.actor, issue.ref, { status: "done" }, {}, attr); } catch { /* diverted */ }
    const pid = listPendingActions(db, "pending")[0].id;
    affirmPendingAction(db, h, pid);
    expect(getIssue(db, issue.ref).status).toBe("done");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail** → FAIL.

- [ ] **Step 3: Add `refOfIssueId` and the divert**

Add to `issues.ts` (ensure `projects` is imported from `../db/schema.js`):

```typescript
export function refOfIssueId(db: DbOrTx, issueId: number): string {
  const row = db.select({ key: projects.key, number: issues.number }).from(issues)
    .innerJoin(projects, eq(issues.projectId, projects.id)).where(eq(issues.id, issueId)).get();
  if (!row) throw new SwitchyardError(`There is no issue with id ${issueId}.`);
  return `${row.key}-${row.number}`;
}
```

In `updateIssue`, **before** the mutation transaction opens:

```typescript
  if (attr.sessionId != null && patch.status !== undefined && isHardGated(db, patch.status)) {
    const target = getIssue(db, ref); // throws if missing; has .id, .status
    if (patch.status !== target.status) {
      const otherKeys = Object.keys(patch).filter((k) => k !== "status" && k !== "expectedHeadSha");
      if (otherKeys.length > 0) {
        throw new SwitchyardError(`A hard-gated status change to "${patch.status}" must be its own call — move ${otherKeys.join(", ")} to a separate update.`);
      }
      const pendingActionId = findOrCreatePendingAction(db, attr.sessionId, target.id, patch.status, {
        status: patch.status, ...(patch.expectedHeadSha !== undefined ? { expectedHeadSha: patch.expectedHeadSha } : {}),
      });
      throw new SwitchyardError(`Awaiting human affirmation: ${ref} → ${patch.status} is hard-gated (pending action #${pendingActionId}). A human must approve it in the board. Nothing was changed.`);
    }
  }
```

(Import `isHardGated`, `findOrCreatePendingAction` from `./hard-gate.js` — a two-way import with hard-gate.ts; if the cycle bites at runtime, move `refOfIssueId` + the divert helpers into `hard-gate.ts` and have `updateIssue` call one `maybeDivert(db, ref, patch, attr)` helper. Verify by running the tests, not by assuming.)

- [ ] **Step 4: Run tests to verify they pass** → PASS (3 tests across the two files).

- [ ] **Step 5: Commit**

```bash
git add src/services/issues.ts tests/services/hard-gate-divert.test.ts tests/services/hard-gate-affirm-exec.test.ts
git commit -m "feat: divert gated done to pending (deduped, no-op-safe, mixed-patch-rejected) + affirm executes (supervised phase 1)"
```

---

## Task 7: MCP + REST surface (no in-band handshake)

**Files:**
- Modify: `src/mcp/server.ts` (`buildMcpServer` optional `attribution` + `viaAgent`; write tools forward attribution; agent-scoped tools use `viaAgent`)
- Modify: `src/server.ts` (`/mcp` resolves supervised token → Principal)
- Create: `src/rest/pending-actions.ts` (+ wire into `buildApiRoutes`)
- Test: `tests/mcp/supervised-write.test.ts`, `tests/rest/pending-actions.test.ts`

**Interfaces:**
- `buildMcpServer(db, actor, attachmentsDir?, connectionLeaseToken?, attribution: Attribution = {}, viaAgent?: Actor)` — **backward-compatible**: the three existing callers (`tests/mcp/lease-tools.test.ts:13`, `read-tools.test.ts:16`, `write-tools.test.ts:21`) pass ≤3 args and are unaffected; the new params default.
- `/mcp` resolves a `sup_` bearer via `resolveSupervisedPrincipal`; if it resolves, build with `actor = principal.actor`, `attribution = attributionOf(principal)`, `viaAgent = principal.viaAgent`. Else fall back to `authenticate` (plain actor, `attribution = {}`, no viaAgent).
- `POST /api/pending-actions/:id/affirm` (human web session only) → `affirmPendingAction`.
- `GET /api/pending-actions?status=pending` → the approval queue.
- **No `open_supervised_session` MCP tool** — minting is CLI-only (Task 2).

**Design note (agent-scoped tools):** in `buildMcpServer`, the write tools (`file_issue`→`createIssue`, `update_issue`→`updateIssue`, `claim_issue`→`claimIssue`, `comment`→`addComment`, `add_dependency`, `attach_file`, `request_human_input`) pass `attribution`. The **agent-scoped** `progress_note`→`recordProgressNote` must pass `viaAgent ?? actor` as its actor (a supervised session's editor is the agent; a plain agent session's actor is already the agent). If `viaAgent` is undefined and `actor.type !== 'agent'` (a plain human calling `progress_note`), the existing `requireAgent` error stands — unchanged behavior.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/mcp/supervised-write.test.ts — copy the harness from tests/mcp/write-tools.test.ts
// Build the server with a supervised principal's parts:
//   buildMcpServer(db, prin.actor, attachmentsDir, undefined, attributionOf(prin), prin.viaAgent)
// Drive update_issue to in_review, assert the status_changed event row has via_agent_id === prin.viaAgent.id
// and session_id === prin.sessionId. Also assert progress_note succeeds (acts as the agent) and its event
// carries session_id.
```

```typescript
// tests/rest/pending-actions.test.ts — copy the harness from a neighbouring tests/rest/*.test.ts
// (createApp(db) + fetch). Assert:
//  - POST /api/pending-actions/:id/affirm with the OWNER human's session cookie commits the deferred done.
//  - the same POST with an agent bearer, or a different human, is 4xx.
//  - GET /api/pending-actions?status=pending lists the queued action.
```

> Fill both bodies from the exact bootstrap in the neighbouring `tests/mcp/*.test.ts` / `tests/rest/*.test.ts`; do not invent a harness. Grounding: `buildMcpServer` is called as `buildMcpServer(db, actor, …)` in those files today (confirmed at `tests/mcp/write-tools.test.ts:21`) — the extra params are appended, so those files keep compiling unchanged.

- [ ] **Step 2: Run tests to verify they fail** → FAIL.

- [ ] **Step 3: `buildMcpServer` params + wiring**

```typescript
export function buildMcpServer(
  db: Db,
  actor: Actor,
  attachmentsDir: string = defaultAttachmentsDir(),
  connectionLeaseToken?: string,
  attribution: Attribution = {},
  viaAgent?: Actor,
): McpServer {
  // ... existing tool registrations, with:
  //   write tools:  <service>(db, actor, …, attribution)
  //   progress_note: recordProgressNote(db, viaAgent ?? actor, …, attribution)
```

Import `Attribution` from `../services/attribution.js`. Do **not** register `open_supervised_session`.

- [ ] **Step 4: `/mcp` resolution**

In `src/server.ts`, before `buildMcpServer`:

```typescript
  const supervised = token ? resolveSupervisedPrincipal(db, token) : null;
  const plainActor = supervised ? null : (token ? authenticate(db, token) : null);
  if (!supervised && !plainActor) {
    return c.json({ error: "Missing or invalid bearer token — mint one with the switchyard CLI." }, 401);
  }
  const actor = supervised ? supervised.actor : plainActor!;
  const attribution = supervised ? attributionOf(supervised) : {};
  const viaAgent = supervised?.viaAgent;
  const server = buildMcpServer(db, actor, undefined, leaseToken, attribution, viaAgent);
```

- [ ] **Step 5: REST affirm + queue**

`src/rest/pending-actions.ts`, wired into `buildApiRoutes`:

```typescript
router.post("/pending-actions/:id/affirm", (c) => {
  const actor = c.var.actor; // resolved by existing middleware; getSessionActor now rejects sup_ tokens (Task 2)
  if (!actor || actor.type !== "human") return c.json({ error: "human session required" }, 403);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "invalid id" }, 400); // mirror parseActorId
  try {
    return c.json(affirmPendingAction(db, actor, id));
  } catch (e) {
    if (e instanceof SwitchyardError) return c.json({ error: e.message }, 403);
    throw e;
  }
});

router.get("/pending-actions", (c) => c.json(listPendingActions(db, c.req.query("status") ?? "pending")));
```

> Match the repo's actual REST error-mapping convention (grep how other routes turn `SwitchyardError` into a 4xx — there may be shared middleware). Validate `id` like `parseActorId` (`src/rest/api-routes.ts`) rather than hand-rolling if that helper is exported.

- [ ] **Step 6: Run tests to verify they pass** → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/server.ts src/server.ts src/rest/pending-actions.ts tests/mcp/supervised-write.test.ts tests/rest/pending-actions.test.ts
git commit -m "feat: /mcp supervised principal resolution + attributed writes + REST affirm queue (supervised phase 1)"
```

---

## Task 8: Full verify

- [ ] **Step 1: Run the whole suite the way CI does**

Run: `npm run verify`
Expected: node-version check + TZ=UTC typecheck + build:ui + full test suite PASS. In particular confirm the three pre-existing `tests/mcp/*` still pass (the `buildMcpServer` params are additive) and web login (`tests/rest/*` auth) still works after the `getSessionActor` `kind='plain'` filter.

- [ ] **Step 2: Commit any lint/type fixups**

```bash
git add -p   # stage reviewed hunks explicitly; no git add -A
git commit -m "chore: verify green for supervised sessions phase 1"
```

---

## Deferred to later phases (separate plans)

- **Phase 2:** native desktop notification / menu-bar Approve button + Touch-ID-gated keychain release (the "try it and see if it feels smooth" slice). Phase 1 ships the web-board affirmation as the interim surface.
- **`dependency.remove` gating** (and any non-status gated action): needs its own divert in `removeDependency` + an executor branch in `affirmPendingAction`. Out of Phase 1 by design.
- **Per-project** hard-gate lists (Phase 1 is install-global).
- **Provenance rendering** in the web UI ("✍️ claude-code · under Sean" chips) — data captured in Phase 1; visual treatment is polish.
- **Supervised-session lifecycle**: wiring `closeSupervisedSession` to a CLI/REST endpoint, renewal, expiry sweep.

## Self-Review

- **Spec coverage:** Pillar 1 → Task 2 (CLI mint + resolve) + Task 7 (/mcp). Pillar 2 → Tasks 1, 3, 4. Pillar 3 (full absorption) → free via human-`actor` resolution + hard-gate Tasks 5–6, default `["done"]`. Pillar 4 → **pre-existing** `scripts/worker-select.ts:414` exclusion + the claim interlock (Task 9 deleted — it was already implemented). Pillar 5 web-fallback → Tasks 5–7. Pillar 6 → creds follow the human (documented; no code). Native/Touch-ID → Phase 2.
- **Round-1 CRITICAL/MAJOR/HIGH resolution:** credential boundary → Task 2 (getSessionActor kind filter + regression test). Out-of-band handshake → Task 2 CLI, no MCP tool, Task 7 removes it. Affirm lifecycle → Task 5 (tx-safe, owner-tied, executor-guarded). dependency.remove → dropped from Phase 1 scope. progress_note → Task 4/7 (viaAgent). Default gate `["done"]` → Task 5. Provenance name collision → `Attribution`. buildMcpServer breakage → additive params (Task 7). closeSupervisedSession FK → soft-close (Task 2). Task 9 already-shipped → deleted. Test harness → real `openDb(":memory:")` idiom throughout. drizzle raw-read API → `sql\`…\``. resolveIssueByRef → `getIssue`/`refOfIssueId`. Pending dedup + no-op guard + mixed-patch reject + validate → Task 6. Any-human-affirm → owner tie (Task 5). REST id NaN→500 → integer guard (Task 7). git add -A → explicit paths.
- **Residual known-simplifications (called out, not hidden):** `SwitchyardError` carries the pending-action id in its **message string**, not a structured field (repo's error type has no payload); the affirm queue `GET` is readable by any authed actor (low impact; a human-only scope is a one-line follow-up); nested `updateIssue`-inside-`affirm` transaction relies on better-sqlite3 savepoints — **verified by the Task-5/6 affirm tests**, not by assumption.
