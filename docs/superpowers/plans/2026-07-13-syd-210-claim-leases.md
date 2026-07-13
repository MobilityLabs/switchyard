# SYD-210 Session-Scoped Claim Leases — Implementation Plan (Layer A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a claim a session-scoped lease — a server-minted, hashed, single-use credential a specific session must present on every claim-scoped mutation — closing the residual SYD-93/122 shared-token double-work hole.

**Architecture:** A new `claim_leases` table holds one active hashed-token row per claimed issue (the credential layer *on top of* the existing `issues.assigneeId`/`status` claim state, not a replacement). A new `src/services/leases.ts` mints/validates/invalidates/expires leases. The claim-scoped service functions (`updateIssue`, `claimIssue`, `requestHumanInput`, the human-answer release in `comments.ts`) thread a lease token; the two adapters supply it differently — MCP as an explicit `lease_token` tool-input field, REST as an `X-Switchyard-Lease` header. Enforcement is a hard cutover: a one-time startup backfill releases every pre-existing lease-less `in_progress` claim.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Drizzle ORM over better-sqlite3, Hono (REST), `@modelcontextprotocol/sdk` (MCP), Vitest, Zod.

## Global Constraints

- **Node 24** (Node 25's WebStorage breaks jsdom tests). Do not upgrade.
- **All business logic lives in `src/services/*`.** MCP/REST are thin adapters over the same functions — no client gets private powers. Add to the service layer first, then expose per adapter.
- **Services throw `SwitchyardError`** for user-facing failures (MCP `guard()` → `isError` result; REST `onError` → 400). Anything else is a real 500.
- **Mutate issues only through services** — core state is mutable columns on `issues`; `events` is a co-written append-only audit log via `recordEvent`. Never write issue state directly except via the established re-assert-in-UPDATE release pattern (`stale-claims.ts`).
- **Token discipline (bearer-credential):** mint with `mintToken(prefix)`, store only `hashToken(token)` (sha256 hex). The plaintext lease token is returned exactly once (from `claim_issue`), never re-returned, never logged, never serialized into an issue view, an event payload, `agent_sessions`, or any GET-able state, never placed in argv.
- **ESM import specifiers** end in `.js` even for `.ts` files (e.g. `from "./leases.js"`).
- **Import ordering / style:** match the surrounding file. Drizzle query helpers (`and`, `eq`, `isNull`, `gt`, `lte`, `sql`) import from `drizzle-orm`.
- **After editing `src/db/schema.ts`**, regenerate the migration with `npm run db:generate`, then `git checkout -- package-lock.json` (npm-11 lockfile churn — the generate step can touch it).
- **Commit discipline (subagent-commits):** before every commit run `npm run typecheck` and the affected `npx vitest run <files>` **in-transcript** and paste the passing output. Never report unrun evidence. Reference the issue in the message: `... (SYD-210)`.
- **Scope:** this plan is **Layer A** (the security close). Layer B (heartbeat surface + host-side heartbeat loop + server-uptime expiry gate) is documented at the end as a fast-follow and is **not** built here — but the `claims.lease_ttl_seconds` setting and the TTL-based `expires_at` land in Layer A because minting needs them.

## Resolved design decisions (read before starting)

These are the precise interpretations of the design that every task assumes:

1. **Validation is agent-only.** Lease validation fires only when `actor.type === "agent"`. Human actors are individuated by token and are never lease-gated — a human claiming via the web UI receives a token in the response but the UI never resends it, so gating humans would break the UI. The shared-token double-work hole is exclusively an agent-token phenomenon. (Minting still happens for any actor that claims; a human's minted lease is simply never enforced.)

2. **Holder mutation = validate.** In `updateIssue`, an agent whose call targets an issue it already holds (`current.assigneeId === actor.id`) must present a valid lease. This is the "any mutation of an already-claimed issue by its holder" rule and covers `in_progress → in_review`, `in_progress → todo` (self-release), `in_review → in_progress` (reopen), field edits, and a redundant self-PATCH to `in_progress` (the double-work attempt).

3. **Fresh claim = mint (no prior lease).** When a call transitions an issue from *unassigned* (`current.assigneeId === null`) to *assigned-to-the-actor* + `in_progress` — the `claimIssue` self-assign path and `updateIssue`'s SYD-111 bare-PATCH auto-claim path — it **mints** a lease instead of validating one. These are disjoint from rule 2 (assignee null vs. === actor.id).

4. **`claimIssue` always yields an active lease for the actor** and returns its plaintext token: a fresh claim mints; a same-actor re-claim of an issue that already has an active lease **fails loudly** unless `takeover: true`, which invalidates the old lease + mints a fresh one + records `lease_taken_over`.

5. **Release invalidates.** `updateIssue status → todo` (self-release, lease-gated: the holder validates, then we invalidate) and the human-answer release in `comments.ts` (lease-**exempt**: the answering human never held the lease) both invalidate the active lease. `expireLeases` invalidates on sweep.

6. **`invalidateLease(tx, issueId)` takes no reason param** — the schema has no reason column; the *reason* rides the co-recorded event (`claim_released {reason}` / `lease_taken_over`), matching how `stale-claims` records its release.

7. **`releaseStaleClaims` skips leased claims.** Post-cutover every `in_progress` claim has a lease, and leased claims are governed by lease expiry (8h TTL), not the 4h idle guess. `releaseStaleClaims` continues to handle only lease-*less* claims (none after cutover). Without this a healthy quiet leased container would be wrongly released at 4h.

8. **Exempt surfaces (no lease required):** `comment`, `progress_note`, `attach_file`, `list_agent_sessions` — additive collaboration signals that cannot cause double-work; answer-sessions must use them on issues whose work-lease they don't hold.

---

## File Structure

- **Create** `src/services/leases.ts` — mint/validate/invalidate/expire + `getActiveLease`. One responsibility: the lease credential lifecycle.
- **Modify** `src/db/schema.ts` — add `claimLeases` and `claimLeaseCutover` tables.
- **Create** `drizzle/0014_*.sql` — generated migration (via `npm run db:generate`).
- **Modify** `src/services/settings.ts` — add `claims.lease_ttl_seconds` to `REGISTRY`.
- **Modify** `src/services/issues.ts` — thread lease through `updateIssue` (validate/mint/invalidate) and `claimIssue` (mint + takeover); export `ClaimResult`, `LeaseChannel`.
- **Modify** `src/services/needs-input.ts` — lease-gate `requestHumanInput`.
- **Modify** `src/services/comments.ts` — invalidate the active lease on the human-answer release.
- **Modify** `src/services/stale-claims.ts` — skip leased claims.
- **Modify** `src/services/webhook-dispatcher.ts` — call `expireLeases` in the sweep loop.
- **Create** `src/services/lease-cutover.ts` — `ensureClaimLeaseCutover` one-time backfill.
- **Modify** `src/server.ts` — run `ensureClaimLeaseCutover` at startup (next to `ensureRolloutBackfill`).
- **Modify** `src/mcp/server.ts` — `lease_token` input field on `update_issue`/`request_human_input`; `claim_issue` returns the token.
- **Modify** `src/rest/api-routes.ts` — extract `X-Switchyard-Lease` into `c.var.leaseToken`; thread it; `claim` returns the token.
- **Tests** under `tests/services/`, `tests/mcp/`, `tests/rest/`.

---

## Task 1: `claim_leases` + `claim_lease_cutover` schema and migration

**Files:**
- Modify: `src/db/schema.ts` (append two tables after `agentSessions`)
- Create: `drizzle/0014_*.sql` (generated)
- Test: `tests/db/claim-leases-schema.test.ts`

**Interfaces:**
- Produces: `claimLeases` table with columns `id, issueId, actorId, tokenHash (unique), expiresAt, lastBeatAt, invalidatedAt (nullable), createdAt`; `claimLeaseCutover` marker table `id, completedAt`. Drizzle row type `typeof claimLeases.$inferSelect`.

- [ ] **Step 1: Write the failing test**

Create `tests/db/claim-leases-schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { openDb } from "../../src/db/index.js";
import { claimLeases, actors, projects, issues } from "../../src/db/schema.js";

describe("claim_leases schema", () => {
  it("stores a lease row keyed by a unique token hash", () => {
    const db = openDb(":memory:");
    const actor = db.insert(actors).values({ name: "claude/worker", type: "agent" }).returning().get();
    const project = db.insert(projects).values({ key: "AIPI", name: "aipi" }).returning().get();
    const issue = db
      .insert(issues)
      .values({ projectId: project.id, number: 1, title: "t", status: "in_progress", creatorId: actor.id })
      .returning()
      .get();

    const now = Math.floor(Date.now() / 1000);
    const lease = db
      .insert(claimLeases)
      .values({ issueId: issue.id, actorId: actor.id, tokenHash: "abc", expiresAt: now + 3600, lastBeatAt: now })
      .returning()
      .get();

    expect(lease.invalidatedAt).toBeNull();
    expect(db.select().from(claimLeases).where(eq(claimLeases.id, lease.id)).get()?.tokenHash).toBe("abc");
    // token_hash is unique
    expect(() =>
      db.insert(claimLeases).values({ issueId: issue.id, actorId: actor.id, tokenHash: "abc", expiresAt: now, lastBeatAt: now }).run(),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/db/claim-leases-schema.test.ts`
Expected: FAIL — `claimLeases` is not exported from schema.

- [ ] **Step 3: Add the tables to `src/db/schema.ts`**

Append after the `agentSessions` table (end of file). `index` and `now` are already imported/defined at the top of the file:

```ts
// Session-scoped claim leases (SYD-210): a claim's credential layer on top of
// issues.assigneeId/status. At most one ACTIVE lease per issue —
// invalidated_at IS NULL AND expires_at > now — enforced by construction (a
// claim is 1:1 with an issue); invalidated/expired rows are retained for
// audit. Clones the sessions/loginLinks precedent (hashed token + actorId +
// expiresAt). token_hash is sha256 hex; the plaintext is returned once at
// claim time and never stored.
export const claimLeases = sqliteTable(
  "claim_leases",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    issueId: integer("issue_id")
      .notNull()
      .references(() => issues.id),
    actorId: integer("actor_id")
      .notNull()
      .references(() => actors.id),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: integer("expires_at").notNull(),
    // Heartbeat renewal (Layer B); = created_at at mint.
    lastBeatAt: integer("last_beat_at").notNull(),
    // Set by takeover / self-release / human-answer release / expiry sweep.
    invalidatedAt: integer("invalidated_at"),
    createdAt: integer("created_at").notNull().default(now()),
  },
  (t) => [index("claim_leases_issue_id_idx").on(t.issueId)],
);

// One-row marker: the SYD-210 hard-cutover backfill (release every pre-existing
// lease-less in_progress claim) ran. A marker, not an empty-table check, so it
// is once-only across restarts.
export const claimLeaseCutover = sqliteTable("claim_lease_cutover", {
  id: integer("id").primaryKey(),
  completedAt: integer("completed_at").notNull().default(now()),
});
```

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate` then `git checkout -- package-lock.json`
Expected: a new `drizzle/0014_*.sql` creating `claim_leases` (with the unique index on `token_hash` and the `claim_leases_issue_id_idx` index) and `claim_lease_cutover`. Open the file and confirm it only creates the two new tables (no unexpected drops/rebuilds of existing tables).

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/db/claim-leases-schema.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/db/schema.ts drizzle/ tests/db/claim-leases-schema.test.ts
git commit -m "feat: claim_leases + claim_lease_cutover schema (SYD-210)"
```

---

## Task 2: `leases.ts` — `getActiveLease`, `mintLease`, `validateLease` + the TTL setting

**Files:**
- Modify: `src/services/settings.ts:33-34` (add the setting to `REGISTRY`)
- Create: `src/services/leases.ts`
- Test: `tests/services/leases.test.ts`

**Interfaces:**
- Consumes: `claimLeases` (Task 1), `hashToken`/`mintToken` (`src/services/tokens.js`), `getSetting` (`src/services/settings.js`), `SwitchyardError`.
- Produces:
  - `LEASE_TTL_SETTING = "claims.lease_ttl_seconds"` (const)
  - `getActiveLease(db: DbOrTx, issueId: number, now?: number): ClaimLease | null`
  - `mintLease(tx: DbOrTx, issueId: number, actorId: number, ttlSeconds: number): string` (returns plaintext once)
  - `validateLease(db: DbOrTx, issueId: number, actorId: number, token: string | undefined): void` (throws on missing/expired/actor-mismatch/hash-mismatch)
  - `type ClaimLease = typeof claimLeases.$inferSelect`

- [ ] **Step 1: Write the failing test**

Create `tests/services/leases.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue } from "../../src/services/issues.js";
import { getActiveLease, mintLease, validateLease } from "../../src/services/leases.js";
import { getSetting } from "../../src/services/settings.js";

let db: Db, human: Actor, agent: Actor, issueId: number;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "AIPI", name: "aipi" });
  issueId = createIssue(db, human, { projectKey: "AIPI", title: "t" }).id;
});

describe("leases", () => {
  it("defaults lease_ttl_seconds to 8h", () => {
    expect(getSetting(db, "claims.lease_ttl_seconds")).toBe(8 * 3600);
  });

  it("mints a token, finds the active lease, and validates the minted token", () => {
    const token = mintLease(db, issueId, agent.id, 3600);
    expect(token).toMatch(/^lease_[0-9a-f]+$/);
    const active = getActiveLease(db, issueId);
    expect(active?.actorId).toBe(agent.id);
    expect(active?.tokenHash).not.toBe(token); // stored hashed, not plaintext
    expect(() => validateLease(db, issueId, agent.id, token)).not.toThrow();
  });

  it("rejects a wrong, absent, expired, or wrong-actor token", () => {
    const token = mintLease(db, issueId, agent.id, 3600);
    expect(() => validateLease(db, issueId, agent.id, "lease_deadbeef")).toThrow();
    expect(() => validateLease(db, issueId, agent.id, undefined)).toThrow();
    expect(() => validateLease(db, issueId, human.id, token)).toThrow(); // actor mismatch
    // expired: mint with a negative ttl so expires_at is already in the past
    const stale = mintLease(db, issueId, agent.id, -10);
    expect(getActiveLease(db, issueId)).toBeNull(); // no active lease now
    expect(() => validateLease(db, issueId, agent.id, stale)).toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/services/leases.test.ts`
Expected: FAIL — `claims.lease_ttl_seconds` unknown / `leases.js` missing.

- [ ] **Step 3: Add the setting**

In `src/services/settings.ts`, add to `REGISTRY` right after `"claims.deviation_seconds"`:

```ts
  "claims.lease_ttl_seconds": { type: "number", default: 8 * 3600 },
```

- [ ] **Step 4: Create `src/services/leases.ts`**

```ts
import { and, eq, gt, isNull } from "drizzle-orm";
import type { DbOrTx } from "../db/index.js";
import { claimLeases } from "../db/schema.js";
import { SwitchyardError } from "./errors.js";
import { hashToken, mintToken } from "./tokens.js";

export type ClaimLease = typeof claimLeases.$inferSelect;

/** The setting key for the mint TTL (default 8h). */
export const LEASE_TTL_SETTING = "claims.lease_ttl_seconds" as const;

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * The single active lease of an issue: not invalidated and not past
 * expires_at. At most one by construction (a claim is 1:1 with an issue).
 */
export function getActiveLease(
  db: DbOrTx,
  issueId: number,
  now: number = nowSeconds(),
): ClaimLease | null {
  return (
    db
      .select()
      .from(claimLeases)
      .where(
        and(
          eq(claimLeases.issueId, issueId),
          isNull(claimLeases.invalidatedAt),
          gt(claimLeases.expiresAt, now),
        ),
      )
      .get() ?? null
  );
}

/**
 * Inserts a fresh lease and returns the plaintext token ONCE. Store only the
 * hash; the plaintext is never re-derivable and never persisted elsewhere.
 * Runs inside the caller's transaction so a lease and its claim are atomic.
 */
export function mintLease(
  tx: DbOrTx,
  issueId: number,
  actorId: number,
  ttlSeconds: number,
): string {
  const token = mintToken("lease");
  const now = nowSeconds();
  tx.insert(claimLeases)
    .values({
      issueId,
      actorId,
      tokenHash: hashToken(token),
      expiresAt: now + ttlSeconds,
      lastBeatAt: now,
    })
    .run();
  return token;
}

/**
 * Throws unless `token` is the active lease for (issueId, actorId). Pure read.
 * A missing token, no active lease (expired/never-claimed), an actor mismatch,
 * or a superseded token (e.g. after takeover) all reject — this is the
 * SYD-93/122 shared-token close: a second session of the same worker actor
 * holds the shared bearer token but not this lease.
 */
export function validateLease(
  db: DbOrTx,
  issueId: number,
  actorId: number,
  token: string | undefined,
): void {
  const active = token ? getActiveLease(db, issueId) : null;
  if (!active || active.actorId !== actorId || active.tokenHash !== hashToken(token!)) {
    throw new SwitchyardError(
      "This action needs your claim's lease token, which is missing, expired, or superseded — " +
        "call claim_issue to (re)claim this issue and get a fresh lease. If another session took " +
        "it over, that session now owns the work.",
    );
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/services/leases.test.ts`
Expected: PASS (all 3).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/services/leases.ts src/services/settings.ts tests/services/leases.test.ts
git commit -m "feat: lease mint/validate + claims.lease_ttl_seconds setting (SYD-210)"
```

---

## Task 3: `leases.ts` — `invalidateLease`, `expireLeases`; sweep wiring; `releaseStaleClaims` skips leased

**Files:**
- Modify: `src/services/leases.ts` (add `invalidateLease`, `expireLeases`)
- Modify: `src/services/stale-claims.ts:30` (skip leased claims)
- Modify: `src/services/webhook-dispatcher.ts:87-95` (call `expireLeases`)
- Test: `tests/services/lease-expiry.test.ts`

**Interfaces:**
- Consumes: `getActiveLease` (Task 2), `recordEvent` (`src/services/events.js`), `issues`/`claimLeases` tables.
- Produces:
  - `invalidateLease(tx: DbOrTx, issueId: number): void` — marks the active lease invalidated; no-op if none. Caller records the reason event.
  - `expireLeases(db: Db, now?: number): number` — sweeps every non-invalidated lease with `expiresAt <= now`; releases the still-matching `in_progress` claim (re-assert-in-UPDATE), records `claim_released {reason:"lease_expired"}`, invalidates the lease; returns the count released.

- [ ] **Step 1: Write the failing test**

Create `tests/services/lease-expiry.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type Db } from "../../src/db/index.js";
import { claimLeases, issues } from "../../src/db/schema.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue, getIssue } from "../../src/services/issues.js";
import { expireLeases, invalidateLease, getActiveLease } from "../../src/services/leases.js";
import { releaseStaleClaims } from "../../src/services/stale-claims.js";
import { listIssueEvents } from "../../src/services/events.js";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "AIPI", name: "aipi" });
});

/** Claim AIPI-1 and force its lease to already be expired. */
function claimThenExpireLease(): number {
  createIssue(db, human, { projectKey: "AIPI", title: "t" });
  updateIssue(db, human, "AIPI-1", { status: "todo" });
  const { leaseToken } = claimIssue(db, agent, "AIPI-1");
  expect(leaseToken).toBeTruthy();
  const id = getIssue(db, "AIPI-1").id;
  db.update(claimLeases).set({ expiresAt: 1 }).where(eq(claimLeases.issueId, id)).run();
  return id;
}

describe("expireLeases", () => {
  it("releases an issue whose lease expired, recording claim_released{lease_expired}", () => {
    const id = claimThenExpireLease();
    expect(expireLeases(db)).toBe(1);
    const after = getIssue(db, "AIPI-1");
    expect(after.status).toBe("todo");
    expect(after.assigneeId).toBeNull();
    const last = listIssueEvents(db, id).at(-1)!;
    expect(last.type).toBe("claim_released");
    expect(last.payload).toMatchObject({ reason: "lease_expired" });
    expect(getActiveLease(db, id)).toBeNull();
    expect(expireLeases(db)).toBe(0); // idempotent — lease now invalidated
  });

  it("leaves a still-valid lease alone", () => {
    createIssue(db, human, { projectKey: "AIPI", title: "t" });
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimIssue(db, agent, "AIPI-1");
    expect(expireLeases(db)).toBe(0);
    expect(getIssue(db, "AIPI-1").status).toBe("in_progress");
  });

  it("does not release when the issue moved on before the sweep landed (race)", () => {
    const id = claimThenExpireLease();
    // someone moved it to in_review between select and update
    db.update(issues).set({ status: "in_review" }).where(eq(issues.id, id)).run();
    expect(expireLeases(db)).toBe(0);
    expect(getIssue(db, "AIPI-1").status).toBe("in_review");
    const types = listIssueEvents(db, id).map((e) => e.type);
    expect(types).not.toContain("claim_released");
  });

  it("invalidateLease marks the active lease and is a no-op when none", () => {
    createIssue(db, human, { projectKey: "AIPI", title: "t" });
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimIssue(db, agent, "AIPI-1");
    const id = getIssue(db, "AIPI-1").id;
    invalidateLease(db, id);
    expect(getActiveLease(db, id)).toBeNull();
    expect(() => invalidateLease(db, id)).not.toThrow();
  });

  it("releaseStaleClaims skips a leased claim (leases own expiry now)", () => {
    createIssue(db, human, { projectKey: "AIPI", title: "t" });
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimIssue(db, agent, "AIPI-1"); // mints a lease
    const id = getIssue(db, "AIPI-1").id;
    // age all events past the 4h idle window, but the lease is still valid
    const old = Math.floor(Date.now() / 1000) - 5 * 3600;
    db.update(db.$client ? issues : issues).set({}).where(eq(issues.id, id)); // no-op guard for lint
    const { events } = await import("../../src/db/schema.js");
    db.update(events).set({ createdAt: old }).where(eq(events.issueId, id)).run();
    expect(releaseStaleClaims(db)).toBe(0); // would be 1 without the leased-skip
    expect(getIssue(db, "AIPI-1").status).toBe("in_progress");
  });
});
```

> Note: in the last test, drop the `db.update(...).where(...)` no-op line and the dynamic `events` import if you prefer — import `events` at the top instead. It is written inline only to keep the snippet self-contained. Prefer the top-level import:
> ```ts
> import { claimLeases, issues, events } from "../../src/db/schema.js";
> ```
> and make the test function `async` only if you keep a dynamic import (you won't need to with the top-level import). Age events with:
> ```ts
> db.update(events).set({ createdAt: Math.floor(Date.now() / 1000) - 5 * 3600 }).where(eq(events.issueId, id)).run();
> ```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/services/lease-expiry.test.ts`
Expected: FAIL — `expireLeases`/`invalidateLease` not exported; and `claimIssue` does not yet return `{ leaseToken }` (that lands in Task 5). **This test depends on Task 5's `claimIssue` return shape** — if executing strictly in order, write the test now but expect it to keep failing on the `claimIssue` return until Task 5. To keep this task self-contained, temporarily mint directly instead of via `claimIssue`:
> Replace `const { leaseToken } = claimIssue(...)` with `claimIssue(...); mintLease(...)` is wrong (double-claim). Instead, in this task's tests, mint the lease directly against the claimed issue:
> ```ts
> import { mintLease } from "../../src/services/leases.js";
> // ...
> claimIssue(db, agent, "AIPI-1");
> const id = getIssue(db, "AIPI-1").id;
> mintLease(db, id, agent.id, 3600); // stand-in until claimIssue mints (Task 5)
> db.update(claimLeases).set({ expiresAt: 1 }).where(eq(claimLeases.issueId, id)).run();
> ```
> After Task 5, simplify these tests to rely on `claimIssue` minting. (The plan orders Task 3 before the `issues.ts` threading so the sweep exists first; the small stand-in avoids a forward dependency.)

- [ ] **Step 3: Add `invalidateLease` + `expireLeases` to `src/services/leases.ts`**

Add imports at the top (extend the existing drizzle import and add `Db`, `issues`, `recordEvent`):

```ts
import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../db/index.js";
import { claimLeases, issues } from "../db/schema.js";
import { recordEvent } from "./events.js";
```

Append the two functions:

```ts
/**
 * Marks the active lease of an issue invalidated (takeover / self-release /
 * human-answer release). No-op if there is no active lease. The REASON is
 * carried by the event the caller co-records (claim_released{reason} /
 * lease_taken_over), not stored on the lease row.
 */
export function invalidateLease(tx: DbOrTx, issueId: number): void {
  const active = getActiveLease(tx, issueId);
  if (!active) return;
  tx.update(claimLeases)
    .set({ invalidatedAt: sql`(unixepoch())` })
    .where(eq(claimLeases.id, active.id))
    .run();
}

/**
 * Sweep: for every non-invalidated lease past expires_at, atomically release
 * the still-matching in_progress claim (re-assert status/needsInput inside the
 * UPDATE, exactly like releaseStaleClaims — a legit transition that landed
 * first wins the race, .changes === 0 ⇒ skip the event), record
 * claim_released{reason:"lease_expired"}, and mark the lease invalidated (so it
 * leaves future sweeps). Replaces the 4h idle guess for leased claims.
 * Returns the number of issues released.
 */
export function expireLeases(db: Db, now: number = nowSeconds()): number {
  const expired = db
    .select()
    .from(claimLeases)
    .where(and(isNull(claimLeases.invalidatedAt), lte(claimLeases.expiresAt, now)))
    .all();
  let released = 0;
  for (const lease of expired) {
    const issue = db.select().from(issues).where(eq(issues.id, lease.issueId)).get();
    const actorId = issue?.assigneeId ?? issue?.creatorId ?? lease.actorId;
    const wasReleased = db.transaction((tx) => {
      // Always invalidate the expired lease, even if the issue moved on, so the
      // next sweep does not re-scan it.
      tx.update(claimLeases)
        .set({ invalidatedAt: sql`(unixepoch())` })
        .where(eq(claimLeases.id, lease.id))
        .run();
      const result = tx
        .update(issues)
        .set({ status: "todo", assigneeId: null, updatedAt: sql`(unixepoch())` })
        .where(
          and(
            eq(issues.id, lease.issueId),
            eq(issues.status, "in_progress"),
            eq(issues.needsInput, false),
          ),
        )
        .run();
      if (result.changes === 0) return false;
      recordEvent(tx, {
        issueId: lease.issueId,
        actorId,
        type: "claim_released",
        payload: { reason: "lease_expired" },
      });
      return true;
    });
    if (wasReleased) released++;
  }
  return released;
}
```

- [ ] **Step 4: Make `releaseStaleClaims` skip leased claims**

In `src/services/stale-claims.ts`, add the import and the skip. After the existing `import { getSetting } from "./settings.js";` add:

```ts
import { getActiveLease } from "./leases.js";
```

Inside the `for (const issue of inProgress)` loop, right after the existing `if (issue.needsInput) continue;` line, add:

```ts
    // SYD-210: a leased claim is governed by lease expiry (8h TTL), not the 4h
    // idle guess — a healthy quiet container keeps its lease. Only lease-less
    // claims (none after the hard cutover) still fall to this idle sweep.
    if (getActiveLease(db, issue.id)) continue;
```

- [ ] **Step 5: Wire `expireLeases` into the sweep loop**

In `src/services/webhook-dispatcher.ts`, add the import:

```ts
import { expireLeases } from "./leases.js";
```

In `startWebhookDispatcher`'s interval body, add a block next to the `releaseStaleClaims` one:

```ts
    try {
      expireLeases(db);
    } catch (err) {
      console.error("lease expiry sweep:", err);
    }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/services/lease-expiry.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + affected suite + commit**

Run: `npm run typecheck` and `npx vitest run tests/services/lease-expiry.test.ts tests/services/stale-claims.test.ts`
```bash
git add src/services/leases.ts src/services/stale-claims.ts src/services/webhook-dispatcher.ts tests/services/lease-expiry.test.ts
git commit -m "feat: lease expiry sweep + stale-claims skips leased (SYD-210)"
```

---

## Task 4: `updateIssue` — validate holder mutations, mint fresh claims, invalidate on self-release

**Files:**
- Modify: `src/services/issues.ts` (`updateIssue` signature + body)
- Test: `tests/services/lease-update-issue.test.ts`

**Interfaces:**
- Consumes: `getSetting` (for TTL), `mintLease`/`validateLease`/`invalidateLease` (Tasks 2-3).
- Produces (new exported types + changed signature):
  - `type LeaseChannel = { presented?: string; minted?: { token: string | null } }`
  - `updateIssue(db, actor, ref, patch, lease?: LeaseChannel): IssueView` — return type **unchanged** (`IssueView`); the minted token escapes via `lease.minted.token` (out-param) so it never rides the serialized view. `lease` defaults to `{}`.

- [ ] **Step 1: Write the failing test**

Create `tests/services/lease-update-issue.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, getIssue } from "../../src/services/issues.js";
import { getActiveLease } from "../../src/services/leases.js";
import { listIssueEvents } from "../../src/services/events.js";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "AIPI", name: "aipi" });
  createIssue(db, human, { projectKey: "AIPI", title: "t" });
  updateIssue(db, human, "AIPI-1", { status: "todo" });
});

describe("updateIssue lease enforcement", () => {
  it("mints a lease on the SYD-111 bare-PATCH auto-claim and returns it via the out-param", () => {
    const minted = { token: null as string | null };
    updateIssue(db, agent, "AIPI-1", { status: "in_progress" }, { minted });
    expect(minted.token).toMatch(/^lease_/);
    const id = getIssue(db, "AIPI-1").id;
    expect(getActiveLease(db, id)?.actorId).toBe(agent.id);
  });

  it("rejects a holder agent's mutation with no lease token, accepts it with the minted one", () => {
    const minted = { token: null as string | null };
    updateIssue(db, agent, "AIPI-1", { status: "in_progress" }, { minted });
    const token = minted.token!;
    // no token -> rejected (shared-token hole: a second session lacks the lease)
    expect(() => updateIssue(db, agent, "AIPI-1", { status: "in_review" })).toThrow();
    // wrong token -> rejected
    expect(() =>
      updateIssue(db, agent, "AIPI-1", { status: "in_review" }, { presented: "lease_wrong" }),
    ).toThrow();
    // correct token -> ok
    const after = updateIssue(db, agent, "AIPI-1", { status: "in_review" }, { presented: token });
    expect(after.status).toBe("in_review");
  });

  it("invalidates the lease on self-release to todo (after validating the holder)", () => {
    const minted = { token: null as string | null };
    updateIssue(db, agent, "AIPI-1", { status: "in_progress" }, { minted });
    const id = getIssue(db, "AIPI-1").id;
    updateIssue(db, agent, "AIPI-1", { status: "todo" }, { presented: minted.token! });
    expect(getIssue(db, "AIPI-1").status).toBe("todo");
    expect(getActiveLease(db, id)).toBeNull();
    const types = listIssueEvents(db, id).map((e) => e.type);
    expect(types).toContain("claim_released");
  });

  it("does not lease-gate a human editing a claimed issue", () => {
    const minted = { token: null as string | null };
    updateIssue(db, agent, "AIPI-1", { status: "in_progress" }, { minted });
    // human reassigns / edits without any lease token — must not throw
    expect(() => updateIssue(db, human, "AIPI-1", { priority: "high" })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/services/lease-update-issue.test.ts`
Expected: FAIL — `updateIssue` does not accept a 5th arg / does not mint or validate.

- [ ] **Step 3: Thread the lease through `updateIssue`**

In `src/services/issues.ts`:

Add imports near the top (after the existing service imports):

```ts
import { getSetting } from "./settings.js";
import { mintLease, validateLease, invalidateLease } from "./leases.js";
```

Add the exported type above `updateIssue`:

```ts
/**
 * How a caller passes the lease token in and receives a freshly minted one out
 * (SYD-210). `presented` is the token the holder supplies for validation;
 * `minted` is an out-container the function fills when this call establishes a
 * new claim — kept off the returned IssueView so the token is never serialized.
 */
export type LeaseChannel = { presented?: string; minted?: { token: string | null } };
```

Change the signature:

```ts
export function updateIssue(
  db: Db,
  actor: Actor,
  ref: string,
  patch: UpdateIssueInput,
  lease: LeaseChannel = {},
): IssueView {
```

Inside the transaction, immediately after `const current = getIssue(tx, ref);`, add the enforcement decision:

```ts
    // SYD-210: an agent mutating an issue it already holds must present the
    // lease minted at claim time — this closes the shared-token double-work
    // hole (a second session of the same worker actor holds the shared bearer
    // token but not this lease). Humans are individuated by actor and are never
    // lease-gated. A fresh claim (assigneeId === null -> assigned, below) mints
    // instead of validating, so the two are disjoint.
    const isHolderMutation = actor.type === "agent" && current.assigneeId === actor.id;
    if (isHolderMutation) {
      validateLease(tx, current.id, actor.id, lease.presented);
    }
```

In the existing `status === "todo"` self-release block (the one that sets `changes.assigneeId = null` and records `claim_released {reason:"moved_to_todo"}`), add a lease invalidation right after the `toRecord.push(... moved_to_todo ...)` line:

```ts
        invalidateLease(tx, current.id);
```

At the very end of the transaction, right **before** `if (Object.keys(changes).length === 0) return current;`, add the mint:

```ts
    // Mint a lease when this update establishes a fresh claim: an unassigned
    // issue becoming assigned to the actor and in_progress (the claimIssue
    // self-assign path AND the SYD-111 bare-PATCH auto-claim path both land
    // here). Disjoint from the holder-validation above (assigneeId was null).
    if (
      lease.minted &&
      changes.assigneeId === actor.id &&
      current.assigneeId === null &&
      (changes.status === "in_progress" || current.status === "in_progress")
    ) {
      lease.minted.token = mintLease(
        tx,
        current.id,
        actor.id,
        getSetting(db, "claims.lease_ttl_seconds"),
      );
    }
```

> Note the mint sits before the empty-changes early return, but a fresh claim always has `changes.assigneeId` set, so `changes` is non-empty and the row is written. The mint being inside the transaction keeps lease+claim atomic.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/services/lease-update-issue.test.ts`
Expected: PASS.

- [ ] **Step 5: Full affected suite (regression sweep) + typecheck**

`updateIssue` is widely used — run the issue/claim suites to catch fallout (e.g. an existing test that PATCHes an agent-held issue without a token now legitimately fails and must be updated to pass a token, OR reflects the human path):

Run: `npm run typecheck` then `npx vitest run tests/services/issues-update.test.ts tests/services/stale-claims.test.ts tests/services/claim-blocked-isolated.test.ts tests/services/lease-update-issue.test.ts`
Expected: PASS. If a pre-existing test fails because it drove an agent holder mutation without a lease, update that test to thread the token (the behavior change is intended); note each such edit in the commit body.

- [ ] **Step 6: Commit**

```bash
git add src/services/issues.ts tests/services/
git commit -m "feat: updateIssue validates/mints/invalidates claim leases (SYD-210)"
```

---

## Task 5: `claimIssue` — mint + return token, opt-in takeover

**Files:**
- Modify: `src/services/issues.ts` (`claimIssue`)
- Test: `tests/services/lease-claim-takeover.test.ts`

**Interfaces:**
- Consumes: `updateIssue` + `LeaseChannel` (Task 4), `getActiveLease`/`invalidateLease`/`mintLease` (Tasks 2-3), `recordEvent`, `getSetting`.
- Produces (changed signature + new type):
  - `type ClaimResult = { issue: IssueView; leaseToken: string }`
  - `claimIssue(db, actor, ref, opts?: { takeover?: boolean }): ClaimResult`

- [ ] **Step 1: Write the failing test**

Create `tests/services/lease-claim-takeover.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue, getIssue } from "../../src/services/issues.js";
import { validateLease, getActiveLease } from "../../src/services/leases.js";
import { listIssueEvents } from "../../src/services/events.js";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "AIPI", name: "aipi" });
  createIssue(db, human, { projectKey: "AIPI", title: "t" });
  updateIssue(db, human, "AIPI-1", { status: "todo" });
});

describe("claimIssue leases + takeover", () => {
  it("returns a fresh lease token that validates", () => {
    const { issue, leaseToken } = claimIssue(db, agent, "AIPI-1");
    expect(issue.status).toBe("in_progress");
    expect(leaseToken).toMatch(/^lease_/);
    expect(() => validateLease(db, issue.id, agent.id, leaseToken)).not.toThrow();
  });

  it("fails loudly on a bare same-actor re-claim of an actively-leased issue", () => {
    claimIssue(db, agent, "AIPI-1");
    expect(() => claimIssue(db, agent, "AIPI-1")).toThrow(/takeover/i);
  });

  it("takeover:true invalidates the old lease, records lease_taken_over, and evicts the old holder", () => {
    const first = claimIssue(db, agent, "AIPI-1").leaseToken;
    const id = getIssue(db, "AIPI-1").id;
    const second = claimIssue(db, agent, "AIPI-1", { takeover: true }).leaseToken;
    expect(second).not.toBe(first);
    // old token no longer validates; new one does
    expect(() => validateLease(db, id, agent.id, first)).toThrow();
    expect(() => validateLease(db, id, agent.id, second)).not.toThrow();
    // evicted holder's next lease-gated call is rejected immediately
    expect(() => updateIssue(db, agent, "AIPI-1", { status: "in_review" }, { presented: first })).toThrow();
    expect(listIssueEvents(db, id).map((e) => e.type)).toContain("lease_taken_over");
    // exactly one active lease
    expect(getActiveLease(db, id)?.tokenHash).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/services/lease-claim-takeover.test.ts`
Expected: FAIL — `claimIssue` returns `IssueView`, not `{ issue, leaseToken }`; no takeover.

- [ ] **Step 3: Rewrite `claimIssue`**

Replace the existing `claimIssue` in `src/services/issues.ts` with:

```ts
/**
 * The result of a claim: the updated issue plus the plaintext lease token,
 * handed to the claiming session ONCE (never stored, never re-returned).
 */
export type ClaimResult = { issue: IssueView; leaseToken: string };

export function claimIssue(
  db: Db,
  actor: Actor,
  ref: string,
  opts: { takeover?: boolean } = {},
): ClaimResult {
  const current = getIssue(db, ref);
  const blockers = getOpenBlockers(db, current.id);
  if (blockers.length > 0) {
    throw new SwitchyardError(
      `${ref} is blocked by ${blockers.map((b) => b.ref).join(", ")} — resolve the blocker first, or call next_task for another issue.`,
    );
  }

  // Same-actor re-claim of an issue that already has an active lease: fail
  // loudly unless takeover is opted in (this project's workflow tells every
  // session to claim before touching code, and interactive + dispatched
  // sessions share the worker actor — a default takeover would silently kill a
  // healthy running container). Takeover only reaches here for the same actor;
  // a different actor's claim is refused by assertClaimable below.
  if (current.assigneeId === actor.id) {
    const active = getActiveLease(db, current.id);
    if (active && !opts.takeover) {
      throw new SwitchyardError(
        `${ref} already has an active lease held by this actor — another session may be working it. ` +
          `Pass takeover: true to seize the claim (invalidating that session's lease), or call next_task for another issue.`,
      );
    }
    // Re-claim (takeover, or a lease-less holder e.g. after expiry): swap the
    // lease in one transaction. The issue is already in_progress + assigned, so
    // no status change is needed.
    const leaseToken = db.transaction((tx) => {
      if (active) {
        invalidateLease(tx, current.id);
        recordEvent(tx, { issueId: current.id, actorId: actor.id, type: "lease_taken_over", payload: {} });
      }
      return mintLease(tx, current.id, actor.id, getSetting(db, "claims.lease_ttl_seconds"));
    });
    return { issue: getIssue(db, ref), leaseToken };
  }

  // Fresh claim of an unassigned (or blocked/PR-guarded) issue: assertClaimable
  // is re-checked inside updateIssue's in_progress gate; the mint happens there
  // via the out-channel.
  assertClaimable(db, actor, current);
  const minted: { token: string | null } = { token: null };
  const issue = updateIssue(db, actor, ref, { status: "in_progress", assigneeName: actor.name }, { minted });
  if (minted.token === null) {
    // Defensive: the auto-claim mint condition should always fire on a fresh
    // claim. If it didn't, the claim state is inconsistent — fail rather than
    // hand back an empty token.
    throw new SwitchyardError(`Failed to mint a lease while claiming ${ref} — retry the claim.`);
  }
  return { issue, leaseToken: minted.token };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/services/lease-claim-takeover.test.ts`
Expected: PASS.

- [ ] **Step 5: Fix the two `claimIssue` return-shape callers (compile break) + simplify Task 3 stand-ins**

`claimIssue` now returns `{ issue, leaseToken }`. The adapters are updated in Tasks 8-9, but the typecheck breaks now. Fix the call sites minimally so the tree compiles, then finish them in Tasks 8-9:
- `src/mcp/server.ts:206` and `src/rest/api-routes.ts:237` — these are rewritten in Tasks 8-9. If executing in order, make the minimal change now: MCP `guard(({ ref }) => claimIssue(db, actor, ref))` → returns `{ issue, leaseToken }` (a valid object, fine to ship as-is for the compile); REST `c.json(claimIssue(...))` likewise returns the object.
- Any test using `claimIssue(...).status` or treating the result as an IssueView must switch to `.issue.status`. Grep: `git grep -n "claimIssue(" tests/ src/`. Update `tests/services/lease-expiry.test.ts` to use the real `claimIssue(...).leaseToken` now (remove the Task 3 `mintLease` stand-in).

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Regression sweep**

Run: `npx vitest run tests/services/ tests/mcp/ tests/rest/`
Expected: PASS (adapter tests for `claim` may need the Task 8-9 shape; if a claim adapter test fails purely on the new response shape, note it and let Tasks 8-9's tests supersede it — do not delete coverage).

- [ ] **Step 7: Commit**

```bash
git add src/services/issues.ts src/mcp/server.ts src/rest/api-routes.ts tests/
git commit -m "feat: claimIssue mints + returns lease, opt-in takeover (SYD-210)"
```

---

## Task 6: `requestHumanInput` — lease-gate the escalation

**Files:**
- Modify: `src/services/needs-input.ts`
- Modify: `src/mcp/server.ts` (pass `lease_token` — finalized in Task 8, minimal here) / `src/rest/api-routes.ts` (pass header — Task 9)
- Test: `tests/services/lease-request-input.test.ts`

**Interfaces:**
- Consumes: `validateLease` (Task 2).
- Produces: `requestHumanInput(db, actor, ref, question, leaseToken?: string): IssueView` (new trailing optional param).

- [ ] **Step 1: Write the failing test**

Create `tests/services/lease-request-input.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue } from "../../src/services/issues.js";
import { requestHumanInput } from "../../src/services/needs-input.js";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "AIPI", name: "aipi" });
  createIssue(db, human, { projectKey: "AIPI", title: "t" });
  updateIssue(db, human, "AIPI-1", { status: "todo" });
});

describe("requestHumanInput lease gate", () => {
  it("rejects an agent escalation with no lease token and accepts it with the claim's token", () => {
    const { leaseToken } = claimIssue(db, agent, "AIPI-1");
    expect(() => requestHumanInput(db, agent, "AIPI-1", "Which approach?")).toThrow();
    const issue = requestHumanInput(db, agent, "AIPI-1", "Which approach?", leaseToken);
    expect(issue.needsInput).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/services/lease-request-input.test.ts`
Expected: FAIL — the no-token call does not throw yet.

- [ ] **Step 3: Gate `requestHumanInput`**

In `src/services/needs-input.ts`, add the import:

```ts
import { validateLease } from "./leases.js";
```

Change the signature and validate at the top of the transaction:

```ts
export function requestHumanInput(
  db: Db,
  actor: Actor,
  ref: string,
  question: string,
  leaseToken?: string,
): IssueView {
  if (!question.trim()) {
    throw new SwitchyardError(
      "A question is required — say what you need a human to decide or clarify.",
    );
  }
  return db.transaction((tx) => {
    const issue = getIssue(tx, ref);
    // SYD-210: escalating is a claim-scoped mutation — an agent must hold the
    // issue's lease. Humans are not lease-gated.
    if (actor.type === "agent") {
      validateLease(tx, issue.id, actor.id, leaseToken);
    }
    const row = tx
      .update(issues)
      .set({ needsInput: true, updatedAt: sql`(unixepoch())` })
      .where(eq(issues.id, issue.id))
      .returning()
      .get();
    // ... unchanged: record comment + needs_input_set, return toView(tx, row)
```

Leave the rest of the function body unchanged.

- [ ] **Step 4: Fix internal callers**

Check `tests/services/stale-claims.test.ts` and any other caller that calls `requestHumanInput(db, agent, ...)` — those now need the claim's lease token. In `stale-claims.test.ts`, the escalation tests claim via `claimIssue`; capture the returned `leaseToken` and pass it:
```ts
const { leaseToken } = claimIssue(db, agent, "AIPI-1");
requestHumanInput(db, agent, "AIPI-1", "…", leaseToken);
```
Grep: `git grep -n "requestHumanInput(" tests/ src/` and update each agent-actor call.

- [ ] **Step 5: Run the test + affected suite to verify passes**

Run: `npm run typecheck` then `npx vitest run tests/services/lease-request-input.test.ts tests/services/stale-claims.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/needs-input.ts tests/services/
git commit -m "feat: request_human_input requires the claim lease (SYD-210)"
```

---

## Task 7: Human-answer release invalidates the lease

**Files:**
- Modify: `src/services/comments.ts:30-52`
- Test: `tests/services/lease-human-answer.test.ts`

**Interfaces:**
- Consumes: `invalidateLease` (Task 3), `getActiveLease`.
- Produces: no signature change — `addComment` stays `(db, actor, ref, body)`. Behavior: a human comment on a `needsInput` issue that is `in_progress` now also invalidates the active lease (lease-exempt path: the human never held it); on a non-`in_progress` issue it only clears the flag (no release, no invalidation) — preserving today's status condition.

- [ ] **Step 1: Write the failing test**

Create `tests/services/lease-human-answer.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue, getIssue } from "../../src/services/issues.js";
import { requestHumanInput } from "../../src/services/needs-input.js";
import { addComment } from "../../src/services/comments.js";
import { getActiveLease } from "../../src/services/leases.js";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "AIPI", name: "aipi" });
  createIssue(db, human, { projectKey: "AIPI", title: "t" });
  updateIssue(db, human, "AIPI-1", { status: "todo" });
});

describe("human-answer release invalidates the lease", () => {
  it("releases an in_progress needsInput issue AND invalidates its lease", () => {
    const { leaseToken } = claimIssue(db, agent, "AIPI-1");
    const id = getIssue(db, "AIPI-1").id;
    requestHumanInput(db, agent, "AIPI-1", "Which approach?", leaseToken);
    addComment(db, human, "AIPI-1", "Go with option B.");
    const after = getIssue(db, "AIPI-1");
    expect(after.status).toBe("todo");
    expect(after.assigneeId).toBeNull();
    expect(after.needsInput).toBe(false);
    expect(getActiveLease(db, id)).toBeNull(); // lease invalidated
  });

  it("on a non-in_progress needsInput issue, only clears the flag (no invalidation)", () => {
    // Put it in_review with a still-active lease, then set needsInput directly.
    const { leaseToken } = claimIssue(db, agent, "AIPI-1");
    const id = getIssue(db, "AIPI-1").id;
    updateIssue(db, agent, "AIPI-1", { status: "in_review" }, { presented: leaseToken });
    requestHumanInput(db, agent, "AIPI-1", "still need a decision", leaseToken);
    expect(getIssue(db, "AIPI-1").needsInput).toBe(true);
    addComment(db, human, "AIPI-1", "answered");
    const after = getIssue(db, "AIPI-1");
    expect(after.needsInput).toBe(false);
    expect(after.status).toBe("in_review"); // not released
    expect(getActiveLease(db, id)).not.toBeNull(); // lease untouched
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/services/lease-human-answer.test.ts`
Expected: FAIL — the lease survives the in_progress human-answer release.

- [ ] **Step 3: Invalidate the lease in the release branch**

In `src/services/comments.ts`, add the import:

```ts
import { invalidateLease } from "./leases.js";
```

In the `if (actor.type === "human" && issue.needsInput)` block, inside the `if (release) { ... }` branch (after the `claim_released` event is recorded), add:

```ts
        invalidateLease(tx, issue.id);
```

(Only in the `release` branch, so a non-`in_progress` answer leaves the lease untouched — preserving the existing status condition.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/services/lease-human-answer.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/services/comments.ts tests/services/lease-human-answer.test.ts
git commit -m "feat: human-answer release invalidates the claim lease (SYD-210)"
```

---

## Task 8: MCP adapter — `lease_token` field + `claim_issue` returns the token

**Files:**
- Modify: `src/mcp/server.ts` (`claim_issue`, `update_issue`, `request_human_input`)
- Test: `tests/mcp/lease-tools.test.ts`

**Interfaces:**
- Consumes: `claimIssue` (`ClaimResult`), `updateIssue` (`LeaseChannel`), `requestHumanInput`.
- Produces: MCP `claim_issue` result `{ ...issue, lease_token }`; `update_issue` accepts `lease_token` (validated for holders; returns `lease_token` when it auto-claims); `request_human_input` accepts `lease_token`.

- [ ] **Step 1: Write the failing test**

Create `tests/mcp/lease-tools.test.ts` (model the harness on `tests/mcp/write-tools.test.ts` — `connect(actor)`, `text(r)`, `beforeEach`):

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue } from "../../src/services/issues.js";
import { buildMcpServer } from "../../src/mcp/server.js";

let db: Db, human: Actor, agent: Actor;
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
  createProject(db, human, { key: "AIPI", name: "aipi" });
  createIssue(db, human, { projectKey: "AIPI", title: "t" });
  updateIssue(db, human, "AIPI-1", { status: "todo" });
});

describe("MCP lease enforcement", () => {
  it("claim_issue returns a lease_token", async () => {
    const c = await connect(agent);
    const res = JSON.parse(text(await c.callTool({ name: "claim_issue", arguments: { ref: "AIPI-1" } })));
    expect(res.lease_token).toMatch(/^lease_/);
    expect(res.status).toBe("in_progress");
  });

  it("a second session with the shared bearer token but no lease cannot update_issue", async () => {
    const a = await connect(agent);
    await a.callTool({ name: "claim_issue", arguments: { ref: "AIPI-1" } }); // session A holds the lease
    const b = await connect(agent); // same actor (shared bearer token), different session
    const r = await b.callTool({ name: "update_issue", arguments: { ref: "AIPI-1", status: "in_review" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/lease/i);
  });

  it("the holder can update_issue with the returned lease_token", async () => {
    const c = await connect(agent);
    const claim = JSON.parse(text(await c.callTool({ name: "claim_issue", arguments: { ref: "AIPI-1" } })));
    const r = await c.callTool({
      name: "update_issue",
      arguments: { ref: "AIPI-1", status: "in_review", lease_token: claim.lease_token },
    });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r)).status).toBe("in_review");
  });

  it("exempt surfaces (comment) work without a lease", async () => {
    const a = await connect(agent);
    await a.callTool({ name: "claim_issue", arguments: { ref: "AIPI-1" } });
    const b = await connect(agent);
    const r = await b.callTool({ name: "comment", arguments: { ref: "AIPI-1", body: "fyi" } });
    expect(r.isError).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/mcp/lease-tools.test.ts`
Expected: FAIL — `claim_issue` result has no `lease_token`; `update_issue` has no `lease_token` field.

- [ ] **Step 3: Update the MCP tools in `src/mcp/server.ts`**

`claim_issue` — add a `takeover` arg (an interactive session that lost its token to compaction, or a supervisor seizing a stuck same-actor claim, recovers with it) and return the token flat alongside the issue. Add to the `claim_issue` input schema:

```ts
      inputSchema: {
        ref: z.string(),
        takeover: z.boolean().optional(),
      },
```

and the handler:

```ts
    guard(({ ref, takeover }: { ref: string; takeover?: boolean }) => {
      const { issue, leaseToken } = claimIssue(db, actor, ref, { takeover });
      return { ...issue, lease_token: leaseToken };
    }),
```

Append to `claim_issue`'s description: `"If you already hold an active lease on this issue (e.g. a prior session), the bare claim fails — pass takeover: true to seize it, invalidating that session's lease."`

`update_issue` — add `lease_token` to the input schema (after `expected_head_sha`):

```ts
        lease_token: z.string().optional(),
```

and in the handler, thread it and surface a minted token:

```ts
    guard(
      (a: {
        ref: string;
        status?: (typeof STATUSES)[number];
        priority?: (typeof PRIORITIES)[number];
        title?: string;
        summary?: string | null;
        description?: string;
        assignee?: string | null;
        labels?: string[];
        worker_preference?: string | null;
        expected_head_sha?: string;
        lease_token?: string;
      }) => {
        const minted: { token: string | null } = { token: null };
        const issue = updateIssue(
          db,
          actor,
          a.ref,
          {
            status: a.status,
            priority: a.priority,
            title: a.title,
            summary: a.summary,
            description: a.description,
            assigneeName: a.assignee,
            labels: a.labels,
            workerPreference: a.worker_preference,
            expectedHeadSha: a.expected_head_sha,
          },
          { presented: a.lease_token, minted },
        );
        return minted.token ? { ...issue, lease_token: minted.token } : issue;
      },
    ),
```

`request_human_input` — add `lease_token` to the schema and pass it:

```ts
      inputSchema: { ref: z.string(), question: z.string(), lease_token: z.string().optional() },
    },
    guard(({ ref, question, lease_token }: { ref: string; question: string; lease_token?: string }) =>
      requestHumanInput(db, actor, ref, question, lease_token),
    ),
```

Update the `update_issue` and `request_human_input` tool `description` strings to mention the lease briefly, e.g. append to `update_issue`'s description: `"If you claimed this issue, pass lease_token (returned by claim_issue) — the server rejects a claim-scoped change without your session's lease."`

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mcp/lease-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Regression + typecheck + commit**

Run: `npm run typecheck` then `npx vitest run tests/mcp/`
```bash
git add src/mcp/server.ts tests/mcp/lease-tools.test.ts
git commit -m "feat: MCP lease_token field + claim_issue returns lease (SYD-210)"
```

---

## Task 9: REST adapter — `X-Switchyard-Lease` header + `claim` returns the token

**Files:**
- Modify: `src/rest/api-routes.ts` (Env type, auth middleware, PATCH `/issues/:ref`, POST `/issues/:ref/claim`, POST `/issues/:ref/request-input`)
- Test: `tests/rest/lease-header.test.ts`

**Interfaces:**
- Consumes: `claimIssue`, `updateIssue` (`LeaseChannel`), `requestHumanInput`.
- Produces: `c.var.leaseToken` (extracted once from `X-Switchyard-Lease`); PATCH validates holders / returns `leaseToken` on auto-claim; `claim` returns `{ ...issue, leaseToken }`; `request-input` threads the token.

- [ ] **Step 1: Write the failing test**

Create `tests/rest/lease-header.test.ts` (model on an existing rest test; drive `buildApiRoutes(db).fetch` with `Authorization: Bearer <token>`). Capture actor tokens from `createActor`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue } from "../../src/services/issues.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

let db: Db, app: ReturnType<typeof buildApiRoutes>, agentToken: string;
const auth = (extra: Record<string, string> = {}) => ({
  Authorization: `Bearer ${agentToken}`,
  "content-type": "application/json",
  ...extra,
});

beforeEach(() => {
  db = openDb(":memory:");
  const human = createActor(db, { name: "sean", type: "human" }).actor;
  agentToken = createActor(db, { name: "claude/worker", type: "agent" }).token;
  createProject(db, human, { key: "AIPI", name: "aipi" });
  createIssue(db, human, { projectKey: "AIPI", title: "t" });
  updateIssue(db, human, "AIPI-1", { status: "todo" });
  app = buildApiRoutes(db);
});

describe("REST X-Switchyard-Lease", () => {
  it("POST /claim returns a leaseToken", async () => {
    const r = await app.request("/issues/AIPI-1/claim", { method: "POST", headers: auth() });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.leaseToken).toMatch(/^lease_/);
  });

  it("PATCH by a holder without the header is rejected; with it, accepted", async () => {
    const claim = await (await app.request("/issues/AIPI-1/claim", { method: "POST", headers: auth() })).json();
    const noHeader = await app.request("/issues/AIPI-1", {
      method: "PATCH",
      headers: auth(),
      body: JSON.stringify({ status: "in_review" }),
    });
    expect(noHeader.status).toBe(400);
    const withHeader = await app.request("/issues/AIPI-1", {
      method: "PATCH",
      headers: auth({ "X-Switchyard-Lease": claim.leaseToken }),
      body: JSON.stringify({ status: "in_review" }),
    });
    expect(withHeader.status).toBe(200);
    expect((await withHeader.json()).status).toBe("in_review");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/rest/lease-header.test.ts`
Expected: FAIL — no `leaseToken` in claim response; PATCH not gated.

- [ ] **Step 3: Extend the Env type + middleware**

In `src/rest/api-routes.ts`, change the Env type:

```ts
type Env = { Variables: { actor: Actor; leaseToken?: string } };
```

In the auth middleware, after `c.set("actor", actor);`, extract the header:

```ts
    const lease = c.req.header("x-switchyard-lease");
    if (lease) c.set("leaseToken", lease);
```

- [ ] **Step 4: Thread it through the three routes**

PATCH `/issues/:ref` — surface a minted token on auto-claim:

```ts
  app.patch("/issues/:ref", body(issueUpdateBody), (c) => {
    const minted: { token: string | null } = { token: null };
    const issue = updateIssue(db, c.var.actor, c.req.param("ref"), c.req.valid("json"), {
      presented: c.var.leaseToken,
      minted,
    });
    return c.json(minted.token ? { ...issue, leaseToken: minted.token } : issue);
  });
```

POST `/issues/:ref/claim`:

```ts
  app.post("/issues/:ref/claim", (c) => {
    const { issue, leaseToken } = claimIssue(db, c.var.actor, c.req.param("ref"));
    return c.json({ ...issue, leaseToken });
  });
```

POST `/issues/:ref/request-input`:

```ts
  app.post("/issues/:ref/request-input", body(requestInputBody), (c) =>
    c.json(
      requestHumanInput(db, c.var.actor, c.req.param("ref"), c.req.valid("json").question, c.var.leaseToken),
    ),
  );
```

> Takeover on REST is deferred to Layer B (the claim body gets no `takeover` field in Layer A). MCP `claim_issue` **does** expose `takeover` in Layer A (Task 8) — that is the recovery path for an interactive session that lost its token to compaction. Add a Task 8 test asserting a bare same-actor MCP re-claim errors with `/takeover/i` and `{ takeover: true }` succeeds with a fresh `lease_token`.

- [ ] **Step 5: Run the test + regression + typecheck + commit**

Run: `npm run typecheck` then `npx vitest run tests/rest/`
```bash
git add src/rest/api-routes.ts tests/rest/lease-header.test.ts
git commit -m "feat: REST X-Switchyard-Lease header + claim returns lease (SYD-210)"
```

---

## Task 10: Hard-cutover backfill — `ensureClaimLeaseCutover`

**Files:**
- Create: `src/services/lease-cutover.ts`
- Modify: `src/server.ts:130-139` (run at startup next to `ensureRolloutBackfill`)
- Test: `tests/services/lease-cutover.test.ts`

**Interfaces:**
- Consumes: `claimLeaseCutover` marker (Task 1), `issues`, `recordEvent`.
- Produces: `ensureClaimLeaseCutover(db: Db): { released: number; alreadyDone: boolean }` — once-only (marker-guarded): releases every `in_progress` claim (status→todo, assignee→null) recording `claim_released {reason:"lease_cutover"}` attributed to `assigneeId ?? creatorId`.

- [ ] **Step 1: Write the failing test**

Create `tests/services/lease-cutover.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue, getIssue } from "../../src/services/issues.js";
import { ensureClaimLeaseCutover } from "../../src/services/lease-cutover.js";
import { listIssueEvents } from "../../src/services/events.js";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "AIPI", name: "aipi" });
});

describe("ensureClaimLeaseCutover", () => {
  it("releases every in_progress claim once, with claim_released{lease_cutover}", () => {
    createIssue(db, human, { projectKey: "AIPI", title: "a" });
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    claimIssue(db, agent, "AIPI-1");
    createIssue(db, human, { projectKey: "AIPI", title: "b" }); // stays backlog
    const id1 = getIssue(db, "AIPI-1").id;

    const first = ensureClaimLeaseCutover(db);
    expect(first).toEqual({ released: 1, alreadyDone: false });
    const after = getIssue(db, "AIPI-1");
    expect(after.status).toBe("todo");
    expect(after.assigneeId).toBeNull();
    const last = listIssueEvents(db, id1).at(-1)!;
    expect(last.type).toBe("claim_released");
    expect(last.payload).toMatchObject({ reason: "lease_cutover" });

    // once-only
    expect(ensureClaimLeaseCutover(db)).toEqual({ released: 0, alreadyDone: true });
  });

  it("fires no events for non-in_progress issues", () => {
    createIssue(db, human, { projectKey: "AIPI", title: "a" });
    updateIssue(db, human, "AIPI-1", { status: "todo" });
    const id = getIssue(db, "AIPI-1").id;
    const before = listIssueEvents(db, id).length;
    expect(ensureClaimLeaseCutover(db).released).toBe(0);
    expect(listIssueEvents(db, id).length).toBe(before);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/services/lease-cutover.test.ts`
Expected: FAIL — `lease-cutover.js` missing.

- [ ] **Step 3: Create `src/services/lease-cutover.ts`**

Model on `ensureRolloutBackfill` (marker-guarded one-time transaction):

```ts
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { claimLeaseCutover, issues } from "../db/schema.js";
import { recordEvent } from "./events.js";

/**
 * One-time SYD-210 hard-cutover backfill: the enforcing deploy makes a valid
 * lease required on every claim-scoped mutation, but pre-existing in_progress
 * claims have no lease token any running session can present. An honest reset
 * releases every in-flight claim (status->todo, assignee->null,
 * claim_released{reason:"lease_cutover"}) so it can be cleanly re-claimed
 * through the new mint path. Guarded by the claim_lease_cutover marker so it is
 * once-only across restarts. Blast radius is low: the worker launchd services
 * are down at cutover, so the only live claim is the interactive session
 * running this work, which simply re-claims.
 */
export function ensureClaimLeaseCutover(db: Db): { released: number; alreadyDone: boolean } {
  return db.transaction((tx) => {
    const marker = tx.select().from(claimLeaseCutover).get();
    if (marker) return { released: 0, alreadyDone: true };
    const inProgress = tx.select().from(issues).where(eq(issues.status, "in_progress")).all();
    for (const issue of inProgress) {
      const actorId = issue.assigneeId ?? issue.creatorId;
      tx.update(issues)
        .set({ status: "todo", assigneeId: null, updatedAt: sql`(unixepoch())` })
        .where(eq(issues.id, issue.id))
        .run();
      recordEvent(tx, {
        issueId: issue.id,
        actorId,
        type: "claim_released",
        payload: { reason: "lease_cutover" },
      });
    }
    tx.insert(claimLeaseCutover).values({ id: 1 }).run();
    return { released: inProgress.length, alreadyDone: false };
  });
}
```

- [ ] **Step 4: Wire it into startup**

In `src/server.ts`'s entrypoint block, next to the `ensureRolloutBackfill` call (after it):

```ts
  const { ensureClaimLeaseCutover } = await import("./services/lease-cutover.js");
  const cutover = ensureClaimLeaseCutover(db);
  if (!cutover.alreadyDone)
    console.log(`claim-lease cutover: released ${cutover.released} in-flight claim(s)`);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/services/lease-cutover.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/services/lease-cutover.ts src/server.ts tests/services/lease-cutover.test.ts
git commit -m "feat: hard-cutover backfill releases lease-less claims at startup (SYD-210)"
```

---

## Task 11: No-serialization guard test

**Files:**
- Test: `tests/services/lease-no-serialization.test.ts`

**Interfaces:**
- Consumes: `claimIssue`, `getActivity`, `getIssue`, `searchIssues`, `listAgentSessions`.

- [ ] **Step 1: Write the test (this is the regression fence; it should pass immediately)**

Create `tests/services/lease-no-serialization.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue, getIssue } from "../../src/services/issues.js";
import { getActivity } from "../../src/services/comments.js";
import { searchIssues } from "../../src/services/search.js";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "AIPI", name: "aipi" });
  createIssue(db, human, { projectKey: "AIPI", title: "t" });
  updateIssue(db, human, "AIPI-1", { status: "todo" });
});

describe("lease token never appears in serialized state", () => {
  it("is absent from the issue view, activity events, and search results", () => {
    const { leaseToken } = claimIssue(db, agent, "AIPI-1");
    const hay = JSON.stringify({
      issue: getIssue(db, "AIPI-1"),
      activity: getActivity(db, "AIPI-1"),
      search: searchIssues(db, { projectKey: "AIPI" }),
    });
    expect(hay).not.toContain(leaseToken);
    // not even the hash leaks into issue/event state
    expect(hay).not.toMatch(/token_?[Hh]ash/);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/services/lease-no-serialization.test.ts`
Expected: PASS. If it fails, the token/hash is leaking into a serialized view — fix the leak before proceeding (do not weaken the test).

- [ ] **Step 3: Commit**

```bash
git add tests/services/lease-no-serialization.test.ts
git commit -m "test: lease token never serialized into issue/event/search state (SYD-210)"
```

---

## Task 12: Full-suite gate + integration sweep

**Files:** none (verification only).

- [ ] **Step 1: Typecheck both tsconfigs**

Run: `npm run typecheck`
Expected: PASS (app + ui).

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: All pass EXCEPT the pre-existing `tests/integration/spa-fallback` failures (they need `dist/ui`; run `npm run build:ui` once if you want them green). Compare the pass count against the ~1388 baseline; any NEW failure beyond spa-fallback must be fixed. Pay attention to integration tests (`tests/integration/core-loop`, `rest-loop`) that drive claim→work→release — they may need lease tokens threaded; fix them to reflect the new enforcement (this is intended behavior change, not test-weakening).

- [ ] **Step 3: Update codemaps if structure changed**

The new `leases.ts`/`lease-cutover.ts` services and `claim_leases` table are structural. Run `/update-codemaps` (or note it for the PR) so `codemaps/backend.md`/`data.md` reflect them. (Optional if the reviewer prefers a follow-up.)

- [ ] **Step 4: No commit** — this is a gate. Proceed to push + PR (see Handoff).

---

## Self-Review (author's pass against the spec)

**Spec coverage:**
- §1 schema `claim_leases` → Task 1. ✓ (`invalidated_at` retained-for-audit, `last_beat_at` present for Layer B, unique `token_hash`, `issue_id` index.)
- §2 `leases.ts` mint/validate/invalidate/heartbeat/expire → mint/validate/invalidate/expire in Tasks 2-3. **heartbeat is Layer B** (documented below). ✓ (expiry reuses the `stale-claims.ts:47-58` re-assert pattern.)
- §3 threading + adapters (MCP `lease_token` field, REST `X-Switchyard-Lease`) → Tasks 4-6 (service), 8-9 (adapters). ✓ Exempt surfaces (`comment`/`progress_note`/`attach_file`/`list_agent_sessions`) untouched → verified in Task 8. ✓
- §4 opt-in takeover + three termination paths (expiry/takeover/human-answer) → Tasks 3 (expiry), 5 (takeover), 7 (human-answer). ✓
- §5 liveness/heartbeats → **Layer B** (documented below); `claims.lease_ttl_seconds` default 8h lands in Task 2. ✓
- §6 hard-cutover migration → Task 10. ✓
- §7 tests → lifecycle (Task 2), expiry+race (Task 3), shared-token hole (Tasks 4, 8), takeover (Task 5), exempt surfaces (Task 8), human-answer (Task 7), no-serialization (Task 11), cutover (Task 10). ✓ Heartbeat tests → Layer B.

**Type consistency:** `LeaseChannel = { presented?; minted?: { token: string | null } }` used identically in Tasks 4/8/9. `ClaimResult = { issue: IssueView; leaseToken: string }` from `claimIssue` consumed in Tasks 5/8/9. `getActiveLease`/`mintLease`/`validateLease`/`invalidateLease`/`expireLeases` signatures fixed in Tasks 2-3 and consumed unchanged thereafter. `invalidateLease(tx, issueId)` — no reason param (design's `reason` rides the event) — used consistently in Tasks 3/5/7.

**Placeholder scan:** none — every code step shows the code. The two forward-dependency seams (Task 3's test needing Task 5's `claimIssue` return; Task 5 fixing adapter call sites finalized in Tasks 8-9) are called out explicitly with the stand-in to use.

---

## Layer B — honest liveness (heartbeats)

Layer B replaces the residual idle-guess with honest liveness: a supervising worker heartbeats its container's lease, and a lease that stops being heartbeated expires in ~10 min instead of waiting out the 8h TTL. It couples a tracker deploy with a worker-host upgrade (design §6 deploy-coordination note), so the enforcing deploy from Layer A should land together with the Layer B worker-host upgrade (or with the worker host down, which it currently is).

### Locked design decisions

1. **A heartbeat renewal SHORTENS the window.** `claimIssue` mints with `claims.lease_ttl_seconds` (8h) — the interactive fallback, since a fresh claim doesn't know whether it's a container or an interactive session. `heartbeatLease` renews `expires_at = now + claims.heartbeat_window_seconds` (**default 600s = N×interval**). So the *first* heartbeat from a container collapses its effective window from 8h to ~10 min; a container that keeps beating stays alive indefinitely, a dead one loses its lease within one window. An interactive session never heartbeats, so it keeps the long 8h TTL and recovers via takeover after compaction. This is the whole point — heartbeat = short honest window, no heartbeat = long TTL.
2. **New setting `claims.heartbeat_window_seconds`** (default 600). Both `heartbeatLease`'s renewal and the server-uptime grace period read it, so they can never drift.
3. **Server-uptime expiry gate.** A tracker redeploy is a *correlated* outage: every container's heartbeats fail at once during the ~5–15 s restart. To stop the first post-restart sweep from mass-expiring every live lease, `expireLeases` skips the entire sweep until the server has been continuously up for one full `heartbeat_window_seconds` — giving every live container a full window to re-establish its heartbeat before any expiry can fire. Process start time is captured once at server boot and threaded into the sweep.
4. **Host-side loop (B3).** The supervising `agent-worker`/SDK process heartbeats on the container's behalf every **60 s**; after **N = 10** consecutive failures (~10 min) it fires a cancellation signal and terminates its own workload rather than racing a re-dispatch. The lease token is injected host-side (env → SDK → tool arg), **never** written into the LLM transcript.

### Task B1 — `claims.heartbeat_window_seconds` + `heartbeatLease`

**Files:** `src/services/settings.ts` (registry), `src/services/leases.ts`, `tests/services/lease-heartbeat.test.ts`

- `heartbeatLease(db, issueId, actorId, token): ClaimLease` — `validateLease` first, then renew `last_beat_at = now` and `expires_at = now + getSetting(db, "claims.heartbeat_window_seconds")`; return the updated row.
- Tests: a renewal moves `expires_at` to `now + window` (shorter than the 8h mint) and updates `last_beat_at`; a wrong/absent/expired/non-holder token is rejected (reuses `validateLease`).

### Task B2 — `heartbeat` surface on both adapters

**Files:** `src/mcp/server.ts`, `src/rest/api-routes.ts`, `tests/mcp/lease-tools.test.ts` (extend), `tests/rest/lease-header.test.ts` (extend)

- MCP: new `heartbeat` tool `{ ref, lease_token }` → `heartbeatLease(db, actor, ...)`; returns `{ ok: true, expires_at }`. Description: "Keep your claim's lease alive — the host worker calls this on a timer; the LLM should not."
- REST: `POST /issues/:ref/heartbeat` reading `c.var.leaseToken` (the `X-Switchyard-Lease` header); returns `{ ok: true, expiresAt }`.
- Tests: the holder heartbeats and `expires_at` moves out; a no-token / stale-token / non-holder call is rejected.

### Task B3 — host-side heartbeat loop + cancellation

**Files:** `scripts/agent-worker.ts`, `worker-sdk/` (the SDK runner), plus a doctor/self-test touch if warranted

- On dispatch, the host receives the lease token from `claim_issue` (already returned in Layer A) and holds it out-of-band (env/file handoff — never argv, never transcript).
- A self-rescheduling 60 s loop calls `POST /issues/<ref>/heartbeat` with the `X-Switchyard-Lease` header. Count consecutive failures; at **10** (~10 min) fire the existing cancellation/kill path for that workload and stop the loop.
- This is deploy-coupled host code and largely integration-shaped; unit-test the failure-counter/cancellation decision as a pure function where practical, and `log()` what was skipped. Full exercise happens on the worker host at go-live (gated on SYD-213).

### Task B4 — server-uptime expiry gate

**Files:** `src/services/leases.ts` (`expireLeases` signature), `src/services/webhook-dispatcher.ts` (capture + thread process start), `tests/services/lease-expiry.test.ts` (extend)

- `expireLeases(db, now?, serverStartedAt?)`: when `serverStartedAt` is given and `now - serverStartedAt < getSetting(db, "claims.heartbeat_window_seconds")`, return 0 (skip the whole sweep). Otherwise behave as today.
- `startWebhookDispatcher` captures a process-start timestamp once and passes it on every `expireLeases` call.
- Tests: within the grace window after a simulated restart, an already-expired lease is NOT swept; past the grace window it is. (Threads an explicit `serverStartedAt`/`now` — no reliance on wall-clock.)

### B5 — interactive TTL

Already covered by `claims.lease_ttl_seconds` (8h) from Layer A; a session that loses its token to compaction re-acquires via opt-in takeover (Task 5). No new code — the interactive path is confirmed by the existing Layer A tests.

`claims.deviation_seconds` (the "claimed but idle" attention chip, 1h) is unchanged — it powers a chip, not release.

---

## Execution Handoff

After the plan is approved: implement Layer A task-by-task with **superpowers:test-driven-development** (RED → GREEN → refactor per unit), running `npm run typecheck` + the affected `npx vitest run` in-transcript before each commit (subagent-commits discipline). Then the full-suite gate (Task 12), push with an explicit refspec `git push origin HEAD:feat/syd-210-claim-leases`, open a PR, and move SYD-210 to `in_review` with a what/how-verified comment for a human stamp.
