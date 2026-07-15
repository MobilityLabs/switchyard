# Supervised Interactive Sessions — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Switchyard a first-class *supervised interactive session* — one human driving one Claude, bound into a single principal — that preserves "an agent edited this, under a named human" provenance, relaxes the guardrails that only exist because dispatched workers are unattended, and coexists cleanly with headless dispatch.

**Architecture:** A supervised session is a **session-kind that binds two actors** (human + agent). The `/mcp` endpoint resolves a supervised-session token to a **Principal** `{ actor: human, viaAgent: agent, sessionId }`. **Human-gated guards keep reading the *human* `actor`** — so full-absorption needs no guard edits — while **agent-scoped tools read `principal.viaAgent`**. The agent identity is threaded into the audit choke point (`recordEvent`) as `Attribution`, so provenance stays honest. A hard-gate list names status transitions that, even in a supervised session, divert to a `pending_actions` row and require a fresh human affirmation by the session's own accountable human, made through the **web board** (the only surface Claude can't drive). Note the full-absorption trade: a supervised `createIssue` lands in `backlog` (not `triage`) with no provenance requirement — the actor is the human — and the agent's hand survives only in the `created` event's `viaAgentId`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Drizzle ORM + better-sqlite3, `@modelcontextprotocol/sdk`, Hono (REST), React + Vite (UI), Zod v3 (app), Vitest.

## Threat boundary / containment model (READ FIRST — load-bearing)

The security of this feature rests on **one operational invariant that no code can enforce**, so it is stated here as a hard requirement:

> **The supervised Claude process is provisioned with the `sup_` token and nothing else. It MUST NOT be given *any* human's web-session cookie (`switchyard_session`, `kind='plain'`) or *any* human-principal actor bearer (`syd_…`) — not just the accountable human's. If it is, the hard-gate and affirmation provide no protection.**

("Any human," not "the accountable human," is deliberate: `setSetting`'s `requireHuman` (`src/services/settings.ts:138-141`) accepts **any** human actor, so *any* human credential in the agent's environment can disable the gate. In practice the env is provisioned by its own accountable human, but the invariant must be stated at its true width.)

Why: full absorption means `principal.actor` *is* the human, so every human-gated guard passes; only hard-gated statuses (`done`) divert to an affirmation. That containment holds **only** while the agent can't authenticate as the human on the REST surface. If the agent process also holds the human's cookie or `syd_` bearer, it can call `POST /pending-actions/:id/affirm` (owner tie passes — it *is* the human) and `PUT /settings/supervised.hard_gate_actions` (human passes `requireHuman`) directly, defeating both the affirmation and the policy. The credential-layer fixes below (Task 2 `getSessionActor`/`deleteSession` `kind` filters; Task 7 cookie-only affirm) close the paths a `sup_` token could take; this invariant closes the path a *leaked human credential* would take, and only operational discipline can do that. The CLI mint (Task 2) prints this warning; the honest scope of Phase 1's guarantee is **"provenance always; containment only under this invariant."**

**Load-bearing corollary — do not add a settings-write MCP tool.** Under full absorption `principal.actor` *is* the human, so `setSetting`'s `requireHuman` would pass for a supervised session. The only reason a `sup_`-only agent cannot disable its own gate (`supervised.hard_gate_actions = []`) is that **the MCP tool registry exposes no settings-write tool** — `setSetting` is reachable only via `PUT /api/settings/:key`, which a `sup_` token cannot authenticate to. This is a real containment dependency, not an accident to rely on silently: any future PR adding a `set_setting`-style MCP tool **breaks containment** and must gate it on `principal.viaAgent == null` (or exclude supervised sessions explicitly).

## Revision history

- **Round 1 debate (all 5 REVISE) → v2:** credential-boundary fix (`getSessionActor` kind filter); out-of-band CLI handshake (removed the `open_supervised_session` MCP tool); transaction-safe/owner-tied/deduped affirm; `dependency.remove` dropped from Phase 1; `progress_note` reads `viaAgent`; default gate `["done"]`; `Provenance`→`Attribution` rename; additive `buildMcpServer`; soft-close; Task 9 deleted (already ships at `scripts/worker-select.ts:415`); real `openDb(":memory:")` test idiom.
- **Round 2 debate (4 REVISE, 1 APPROVE) → this v3:**
  1. **Mixed-patch guard fixed** — filter on `patch[k] !== undefined`, because the MCP `update_issue` adapter (`src/mcp/server.ts:285`) builds the patch with *all* keys present (undefined values); the v2 `Object.keys(patch)` check rejected every supervised MCP `done`. Added an MCP-level gated-`done` test (Task 7) — the one test that observes the feature on its real transport.
  2. **Affirm is cookie-only** — resolve the affirmer via the `switchyard_session` cookie (`getSessionActor`, which now rejects `sup_`), NOT `c.var.actor`, because REST middleware resolves a Bearer first and human actors have `syd_` bearers (Task 7).
  3. **`updateIssue` widened `Db`→`DbOrTx`** as an explicit step — the affirm executor passes a `Tx`; v2 left this as "confirm it does," and it does not (fails `tsc` at the verify gate) (Task 6).
  4. **Pending dedup refreshes payload + is concurrency-safe** — partial unique index on `(session_id, issue_id, action_type) WHERE status='pending'` (Task 1) and `ON CONFLICT` refresh of the payload (Task 5), so a corrected `expectedHeadSha` on retry isn't dropped and concurrent diverts can't duplicate.
  5. **Gate only executable statuses** — the divert pends only statuses with an executor (Phase 1: `done`); a configured non-executable status hard-fails with an honest message instead of creating an unaffirmable row (Task 5/6).
  6. **`deleteSession` kind-scoped** to `plain` (Task 2) — a `sup_` logout cookie would otherwise FK-500 or hard-delete a soft-close-only session.
  7. **`refOfIssueId` dropped** for the existing `issueRefById` (`src/services/issues.ts:111`) (Task 6).
  8. **Web approval-queue UI added** (Task 8) — v2 shipped only REST endpoints; the "web-board button" the model relies on now exists.
  9. Threat-model section added (above); plan-text fixes (the REST test harness is `buildApiRoutes(db)`+`app.request`; REST error convention; "≤4 args"); added tests (supervised-`claimIssue` attribution, opt-out `[]`, rollback-leaves-pending).
- **Execution correction (during Task 7):** an earlier revision claimed "there is no `createApp`". That over-generalized the round-3 finding, which was only ever about the **REST test harness convention**. `createApp` **does** exist at `src/server.ts:52`. Corrected at the Task-7 test note above.
- **Round 3 debate → APPROVED** (4 APPROVED: gemini, pentester, fable, opus; 1 REVISE: codex, wanting only one more test). All round-2 findings verified resolved against source by three reviewers independently. The panel's residual nits are folded in here **after** the approving review — each is a one-liner or one test that the `tsc`/verify gate would catch anyway, none change reviewed behaviour:
  - **codex:** the double-affirm exactly-once regression test (Task 6) — `done` authorizes delivery, so double-execution would double-authorize; and the REST test's "agent bearer" is clarified to mean *without* the owner cookie.
  - **fable:** `EXECUTABLE_GATE_ACTIONS` typed `readonly string[]` (an `as const` makes `.includes(status)` a TS2345); the import-cycle fallback replaced with a **real** one (third module) — the v3 text prescribed a no-op refactor; TOCTOU comment on the divert.
  - **opus:** `pendingActions.createdAt` needs `.default(now())` (its own Task-1 raw-insert test fails otherwise); `isHardGated`/`findOrCreatePendingAction`/`getPendingAction` typed `DbOrTx`; `buildMcpServer` call-site count corrected to 4.
  - **pentester:** the invariant widened to *any* human's credential (`requireHuman` accepts any human); the "don't add a settings-write MCP tool" corollary made explicit; the `GET` queue leak logged at its true width (readable by any **agent** token).

## Global Constraints

- **Node 24** — Node 25's WebStorage breaks jsdom tests (SYD-97). Do not bump.
- **All business logic in `src/services/*`** — MCP/REST/UI are thin adapters; no client has private powers.
- **Services throw `SwitchyardError`** for user-facing failures. It carries **only a message** (`src/services/errors.ts:1` — `class SwitchyardError extends Error {}`); no structured payload, so any id a client must read goes **in the message string**. REST maps it via the app's `onError` (grep `src/rest/api-routes.ts` for the convention — it is a 400, not per-route 403).
- **Mutate issues only through services** — `events` is a co-written append-only audit log.
- **Migrations are additive and generated** — after editing `src/db/schema.ts`, run `npm run db:generate`. Never hand-edit generated SQL. A partial unique index may need a hand-checked `CREATE UNIQUE INDEX … WHERE …` if drizzle-kit doesn't emit the predicate — verify the generated SQL contains the `WHERE status='pending'` clause.
- **FKs enforced at runtime** — `src/db/index.ts:45` runs `PRAGMA foreign_keys = ON`. A row referenced by an FK **cannot be `DELETE`d**; use soft-close.
- **Real test idiom** (no invented harness): `const db = openDb(":memory:")` then `createActor(db, {name,type})`, `createProject(db, human, {key,name})`, `createIssue(db, human, {projectKey,title})` — pattern at `tests/services/issues-update.test.ts:19-30`. Raw reads: drizzle `db.get(sql\`… ${x}\`)` / `db.all(sql\`…\`)` — **never** `db.all("SELECT …", [params])`.
- **Commit with explicit path lists** — never `git add -A`.
- **Zod v3**; import specifiers end in `.js`.
- **Run `npm run verify` before done-stamping** (TZ=UTC typecheck/build:ui/test).

## File Structure

- `src/db/schema.ts` — `sessions`: add `kind`, `viaAgentId`, `closedAt`; `events`: add `viaAgentId`, `sessionId`; new `pendingActions` table + partial unique index (modify).
- `drizzle/00NN_*.sql` — generated migration (create).
- `src/services/principal.ts` — `Principal` type (create).
- `src/services/supervised-sessions.ts` — `openSupervisedSession`, `resolveSupervisedPrincipal`, `closeSupervisedSession` (create).
- `src/services/auth.ts` — `getSessionActor` AND `deleteSession` filter `kind='plain'` (modify — CRITICAL).
- `src/services/events.ts` — `recordEvent` gains optional `viaAgentId`/`sessionId` (modify).
- `src/services/attribution.ts` — `Attribution` type + `attributionOf(principal)` (create).
- `src/services/issues.ts` — thread `Attribution`; widen `updateIssue` first arg `Db`→`DbOrTx`; hard-gate divert on executable statuses (modify).
- `src/services/comments.ts`, `needs-input.ts`, `dependencies.ts`, `attachments.ts`, `agent-sessions.ts` — thread `Attribution`; `recordProgressNote` acts on `viaAgent` (modify).
- `src/services/hard-gate.ts` — policy + pending-action create/dedup-refresh/list/affirm-execute (create).
- `src/services/settings.ts` — register `supervised.hard_gate_actions` (default `["done"]`); reject non-executable values (modify).
- `src/mcp/server.ts` — `buildMcpServer` gains optional `attribution` + `viaAgent`; write tools forward attribution; agent-scoped tools use `viaAgent` (modify).
- `src/server.ts` — `/mcp` resolves supervised token → `Principal` (modify).
- `src/rest/pending-actions.ts` — `POST /api/pending-actions/:id/affirm` (cookie-only), `GET /api/pending-actions` (create; wire into `buildApiRoutes`).
- `ui/…` — a minimal approval-queue panel with an Approve button (Task 8).
- `src/cli.ts` — `mint-supervised-session <human> <agent>` (modify).

---

## Task 1: Schema + migration

**Files:** Modify `src/db/schema.ts`; create `drizzle/00NN_*.sql`; test `tests/db/supervised-schema.test.ts`.

**Interfaces (produces):** `sessions.kind` (`"plain"|"supervised"`, default `"plain"`), `sessions.viaAgentId` (nullable FK), `sessions.closedAt` (nullable int). `events.viaAgentId`, `events.sessionId` (nullable FKs). `pendingActions` table + partial unique index `pending_actions_active_uniq` on `(session_id, issue_id, action_type) WHERE status='pending'`.

- [ ] **Step 1: Failing test**

```typescript
// tests/db/supervised-schema.test.ts
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { openDb } from "../../src/db/index.js";

describe("supervised-session schema", () => {
  it("sessions has kind, via_agent_id, closed_at", () => {
    const db = openDb(":memory:");
    db.run(sql`INSERT INTO actors (name,type) VALUES ('h','human'),('a','agent')`);
    db.run(sql`INSERT INTO sessions (token_hash,actor_id,via_agent_id,kind,expires_at) VALUES ('th',1,2,'supervised',9999999999)`);
    const row = db.get<{ kind: string; via_agent_id: number; closed_at: number | null }>(
      sql`SELECT kind, via_agent_id, closed_at FROM sessions`);
    expect(row!.kind).toBe("supervised");
    expect(row!.via_agent_id).toBe(2);
    expect(row!.closed_at).toBeNull();
  });

  it("pending_actions enforces one active row per (session,issue,action)", () => {
    const db = openDb(":memory:");
    db.run(sql`INSERT INTO actors (name,type) VALUES ('h','human'),('a','agent')`);
    db.run(sql`INSERT INTO sessions (token_hash,actor_id,via_agent_id,kind,expires_at) VALUES ('th',1,2,'supervised',9999999999)`);
    db.run(sql`INSERT INTO projects (key,name) VALUES ('SYD','Switchyard')`);
    db.run(sql`INSERT INTO issues (project_id,number,title,status,creator_id) VALUES (1,1,'t','backlog',1)`);
    db.run(sql`INSERT INTO pending_actions (session_id,issue_id,action_type,payload,status) VALUES (1,1,'done','{}','pending')`);
    // a second *pending* row for the same tuple must violate the partial unique index
    expect(() => db.run(sql`INSERT INTO pending_actions (session_id,issue_id,action_type,payload,status) VALUES (1,1,'done','{}','pending')`)).toThrow();
    // but an affirmed row for the same tuple is allowed (predicate is status='pending')
    db.run(sql`UPDATE pending_actions SET status='affirmed' WHERE id=1`);
    expect(() => db.run(sql`INSERT INTO pending_actions (session_id,issue_id,action_type,payload,status) VALUES (1,1,'done','{}','pending')`)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run → FAIL** (`no such column`, no index).
- [ ] **Step 3: Schema.** `sessions`: add `kind: text("kind",{enum:["plain","supervised"]}).notNull().default("plain")`, `viaAgentId: integer("via_agent_id").references(()=>actors.id)`, `closedAt: integer("closed_at")`. `events`: add `viaAgentId` + `sessionId` nullable FKs before `createdAt`. New `pendingActions` table (`id`, `sessionId`→sessions notNull, `issueId`→issues notNull, `actionType` text, `payload` json default `{}`, `status` enum `["pending","affirmed","expired"]` default `"pending"`, `affirmedById`→actors nullable, `affirmedAt` int nullable, `createdAt: integer("created_at").notNull().default(now())` — **the `.default(now())` is required**, not optional polish: Step 1's raw insert omits `created_at`, so a bare `.notNull()` fails the test on a NOT NULL with no default (`now = () => sql\`(unixepoch())\``, `schema.ts:25`; the idiom is universal in this file)). Declare the partial unique index in schema (`uniqueIndex("pending_actions_active_uniq").on(t.sessionId,t.issueId,t.actionType).where(sql\`status = 'pending'\`)`).
- [ ] **Step 4:** `npm run db:generate`; **verify the emitted SQL contains `WHERE status = 'pending'`** (drizzle-kit sometimes drops index predicates — if so, hand-add the `WHERE` to the generated file, which is the one time editing generated SQL is sanctioned, and note it in the commit).
- [ ] **Step 5: Run → PASS** (2 tests).
- [ ] **Step 6: Commit** (`git add src/db/schema.ts drizzle/ tests/db/supervised-schema.test.ts`).

---

## Task 2: Supervised-session service + credential-boundary fixes

**Files:** create `src/services/principal.ts`, `src/services/supervised-sessions.ts`; modify `src/services/auth.ts` (both `getSessionActor` AND `deleteSession` → `kind='plain'`), `src/cli.ts`; tests `tests/services/supervised-sessions.test.ts`, `tests/services/auth-kind-isolation.test.ts`.

**Interfaces:** `type Principal = { actor: Actor; viaAgent?: Actor; sessionId?: number }`; `openSupervisedSession(db, human, agentName)` (human root; rejects a non-agent editor); `resolveSupervisedPrincipal(db, token)` (kind='supervised', not closed, not expired, re-validates human+agent types); `closeSupervisedSession(db, token)` (soft-close). `getSessionActor` AND `deleteSession` resolve/act only on `kind='plain'`.

- [ ] **Step 1: Failing tests** — `supervised-sessions.test.ts`: binds human+agent into a resolvable principal (`actor` is the human, `viaAgent` the agent); refuses non-human root (`/only a human can open/i`); refuses a name that pre-exists as human (`/must be an agent/i`); a closed session doesn't resolve. `auth-kind-isolation.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { openSupervisedSession, closeSupervisedSession } from "../../src/services/supervised-sessions.js";
import { getSessionActor, deleteSession } from "../../src/services/auth.js";

describe("supervised token is not a web/REST credential", () => {
  it("getSessionActor refuses a sup_ token", () => {
    const db = openDb(":memory:");
    const h = createActor(db, { name: "sean", type: "human" }).actor;
    const { sessionToken } = openSupervisedSession(db, h, "claude-code");
    expect(getSessionActor(db, sessionToken)).toBeNull();
  });
  it("deleteSession is inert on a sup_ token (no FK error, session survives via soft-close only)", () => {
    const db = openDb(":memory:");
    const h = createActor(db, { name: "sean", type: "human" }).actor;
    const { sessionToken } = openSupervisedSession(db, h, "claude-code");
    deleteSession(db, sessionToken); // must not throw and must not delete the supervised row
    const n = db.get<{ c: number }>(sql`SELECT COUNT(*) c FROM sessions WHERE kind='supervised'`);
    expect(n!.c).toBe(1);
    closeSupervisedSession(db, sessionToken); // the correct revocation path still works
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3:** `principal.ts` (the type above).
- [ ] **Step 4:** `supervised-sessions.ts` — `openSupervisedSession` mints `mintToken("sup",32)`, `getOrCreateActor(db,agentName,"agent")` then `if (agent.type!=="agent") throw`; inserts `kind:"supervised"`, `viaAgentId`. `resolveSupervisedPrincipal` selects `and(eq(tokenHash…), eq(kind,"supervised"), isNull(closedAt))`, rejects if expired/`viaAgentId` null, re-fetches both actors and returns null unless `human.type==="human" && agent.type==="agent"`. `closeSupervisedSession` sets `closedAt=now` (never `DELETE`). `SUPERVISED_TTL = 12*3600`.
- [ ] **Step 5: Harden `auth.ts` (CRITICAL).** Add `and(..., eq(sessions.kind,"plain"))` to `getSessionActor`'s where-clause **and** to `deleteSession`'s where-clause (import `and`). Login sessions default `kind='plain'`, so web login is unaffected; supervised tokens become inert on both cookie consumers.
- [ ] **Step 6:** `src/cli.ts` — add `mint-supervised-session <humanName> <agentName>` (mirror `mint-login`): resolve the human actor (assert `type==='human'`), call `openSupervisedSession`, print the `sup_` token with the warning: *"Set this as your MCP client's bearer. It authorizes supervised writes for 12h. It is NOT a web login. Do NOT run this session with your web cookie or personal syd_ bearer in its environment (see the plan's threat-model)."*
- [ ] **Step 7: Run → PASS.**
- [ ] **Step 8: Regression** — `npx vitest run tests/services/ tests/rest/` (web login still resolves).
- [ ] **Step 9: Commit.**

---

## Task 3: Dual attribution at `recordEvent` + `Attribution`

**Files:** modify `src/services/events.ts`; create `src/services/attribution.ts`; test `tests/services/events-attribution.test.ts`.

**Naming:** the type is `Attribution` (not `Provenance` — `issues.ts:24` already exports `Provenance`).

- [ ] **Step 1: Failing test** — `recordEvent(db,{issueId,actorId,type,viaAgentId,sessionId})` persists both ids; a plain call leaves both null (use `openDb(":memory:")` + `sql` raw reads).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3:** extend `recordEvent`'s input with optional `viaAgentId?`, `sessionId?`; write `viaAgentId: e.viaAgentId ?? null`, `sessionId: e.sessionId ?? null`.
- [ ] **Step 4:** `attribution.ts` — `export type Attribution = { viaAgentId?: number; sessionId?: number }`; `export function attributionOf(p: Principal): Attribution { return { viaAgentId: p.viaAgent?.id, sessionId: p.sessionId }; }`.
- [ ] **Step 5: Run → PASS. Step 6: Commit.**

---

## Task 4: Thread attribution through every event-writing mutation

**Files:** modify `issues.ts` (`createIssue`/`updateIssue`/`claimIssue` incl. its `updateIssue` delegation at :661), `comments.ts`, `needs-input.ts`, `dependencies.ts`, `attachments.ts`, `agent-sessions.ts`; test `tests/services/supervised-attribution-e2e.test.ts`.

**Design note 1:** the `actor` passed to human-gated fns stays the **human** (guards pass). `recordProgressNote` requires `actor.type==="agent"` (`agent-sessions.ts:45-49`), so the MCP layer (Task 7) passes `viaAgent` as its actor; `recordProgressNote` still gains `attr` so its event carries `sessionId`.
**Design note 2:** `claimIssue`'s fresh-claim delegates to `updateIssue` (:661) and records at :644 — forward `attr` through both, or supervised-claim events are unattributed.

- [ ] **Step 1: Failing tests** — (a) supervised `createIssue`+`updateIssue`→`in_review` writes `status_changed` with `via_agent_id`/`session_id` set; **(b) supervised `claimIssue` writes an `assigned` (or `status_changed`) event carrying `via_agent_id = viaAgent.id`** (the delegation path fable/codex flagged; assert it explicitly).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3:** add trailing `attr: Attribution = {}` (import from `./attribution.js`); `updateIssue` gets it as the **6th** param (after `lease`, the 5th). Spread `viaAgentId: attr.viaAgentId, sessionId: attr.sessionId` into every `recordEvent` call (the `updateIssue` funnel loop at `issues.ts:581-582`; `createIssue` :189; `claimIssue` :644). Forward `attr` into `claimIssue`'s delegated `updateIssue(...)` at :661. Leave guards untouched.
- [ ] **Step 4: Run → PASS. Step 5:** full `tests/services/` (optional param defaults `{}`). **Step 6: Commit.**

---

## Task 5: Hard-gate policy + pending-action service (done-scoped, tx-safe, dedup-refresh)

**Files:** modify `settings.ts` (register + validate); create `hard-gate.ts`; test `tests/services/hard-gate.test.ts`.

**Interfaces (Task 5):** `isHardGated(db: DbOrTx, actionType: string)`; `EXECUTABLE_GATE_ACTIONS: readonly string[] = ["done"]`; `findOrCreatePendingAction(db: DbOrTx, sessionId, issueId, actionType, payload)` — **conflict-aware & payload-refreshing**; `getPendingAction(db: DbOrTx, id)`; `listPendingActions(db, status)`; `affirmPendingAction(db: Db, human, id)`.

**Typing notes (both are `tsc` errors if ignored — they surface at the Task 9 gate, so pin them here):**
- `isHardGated`/`findOrCreatePendingAction`/`getPendingAction` must take **`DbOrTx`**, not `Db` — the Task-6 divert calls them with `updateIssue`'s now-widened `DbOrTx` handle, and the affirm executor calls `getPendingAction` inside a `Tx`.
- Type `EXECUTABLE_GATE_ACTIONS` as **`readonly string[]`**, not `["done"] as const`. With `as const` the type is `readonly ["done"]`, whose `.includes()` only accepts `"done"` — passing the full `Status` union (Task 6) is TS2345. If you keep `as const`, the call site needs `(EXECUTABLE_GATE_ACTIONS as readonly string[]).includes(patch.status)`.

**Design notes:** (1) owner tie — affirming `human.id` must equal the session's `actorId`. (2) tx-safe execute-then-mark: conditional claim `UPDATE … WHERE id=? AND status='pending'` (0 rows ⇒ throw), execute, rollback on throw leaves it `pending`. (3) executor guard — only `done`. (4) stale SHA — executor re-drives `updateIssue` as the human, no `attr`; a throw rolls back and leaves it re-affirmable *with the refreshed payload* (see dedup).

- [ ] **Step 1: Failing tests** — defaults to gating `done`; **opt-out `[]` disables gating** (`setSetting(db, admin, "supervised.hard_gate_actions", [])` → `isHardGated(db,"done")===false`); dedup returns the same id AND a second call with a new payload **refreshes** the stored payload; a different human can't affirm (`/only the accountable human/i`); an agent can't affirm; setting a non-executable value is rejected (`setSetting(..., ["in_review"])` throws `/not an affirmable/i`).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: settings.ts** — register `"supervised.hard_gate_actions": { type:"string[]", default:["done"], description:"Status transitions requiring fresh human affirmation in a supervised session. Only affirmable statuses are allowed (Phase 1: done). Empty = full absorption." }`. Add a validator: on `setSetting` of this key, reject any value not in `EXECUTABLE_GATE_ACTIONS` (import the const; or inline `["done"]`). (Match how `settings.ts` runs per-key validation — `validateValue` at :78; extend it, or validate in a wrapper.)
- [ ] **Step 4: hard-gate.ts** — `findOrCreatePendingAction` uses an atomic upsert on the partial unique index:
  ```typescript
  // INSERT … ON CONFLICT (partial uniq) DO UPDATE SET payload=excluded.payload RETURNING id
  const row = db.insert(pendingActions)
    .values({ sessionId, issueId, actionType, payload, status: "pending" })
    .onConflictDoUpdate({
      target: [pendingActions.sessionId, pendingActions.issueId, pendingActions.actionType],
      targetWhere: sql`status = 'pending'`,
      set: { payload },
    })
    .returning({ id: pendingActions.id }).get();
  return row.id;
  ```
  (Confirm drizzle better-sqlite3 supports `targetWhere` for a partial-index conflict target; if not, do a `SELECT … FOR`-style read-then-`UPDATE payload`/`INSERT` inside a single `db.transaction` — the index still prevents a duplicate INSERT.) `affirmPendingAction` — human-type check, owner tie via `sessions.actorId`, executor guard (`actionType !== "done"` → throw), then `db.transaction`: conditional claim, `issueRefById(tx, row.issueId)` (Task 6), `updateIssue(tx, human, ref, { status:"done", …expectedHeadSha }, {}, {})`.
- [ ] **Step 5: Run → PASS. Step 6: Commit.**

---

## Task 6: Divert executable gated status → pending; widen `updateIssue`

**Files:** modify `src/services/issues.ts`; tests `tests/services/hard-gate-divert.test.ts`, `tests/services/hard-gate-affirm-exec.test.ts`.

- [ ] **Step 1: Failing tests** —
  - divert: supervised `updateIssue({status:"done"})` **does not commit**, creates exactly one pending row, and a **retry dedups** (COUNT stays 1). Assert the throw text `/awaiting human affirmation/i`. Plain-human done-stamp is NOT diverted.
  - **rollback-leaves-pending:** create the pending action for a `done` over an open agent PR with a stale `expectedHeadSha` so the executor's `updateIssue` throws; assert the pending row is still `status='pending'` (re-affirmable), and the issue did not transition.
  - affirm-exec: the session's human affirms → issue is `done`.
  - **double-affirm (idempotence / exactly-once):** affirm the same pending action a **second** time → it throws (`/already affirmed|already taken/i`), and assert **exactly one** `status_changed` event to `done` exists for that issue and the issue transitioned once. This is the regression guard for the conditional claim (`UPDATE … WHERE id=? AND status='pending'`) — it matters because a `done` stamp *authorizes delivery* and carries the SYD-208 head-SHA pin in its `status_changed` payload (`src/services/issues.ts:331,371`), so a double-execution would double-authorize. Assert the event count, not just the throw:
    ```typescript
    affirmPendingAction(db, h, pid);
    expect(() => affirmPendingAction(db, h, pid)).toThrow(/already/i);
    const n = db.get<{ c: number }>(sql`SELECT COUNT(*) c FROM events WHERE issue_id = ${issueId} AND type='status_changed' AND json_extract(payload,'$.to') = 'done'`);
    expect(n!.c).toBe(1);
    ```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3:** widen `updateIssue`'s first param `db: Db` → `db: DbOrTx` (import `DbOrTx` from `../db/index.js`); the compiler will surface `getSetting(db, …)` at `issues.ts:574` — widen `getSetting`'s first param to `DbOrTx` too (a plain select; safe). Add the divert **before** the mutation transaction:
  ```typescript
  if (attr.sessionId != null && patch.status !== undefined) {
    const target = getIssue(db, ref); // real resolver; has .id/.status
    if (patch.status !== target.status && isHardGated(db, patch.status)) {
      if (!EXECUTABLE_GATE_ACTIONS.includes(patch.status)) {
        throw new SwitchyardError(`"${patch.status}" is hard-gated but not an affirmable action in this version — remove it from supervised.hard_gate_actions.`);
      }
      const otherKeys = Object.keys(patch).filter(
        (k) => k !== "status" && k !== "expectedHeadSha" && (patch as Record<string, unknown>)[k] !== undefined,
      );
      if (otherKeys.length > 0) {
        throw new SwitchyardError(`A hard-gated status change to "${patch.status}" must be its own call — move ${otherKeys.join(", ")} to a separate update.`);
      }
      // TOCTOU note: this read + pend runs outside a transaction, so the issue can
      // change between here and the human's later affirm. Harmless by construction —
      // the executor re-drives updateIssue at affirm time, which re-validates every
      // guard (incl. the SYD-208 head pin) against current state: it either no-ops
      // (already done) or throws and rolls back, leaving the row pending.
      const pendingActionId = findOrCreatePendingAction(db, attr.sessionId, target.id, patch.status, {
        status: patch.status, ...(patch.expectedHeadSha !== undefined ? { expectedHeadSha: patch.expectedHeadSha } : {}),
      });
      throw new SwitchyardError(`Awaiting human affirmation: ${ref} → ${patch.status} is hard-gated (pending action #${pendingActionId}). A human must approve it in the board. Nothing was changed.`);
    }
  }
  ```
  (`EXECUTABLE_GATE_ACTIONS` imported from `./hard-gate.js`; the setting validator in Task 5 already blocks non-executable values, so this branch is defense-in-depth. Import `isHardGated`/`findOrCreatePendingAction` from `./hard-gate.js`.

  **On the `issues.ts` ⇄ `hard-gate.ts` cycle:** it is real (issues imports the gate helpers; hard-gate imports `updateIssue`/`issueRefById` back) but **benign** — neither module touches the other's exports during module evaluation, only at call time, and the hot exports are hoisted function declarations that ESM live-bindings resolve before any request runs. `EXECUTABLE_GATE_ACTIONS` is only read inside `updateIssue`, so there's no TDZ exposure. Expect it to work. **If it does bite, the real fix is to move `affirmPendingAction` into a third module** (e.g. `src/services/hard-gate-affirm.ts`) that imports both `issues.ts` and `hard-gate.ts`, leaving `hard-gate.ts` as policy + pending-CRUD with **no** import of `issues.ts`. (Do *not* just hoist the divert body into `hard-gate.ts` — that keeps the identical two-way import and fixes nothing.)) Use the existing **`issueRefById`** (`src/services/issues.ts:111`, `(db: DbOrTx, id) => string|null`) in the affirm executor with a null-check — do NOT add a new `refOfIssueId`.
- [ ] **Step 4: Run → PASS. Step 5: Commit.**

---

## Task 7: MCP + REST surface (no in-band handshake; cookie-only affirm)

**Files:** modify `src/mcp/server.ts`, `src/server.ts`; create `src/rest/pending-actions.ts`; tests `tests/mcp/supervised-write.test.ts`, `tests/rest/pending-actions.test.ts`.

- [ ] **Step 1: Failing tests** —
  - `supervised-write.test.ts` (harness copied from `tests/mcp/write-tools.test.ts` — it builds via `buildMcpServer(db, actor, …)`): build with `buildMcpServer(db, prin.actor, dir, undefined, attributionOf(prin), prin.viaAgent)`. Assert (a) `update_issue`→`in_review` writes `status_changed` with `via_agent_id`/`session_id`; **(b) `update_issue`→`done` (gated) returns the `/awaiting human affirmation/i` error and creates exactly one `pending_actions` row** — the MCP-transport observation of the divert (this is the test v2 lacked); (c) `progress_note` succeeds (acts as `viaAgent`) and its event carries `session_id`.
  - `pending-actions.test.ts` (harness: `const app = buildApiRoutes(db); app.request(…)` — the convention every `tests/rest/*.test.ts` uses. NB: `createApp` **does** exist at `src/server.ts:52` (it mounts `/mcp` + the auth/webhook routes); it is simply not what the REST tests build. Do **not** reach for it here — and note that driving `/mcp` in-process via `createApp(db).request(…)` does not work: `toReqRes`/`toFetchResponse` returns 400 with an empty body, so an end-to-end `/mcp` test needs a real `serve({ port: 0 })` + the SDK's `StreamableHTTPClientTransport`, as `tests/mcp/supervised-mcp-endpoint.test.ts` does): the **owner human's session cookie** affirms and the deferred `done` commits; the same call is 4xx with (a) an **agent bearer and NO session cookie**, (b) a **`sup_` token presented as the cookie**, or (c) a **different human's** cookie (owner-tie → `/only the accountable human/i`). Note (a) is deliberately "bearer *without* the owner cookie" — the handler is cookie-only by design, so an agent bearer *plus* a valid owner cookie would legitimately succeed (that's a human present at the browser, which is exactly what the gate wants). `GET /api/pending-actions?status=pending` lists it.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: `buildMcpServer`** — append optional params: `attribution: Attribution = {}, viaAgent?: Actor` (positions 5–6; all **4** existing call sites pass ≤4 args with positions 1–4 unchanged, so none break: `src/server.ts:82` (4), `tests/mcp/lease-tools.test.ts:13` (4, `connectionLeaseToken`), `write-tools.test.ts:21` (3), `read-tools.test.ts:16` (2)). Write tools pass `attribution`; `progress_note` passes `recordProgressNote(db, viaAgent ?? actor, …, attribution)`. Do **not** register `open_supervised_session`.
- [ ] **Step 4: `/mcp`** — resolve `resolveSupervisedPrincipal(db, token)` first; if it resolves use `principal.actor` + `attributionOf` + `viaAgent`; else `authenticate` (plain, `attribution={}`, no viaAgent); 401 if neither. `buildMcpServer(db, actor, undefined, leaseToken, attribution, viaAgent)`.
- [ ] **Step 5: REST (cookie-only affirm).** In `src/rest/pending-actions.ts`:
  ```typescript
  router.post("/pending-actions/:id/affirm", (c) => {
    // Affirmation MUST come from a real web session cookie, NOT c.var.actor —
    // middleware resolves a Bearer first, and a human actor has a syd_ bearer an
    // agent process could hold. getSessionActor now rejects sup_ (Task 2).
    const cookie = getCookie(c, SESSION_COOKIE);              // import SESSION_COOKIE from auth-routes
    const human = cookie ? getSessionActor(db, cookie) : null;
    if (!human || human.type !== "human") return c.json({ error: "a human web session is required to affirm" }, 403);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "invalid id" }, 400); // mirror parseActorId
    return c.json(affirmPendingAction(db, human, id)); // SwitchyardError → app onError (400)
  });
  router.get("/pending-actions", (c) => c.json(listPendingActions(db, c.req.query("status") ?? "pending")));
  ```
  (Confirm `SESSION_COOKIE`/`getCookie` import points against `src/rest/auth-routes.ts`.)

  **Accepted Phase-1 simplification, stated at its true width:** `GET /api/pending-actions` has no human/owner scoping, so it is readable by **any authed actor — including a plain agent bearer** (not merely "any authed actor," which reads as human-only; agents are authed actors). It leaks issue-ref/action-type/session/timestamp **metadata across all sessions** — no capability, no token. Accepted for Phase 1; the human-only scope is a one-line follow-up, logged in Deferred as *info-disclosure-to-any-agent-token* so it isn't forgotten.
  **CSRF:** none needed beyond what exists — the session cookie is `httpOnly` + `SameSite=Lax` (`src/rest/auth-routes.ts:17-23`), so a cross-origin auto-POST to the affirm route won't carry it. This matches the existing `POST /auth/logout` posture; an `Origin`/`Sec-Fetch-Site` check would be an app-wide def-in-depth improvement, not a Phase-1 blocker.
- [ ] **Step 6: Run → PASS. Step 7: Commit.**

---

## Task 8: Web approval-queue panel (the human-presence surface)

**Files:** add a small React view under `ui/` (follow the existing board's data-fetch + component conventions — grep `ui/` for how a list view calls `/api/*` and renders); test per the UI's existing test setup if one covers views, else manual.

**Rationale:** the hard-gate's whole point is a human *click* on a surface Claude can't drive. REST endpoints alone (Task 7) are not that surface. Phase 1 ships a **minimal** panel: a list of `GET /api/pending-actions?status=pending` (ref, action, who/session, when) each with an **Approve** button that `POST`s `/api/pending-actions/:id/affirm` (carrying the human's session cookie automatically) and refreshes the list. No Touch-ID, no native notification (Phase 2) — just the click, authenticated as the logged-in human.

- [ ] **Step 1:** add the view + route entry (match the board's routing). Fetch on mount; render rows; Approve button → POST → optimistic remove/refresh; surface a 4xx error inline (e.g. "head moved — re-review").
- [ ] **Step 2:** `npm run build:ui` succeeds; drive it once (`npm run dev:ui`) to confirm the list renders and Approve commits a seeded pending action (attach a screenshot per the repo's visual-verification norm).
- [ ] **Step 3: Commit** (`git add ui/… ` explicit paths).

---

## Task 9: Full verify

- [ ] **Step 1:** `npm run verify` — node-version + TZ=UTC typecheck + build:ui + full suite. Confirm: the 3 pre-existing `tests/mcp/*` pass (additive params); web login (`tests/rest/*`) still resolves after the `getSessionActor`/`deleteSession` `kind` filters; `tsc` is clean (the `updateIssue`/`getSetting` `DbOrTx` widening).
- [ ] **Step 2:** commit any type/lint fixups with explicit paths (no `git add -A`).

---

## Deferred to later phases

- **Phase 2:** native notification / menu-bar Approve + Touch-ID-gated keychain release.
- **`dependency.remove`** (and any non-status gated action): own divert in `removeDependency` + executor branch.
- **Per-project** hard-gate lists (Phase 1 install-global).
- **Provenance chips** in the UI ("✍️ claude-code · under Sean").
- **Lifecycle:** wire `closeSupervisedSession` to a CLI/REST revocation, renewal, expiry sweep.
- **Info-disclosure-to-any-agent-token:** scope `GET /api/pending-actions` to humans (and ideally to the requesting human's own sessions). Today any authed actor — **including a plain agent bearer** — can enumerate the queue's metadata across all sessions. Metadata only, no capability; one-line fix.
- **Pending-row hygiene:** no expiry sweep exists, so a `pending` row abandoned by a human who instead done-stamps via the board lingers in the queue. Pair with the lifecycle sweep above.

## Self-Review

- **Spec coverage:** Pillar 1 → Task 2 (CLI mint + resolve) + Task 7 (/mcp). Pillar 2 → Tasks 1, 3, 4. Pillar 3 → human-`actor` absorption + hard-gate Tasks 5–6, default `["done"]`. Pillar 4 → pre-existing `scripts/worker-select.ts:415` + claim interlock. Pillar 5 → Tasks 5–8 (web surface now real). Pillar 6 + containment → threat-model section (docs) + Task 2/7 credential fixes.
- **Round-2 findings → resolution:** mixed-patch → `!== undefined` filter + MCP gated-done test (Task 6/7). Bearer-affirm → cookie-only (Task 7). `Db`→`DbOrTx` → explicit widening step (Task 6). Dedup payload/concurrency → partial unique index (Task 1) + `onConflictDoUpdate` refresh (Task 5). Non-executable gate → setting validator + divert guard (Task 5/6). `deleteSession` → kind filter (Task 2). `refOfIssueId` → `issueRefById` (Task 6). No UI → Task 8. Threat-model → dedicated section. Plan-text → `buildApiRoutes`+`app.request`, onError-400, "≤4 args". Tests → supervised-claim attribution (Task 4), opt-out `[]` (Task 5), rollback-leaves-pending (Task 6).
- **Round-3 nits folded (post-approval, below re-review threshold):** double-affirm exactly-once test (Task 6); `EXECUTABLE_GATE_ACTIONS: readonly string[]` + `DbOrTx` on the hard-gate params (Task 5); `pendingActions.createdAt.default(now())` (Task 1); real import-cycle fallback + TOCTOU comment (Task 6); "agent bearer without owner cookie" test clarification + 4-call-site count + `GET`-leak/CSRF wording (Task 7); invariant widened to *any* human + settings-write-MCP-tool corollary (threat model).
- **Residual known-simplifications (stated, not hidden):** `SwitchyardError` carries the pending id in the message string; `GET /api/pending-actions` is readable by any authed actor **including an agent bearer** (metadata only — logged in Deferred); nested `updateIssue`-inside-`affirm` relies on better-sqlite3 savepoints — proven by the Task-5/6 affirm + rollback tests; the drizzle `onConflictDoUpdate` partial-target and the drizzle-kit partial-index-predicate emission are both flagged "verify by running" (fable confirmed both are supported in the shipped `drizzle-orm`/`drizzle-kit` versions, but the runtime check stays); calling `.transaction()` on a `DbOrTx` union is a first in this codebase — the `tsc` gate is the backstop.
