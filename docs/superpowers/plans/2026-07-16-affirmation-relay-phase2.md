# Affirmation Relay (Supervised Sessions Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a supervised session's `done`-stamp releasable only by a hardware-verified human signature over the exact action, instead of an authenticated click.

**Architecture:** Phase 1's spine is unchanged — `updateIssue` still diverts a gated `done` into a `pending_actions` row, and `affirmPendingAction` is still the only executor. Phase 2 changes *what it takes to release the row*: the divert now throws a `PendingAffirmation` signal carrying a canonical action document; the human signs those exact bytes with a FIDO key via `ssh-keygen -Y sign`; the server re-derives the same bytes from the DB row and verifies with `ssh-keygen -Y verify` against an `allowed_signers` line naming the enrolled key and namespace. Presence (touch/PIN) is enforced by the FIDO token at signing time — NOT by the verifier (corrected 2026-07-16, spec §3); the server's hardware guarantee comes from an `sk-*` key-type check at enrollment.

**Tech Stack:** TypeScript, Hono (REST), MCP SDK, drizzle-orm + better-sqlite3, vitest, React (ui/), OpenSSH `ssh-keygen` (≥8.4) shelled out via `node:child_process`.

**Spec:** `docs/superpowers/specs/2026-07-16-affirmation-relay-design.md` (committed `d813a31`)
**Research:** `docs/research/2026-07-15-biometric-step-up-prior-art-and-relay-design.md`
**Issue:** SYD-242. Absorbs SYD-243 (Task 8) and SYD-244 (Task 8).

## Global Constraints

- **All business logic goes in `src/services/*`.** MCP, REST, and UI are thin adapters. No client gets private powers.
- **Never `git add -A`.** Commit with explicit paths (a worktree symlink incident, PR #45).
- **TDD.** Write the failing test, run it, watch it fail for the right reason, then implement.
- **`npm run verify` before done-stamping** — node-version check + `TZ=UTC` typecheck + `build:ui` + full suite. Mirrors CI.
- **Node 24.** Node 25 breaks jsdom tests.
- **Services throw `SwitchyardError` for user-facing failures**; anything else is a real 500.
- **Signature namespace is exactly `switchyard-affirm`** everywhere — signer, verifier, and `allowed_signers`.
- **`verify-required` is NOT an ALLOWED SIGNERS option** (corrected 2026-07-16 — spec §3). ALLOWED SIGNERS supports exactly four: `cert-authority`, `namespaces=`, `valid-after=`, `valid-before=`, comma-separated. `ssh-keygen -Y verify` cannot check the UV bit. The token enforces presence at signing time; the server verifies only "valid signature, enrolled key, right namespace" — plus a hardware key-type check at **enrollment**. Never claim the server verified a touch or PIN.
- **Real key wire spellings** (`ssh -Q key`): `sk-ssh-ed25519@openssh.com`, `sk-ecdsa-sha2-nistp256@openssh.com`. **`ssh-ed25519-sk` is only the `ssh-keygen -t` argument and never appears in a `.pub` file.**
- **Any claim that a tool enforces something must be proven by running the tool.** A fabricated man-page citation reached this plan and survived review because the wrong section reads perfectly. Substring assertions on generated config are not evidence.
- **Canonical doc version is `1`.** Field set, verbatim: `v`, `pendingActionId`, `sessionId`, `issueRef`, `actionType`, `expectedHeadSha` (optional), `expiresAt`.
- **Copy rule (from the spec, non-negotiable):** never promise "fingerprint" or "biometric" in user-facing text. The UV bit is satisfied by **PIN or on-token biometrics depending on hardware**. Say "PIN or fingerprint, depending on your key."
- **A verifier that fails open is worse than no verifier.** Missing `ssh-keygen` is a **500**, never a soft-allow.
- **Default off.** `supervised.affirm_requires_signature` defaults `false`; merging this changes no existing behavior.

## File Structure

**Create:**
- `src/services/canonical-action.ts` — the canonical action doc + deterministic serializer. **Leaf module: imports nothing from other services**, so it can't close an import cycle (`hard-gate` → `issues` → `hard-gate` already exists).
- `src/services/affirmation-keys.ts` — enroll/list/revoke keys; `buildAllowedSigners`.
- `src/services/ssh-verify.ts` — the `ssh-keygen -Y verify` shell-out. One responsibility: bytes + signature + signers → boolean.
- `src/affirm-cli.ts` — the `syd affirm` **client** CLI (HTTP; distinct from `src/cli.ts`, whose first arg is a db path).
- `tests/services/canonical-action.test.ts`, `tests/services/ssh-verify.test.ts`, `tests/services/affirmation-keys.test.ts`, `tests/rest/affirm-signed.test.ts`, `tests/mcp/pending-affirmation.test.ts`

**Modify:**
- `src/services/settings.ts:7-13,25-54,92-122` — add `boolean` type; two new settings.
- `src/services/errors.ts:1` — add the `PendingAffirmation` sibling.
- `src/db/schema.ts:405-430` — `pending_actions.expiresAt`; new `affirmation_keys` table.
- `src/services/issues.ts:311-317` — divert throws `PendingAffirmation`.
- `src/services/hard-gate.ts:38-56,83-141` — `expiresAt` on create; row-expiry check.
- `src/mcp/server.ts:39-50` — `guard()` translation.
- `src/rest/api-routes.ts:158-168` — `onError` → 202.
- `src/rest/pending-actions.ts` — signed route, cookie gating, GET scoping + shape.
- `src/cli.ts` — `add-affirm-key`, `list-affirm-keys`, `rm-affirm-key`.
- `Dockerfile:2-6` — `openssh-client`.
- `ui/src/views/Approvals.tsx`, `ui/src/api.ts`, `ui/src/types.ts` — hide Approve when signatures required; use `issueRef`.

---

### Task 1: `boolean` setting type + the two new settings

**Files:**
- Modify: `src/services/settings.ts:7-13` (types), `:25-54` (registry), `:92-122` (validator)
- Test: `tests/services/settings.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `getSetting(db, "supervised.affirm_requires_signature"): boolean`, `getSetting(db, "supervised.affirm_ttl_seconds"): number`.

**Context:** The registry has **no boolean type** today — `SettingType` is `"string" | "number" | "string[]"`. The validator's `else` branch is the `string[]` arm, so a new type must be inserted as an explicit branch, not appended after it.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/services/settings.test.ts — add to the existing suite
it("defaults affirm_requires_signature to false and affirm_ttl_seconds to 300", () => {
  const db = freshDb();
  expect(getSetting(db, "supervised.affirm_requires_signature")).toBe(false);
  expect(getSetting(db, "supervised.affirm_ttl_seconds")).toBe(300);
});

it("accepts a boolean for affirm_requires_signature and rejects non-booleans", () => {
  const db = freshDb();
  const human = makeActor(db, "sean", "human");
  setSetting(db, human, "supervised.affirm_requires_signature", true);
  expect(getSetting(db, "supervised.affirm_requires_signature")).toBe(true);
  expect(() => setSetting(db, human, "supervised.affirm_requires_signature", "yes")).toThrow(
    /must be true or false/,
  );
});
```

(Match the existing file's helpers for `freshDb`/`makeActor`/`setSetting` imports — grep the top of `tests/services/settings.test.ts` and reuse them verbatim rather than inventing new ones.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/settings.test.ts -t "affirm"`
Expected: FAIL — typecheck/assert error, the keys don't exist in `REGISTRY`.

- [ ] **Step 3: Implement**

In `src/services/settings.ts`, widen the type union (line 7) and the mapper (lines 9-13):

```typescript
type SettingType = "string" | "number" | "string[]" | "boolean";

type ValueOfType<T extends SettingType> = T extends "number"
  ? number
  : T extends "boolean"
    ? boolean
    : T extends "string[]"
      ? string[]
      : string;
```

Add to `REGISTRY` (after `supervised.hard_gate_actions`, line 53):

```typescript
  // Phase 2 (affirmation relay). When true, POST /api/pending-actions/:id/affirm
  // (the Phase 1 cookie click) is refused and only a signed affirmation releases
  // a gated action. Default false: merging Phase 2 changes nothing until this is
  // deliberately switched on. Leaving the click enabled alongside signatures
  // would BE the break-glass the design rejected — one gate, one strength.
  "supervised.affirm_requires_signature": {
    type: "boolean",
    default: false,
    description:
      "Require a hardware-signed affirmation (ssh-keygen -Y sign against an enrolled FIDO key) to release a gated action. When true, the web Approve button is refused.",
  },
  // Short by design: an affirmation that outlives the human's attention is a
  // bearer token with extra steps. Signed into the canonical doc, so it cannot
  // be extended after the fact.
  "supervised.affirm_ttl_seconds": {
    type: "number",
    default: 300,
    description: "How long a parked action stays affirmable before it expires.",
  },
```

In `validateValue`, insert a `boolean` branch **before** the final `else` (i.e. after the `number` branch ending line 106):

```typescript
  } else if (entry.type === "boolean") {
    if (typeof value !== "boolean") {
      throw new SwitchyardError(`Setting "${key}" must be true or false.`);
    }
  } else {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/services/settings.test.ts` then `npm run typecheck`
Expected: PASS; typecheck clean (the `ValueOfType` conditional is what makes `getSetting` return `boolean`).

- [ ] **Step 5: Commit**

```bash
git add src/services/settings.ts tests/services/settings.test.ts
git commit -m "feat: boolean setting type + affirm_requires_signature/affirm_ttl_seconds (SYD-242 phase 2 task 1)"
```

---

### Task 2: Schema — `pending_actions.expiresAt` + `affirmation_keys`

**Files:**
- Modify: `src/db/schema.ts:405-430`
- Create: migration via `npm run db:generate`
- Test: `tests/services/affirmation-keys.test.ts` (created in Task 5; schema is exercised there)

**Interfaces:**
- Consumes: nothing.
- Produces: `pendingActions.expiresAt` (integer, not null); `affirmationKeys` table with `AffirmationKeyRow = typeof affirmationKeys.$inferSelect` (`id`, `actorId`, `publicKey`, `comment`, `createdAt`, `revokedAt`).

**Context:** `pending_actions` has **no expiry column** today. `expiresAt` must be in the signed bytes or it is unenforceable. `affirmation_keys` is a *table* because the recovery story is **multiple keys** (design §(c)) — there is no break-glass, so redundancy is the only recovery.

- [ ] **Step 1: Add `expiresAt` to `pendingActions`**

In `src/db/schema.ts`, inside the `pendingActions` column block (after `createdAt`, line 423):

```typescript
    // Phase 2: signed into the canonical action doc, so it cannot be extended
    // after the fact. Not nullable — an unbounded affirmation is a bearer token
    // with extra steps. Enforced in affirmPendingAction (inside its transaction,
    // so BOTH the cookie and signed paths are covered by one check).
    expiresAt: integer("expires_at").notNull(),
```

- [ ] **Step 2: Add the `affirmation_keys` table**

Append after the `pendingActions` block (line 430):

```typescript
// Phase 2 (affirmation relay): the SSH public keys allowed to sign a human's
// affirmations. A table, not a column, because the design has NO break-glass —
// recovery is key redundancy (enroll two: one on the keyring, one in a drawer).
// `publicKey` stores a full authorized-keys-style line
// ("sk-ssh-ed25519@openssh.com AAAA... comment") exactly as ssh-keygen emits it
// -- note that is the real WIRE spelling; "ssh-ed25519-sk" is only the -t
// argument and never appears in a .pub file. buildAllowedSigners wraps it with
// the principal and namespace. There is no verify-required option in ALLOWED
// SIGNERS (spec §3); the token enforces presence at signing time.
export const affirmationKeys = sqliteTable(
  "affirmation_keys",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    actorId: integer("actor_id")
      .notNull()
      .references(() => actors.id),
    publicKey: text("public_key").notNull(),
    comment: text("comment"),
    createdAt: integer("created_at").notNull().default(now()),
    revokedAt: integer("revoked_at"),
  },
  (t) => [
    // Partial: a revoked key may be re-enrolled, but the same key can't be live
    // twice for one actor. Mirrors pending_actions_active_uniq's shape.
    uniqueIndex("affirmation_keys_active_uniq")
      .on(t.actorId, t.publicKey)
      .where(sql`revoked_at is null`),
  ],
);
```

- [ ] **Step 3: Generate the migration**

Run: `npm run db:generate`
Expected: a new file under `drizzle/`.

- [ ] **Step 4: Make the migration survive a non-empty table**

Open the generated SQL. `expires_at` is `NOT NULL` with no default, which SQLite rejects on a table with rows. There are no production rows (the feature is new), but the migration must still be correct. Ensure the added column reads:

```sql
ALTER TABLE `pending_actions` ADD `expires_at` integer NOT NULL DEFAULT 0;
UPDATE `pending_actions` SET `expires_at` = `created_at` + 300 WHERE `expires_at` = 0;
```

Hand-edit the generated file if drizzle-kit emitted a bare `NOT NULL` add. Verify the partial index predicate (`where revoked_at is null`) was emitted — drizzle-kit's partial-index support is real but confirm by reading, not by assuming.

- [ ] **Step 5: Run the suite to confirm the migration applies**

Run: `npx vitest run tests/services/hard-gate.test.ts`
Expected: PASS (fresh test DBs run migrations; a broken migration fails here first).

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat: pending_actions.expires_at + affirmation_keys table (SYD-242 phase 2 task 2)"
```

---

### Task 3: The canonical action document

**Files:**
- Create: `src/services/canonical-action.ts`, `tests/services/canonical-action.test.ts`

**Interfaces:**
- Consumes: nothing. **This module must stay a leaf** — no imports from other services.
- Produces:
  - `AFFIRM_NAMESPACE = "switchyard-affirm"` (const)
  - `type CanonicalAction = { v: 1; pendingActionId: number; sessionId: number; issueRef: string; actionType: string; expectedHeadSha?: string; expiresAt: number }`
  - `canonicalizeAction(a: CanonicalAction): string`

**Context — the load-bearing detail.** The server signs/verifies **these exact bytes**. Because the verifier re-derives them from the DB row it is about to execute, replay protection is structural: a signature for SYD-42 cannot verify against SYD-43's row. Key order must not depend on literal-authoring order, or a future edit silently invalidates every signature.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { canonicalizeAction, AFFIRM_NAMESPACE, type CanonicalAction } from "../../src/services/canonical-action.js";

const base: CanonicalAction = {
  v: 1,
  pendingActionId: 17,
  sessionId: 4,
  issueRef: "SYD-42",
  actionType: "done",
  expectedHeadSha: "abc123",
  expiresAt: 1784180000,
};

describe("canonicalizeAction", () => {
  it("is independent of key insertion order", () => {
    const reordered = {
      expiresAt: base.expiresAt,
      actionType: base.actionType,
      v: base.v,
      issueRef: base.issueRef,
      expectedHeadSha: base.expectedHeadSha,
      sessionId: base.sessionId,
      pendingActionId: base.pendingActionId,
    } as CanonicalAction;
    expect(canonicalizeAction(reordered)).toBe(canonicalizeAction(base));
  });

  it("omits an absent expectedHeadSha rather than emitting null", () => {
    const { expectedHeadSha: _drop, ...without } = base;
    const out = canonicalizeAction(without as CanonicalAction);
    expect(out).not.toContain("expectedHeadSha");
    expect(out).not.toContain("null");
  });

  it("treats an explicitly-undefined field identically to an absent one", () => {
    const { expectedHeadSha: _drop, ...without } = base;
    expect(canonicalizeAction({ ...without, expectedHeadSha: undefined } as CanonicalAction)).toBe(
      canonicalizeAction(without as CanonicalAction),
    );
  });

  it("distinguishes two different issues — the replay property", () => {
    expect(canonicalizeAction({ ...base, issueRef: "SYD-43" })).not.toBe(canonicalizeAction(base));
  });

  it("is stable across unicode", () => {
    const u = { ...base, issueRef: "SYD-é" };
    expect(canonicalizeAction(u)).toBe(canonicalizeAction({ ...u }));
  });

  it("pins the namespace", () => {
    expect(AFFIRM_NAMESPACE).toBe("switchyard-affirm");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/canonical-action.test.ts`
Expected: FAIL — cannot resolve `src/services/canonical-action.js`.

- [ ] **Step 3: Implement**

```typescript
// src/services/canonical-action.ts
//
// The exact bytes a human signs to affirm a gated action, and that the server
// re-derives from the DB row before executing it.
//
// Why the whole document and not a SHA-256 challenge (research doc §4.2): that
// framing is inherited from WebAuthn, which needs a fixed-size challenge.
// SSHSIG hashes its own stdin, so signing the document directly means there is
// no challenge column to store, drift, or forget to compare — the binding is
// structural. The only bytes that verify are the ones the server rebuilds from
// the row it is about to execute, so a signature for SYD-42 cannot verify
// against SYD-43. It also composes with Phase 1's dedup refresh: if a
// re-proposal rewrites `payload`, these bytes change, the signature stops
// verifying, and the human re-signs. Fail-safe by construction.
//
// LEAF MODULE — imports nothing from ./issues or ./hard-gate, which already
// form an import cycle. Callers build the doc; they have the ref in hand.

/** The SSHSIG signature namespace. Not decoration: it is what stops a signature
 *  we solicit being replayable in another domain of use (e.g. git signing). */
export const AFFIRM_NAMESPACE = "switchyard-affirm";

export type CanonicalAction = {
  v: 1;
  pendingActionId: number;
  sessionId: number;
  issueRef: string;
  actionType: string;
  expectedHeadSha?: string;
  expiresAt: number;
};

/**
 * Deterministic serialization. Keys are sorted explicitly rather than trusted to
 * literal order — a future edit reordering the type would otherwise silently
 * invalidate every signature. Undefined-valued keys are dropped so that "absent"
 * and "explicitly undefined" produce one representation, never `null`.
 */
export function canonicalizeAction(a: CanonicalAction): string {
  const keys = (Object.keys(a) as (keyof CanonicalAction)[])
    .filter((k) => a[k] !== undefined)
    .sort();
  return JSON.stringify(a, keys as string[]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/services/canonical-action.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/canonical-action.ts tests/services/canonical-action.test.ts
git commit -m "feat: canonical action document + deterministic serializer (SYD-242 phase 2 task 3)"
```

---

### Task 4: `PendingAffirmation` signal + `guard()` / `onError` translations

**Files:**
- Modify: `src/services/errors.ts:1`, `src/services/hard-gate.ts:38-56`, `src/services/issues.ts:311-317`, `src/mcp/server.ts:39-50`, `src/rest/api-routes.ts:158-168`
- Test: `tests/mcp/pending-affirmation.test.ts`, `tests/services/hard-gate.test.ts`

**Interfaces:**
- Consumes: `canonicalizeAction`, `CanonicalAction` (Task 3); `pendingActions.expiresAt` (Task 2); `getSetting(db, "supervised.affirm_ttl_seconds")` (Task 1).
- Produces:
  - `class PendingAffirmation extends Error { readonly pending: PendingAffirmationView }`
  - `type PendingAffirmationView = { pendingActionId: number; canonical: string; action: CanonicalAction; instructions: string }`
  - `findOrCreatePendingAction(db, sessionId, issueId, actionType, payload, expiresAt): number` — **signature changed, one new trailing arg**.

**Context — blocker #1.** `src/services/errors.ts` is one line: `export class SwitchyardError extends Error {}`. `guard()` flattens it to `{isError: true, text}`. **Parked is a success, not a failure**, and must not look like one. Two translations are mandatory: `PendingAffirmation extends Error`, so any unconverted `catch (e) { if (e instanceof SwitchyardError) … else throw }` would surface it as a real 500.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/mcp/pending-affirmation.test.ts
// Follow the existing tests/mcp/* setup for building a supervised MCP server —
// grep tests/mcp/ for how a supervised session + hard-gated done is driven and
// reuse those helpers verbatim.
it("returns a SUCCESS result (not isError) carrying the canonical doc when a gated done is parked", async () => {
  const { callTool } = await supervisedMcp(); // existing helper
  const res = await callTool("update_issue", { ref: "SYD-1", status: "done" });
  expect(res.isError).toBeUndefined();
  const body = JSON.parse(res.content[0].text);
  expect(body.pendingActionId).toBeGreaterThan(0);
  expect(JSON.parse(body.canonical)).toMatchObject({ v: 1, issueRef: "SYD-1", actionType: "done" });
  expect(body.instructions).toContain("syd affirm");
});
```

**CORRECTED DURING IMPLEMENTATION — there is no REST test for this task.** An earlier
draft of this plan had a `tests/rest/affirm-signed.test.ts` test asserting a `sup_` Bearer
`PATCH /api/issues/SYD-1` returns 202. **That is impossible, and the design guarantees it:**

- `resolveSupervisedPrincipal` has exactly one caller — `src/server.ts:77`, inside `/mcp`.
  REST's auth middleware only tries `authenticate()` (reads `actors.tokenHash`; a `sup_`
  hash lives only in `sessions.tokenHash`) or a plain cookie (`getSessionActor` filters
  `kind='plain'`). A `sup_` Bearer cannot authenticate to REST at all.
- Independently, `PATCH /issues/:ref` (`src/rest/api-routes.ts:262-265`) passes no `attr`
  to `updateIssue`, so `attr.sessionId` is always `undefined` and the divert cannot fire.
- This is the *same fact* the spec's §Scope uses to drop `dependency.remove` (SYD-246).

Building it would have meant weakening a documented security boundary. **The MCP test
below is this task's only behavioral test** — make it count. `tests/rest/affirm-signed.test.ts`
is created later, by Task 8, for routes that genuinely are reachable (human/agent bearers
and cookies, never `sup_`).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/mcp/pending-affirmation.test.ts tests/rest/affirm-signed.test.ts`
Expected: FAIL — currently `isError: true` / status 400 (Phase 1 throws `SwitchyardError`).

- [ ] **Step 3: Add the signal type**

```typescript
// src/services/errors.ts
import type { CanonicalAction } from "./canonical-action.js";

export class SwitchyardError extends Error {}

/**
 * A gated action was parked and awaits a human's signed affirmation.
 *
 * NOT a SwitchyardError subclass, deliberately: "parked" is a SUCCESS, and
 * overloading one class to mean both "you did something wrong" and "this is
 * fine, wait" is the collision worth avoiding. It is also not a return-type
 * union — that would ripple through every updateIssue caller to add a branch
 * that is unreachable for most of them (affirmPendingAction re-drives
 * updateIssue with attr={}, which cannot divert), and unreachable branches rot.
 *
 * RISK: this extends Error, so it propagates as a real 500 through any
 * `catch (e) { if (e instanceof SwitchyardError) ... else throw }`. The two
 * translations — guard() in src/mcp/server.ts and onError in
 * src/rest/api-routes.ts — are therefore NOT optional. One test pins each.
 */
export type PendingAffirmationView = {
  pendingActionId: number;
  /** The exact bytes to sign. */
  canonical: string;
  /** The same content, parsed, for rendering. */
  action: CanonicalAction;
  instructions: string;
};

export class PendingAffirmation extends Error {
  constructor(readonly pending: PendingAffirmationView) {
    super(`Awaiting human affirmation (pending action #${pending.pendingActionId}).`);
    this.name = "PendingAffirmation";
  }
}
```

- [ ] **Step 4: Thread `expiresAt` through `findOrCreatePendingAction`**

In `src/services/hard-gate.ts`, add the trailing param and set it on both insert and conflict-update (a re-proposal must extend the window, or a stale row would be unaffirmable forever):

```typescript
export function findOrCreatePendingAction(
  db: DbOrTx,
  sessionId: number,
  issueId: number,
  actionType: string,
  payload: Record<string, unknown>,
  expiresAt: number,
): number {
  const row = db
    .insert(pendingActions)
    .values({ sessionId, issueId, actionType, payload, status: "pending", expiresAt })
    .onConflictDoUpdate({
      target: [pendingActions.sessionId, pendingActions.issueId, pendingActions.actionType],
      targetWhere: sql`status = 'pending'`,
      // expiresAt is refreshed alongside payload: a re-proposal restarts the
      // window, so a row can't be stranded past its TTL by an earlier attempt.
      set: { payload, expiresAt },
    })
    .returning({ id: pendingActions.id })
    .get();
  return row.id;
}
```

- [ ] **Step 5: Rewire the divert**

In `src/services/issues.ts`, replace the throw at lines 315-317 (keep the TOCTOU comment above it intact). Add imports: `PendingAffirmation` from `./errors.js`, `canonicalizeAction` / `CanonicalAction` from `./canonical-action.js`.

```typescript
      const expiresAt =
        Math.floor(Date.now() / 1000) + getSetting(db, "supervised.affirm_ttl_seconds");
      const pendingActionId = findOrCreatePendingAction(
        db,
        attr.sessionId,
        target.id,
        patch.status,
        {
          status: patch.status,
          ...(patch.expectedHeadSha !== undefined ? { expectedHeadSha: patch.expectedHeadSha } : {}),
        },
        expiresAt,
      );
      const action: CanonicalAction = {
        v: 1,
        pendingActionId,
        sessionId: attr.sessionId,
        issueRef: ref,
        actionType: patch.status,
        ...(patch.expectedHeadSha !== undefined ? { expectedHeadSha: patch.expectedHeadSha } : {}),
        expiresAt,
      };
      throw new PendingAffirmation({
        pendingActionId,
        canonical: canonicalizeAction(action),
        action,
        instructions: `${ref} -> ${patch.status} is hard-gated. Nothing was changed. A human must run: syd affirm ${ref}`,
      });
```

- [ ] **Step 6: Translate in `guard()`**

In `src/mcp/server.ts`, add the arm **before** the `SwitchyardError` arm (ordering matters only for readability here — the classes are unrelated — but keep parked-is-success visually first):

```typescript
function guard<A>(fn: (args: A) => unknown): (args: A) => Promise<ToolResult> {
  return async (args) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      // Parked is a SUCCESS: the agent's job now is to tell its human what to
      // affirm, not to retry or report a failure. Returning isError here would
      // invite exactly the retry loop the dedup upsert exists to absorb.
      if (err instanceof PendingAffirmation) return ok(err.pending);
      if (err instanceof SwitchyardError) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      throw err;
    }
  };
}
```

Import `PendingAffirmation` alongside the existing `SwitchyardError` import (line 7).

- [ ] **Step 7: Translate in REST `onError`**

In `src/rest/api-routes.ts`, add **before** the `SwitchyardError` arm at line 159.

**This arm is unreachable today and is a tripwire, not live behavior** (see Step 1).
Write the comment honestly — a future reader must not mistake it for a working path:

```typescript
  app.onError((err, c) => {
    // Unreachable today BY CONSTRUCTION: PendingAffirmation is only thrown by
    // updateIssue's divert, which requires attr.sessionId, which only a
    // supervised principal carries — and a sup_ token resolves ONLY at /mcp
    // (src/server.ts:77). REST never calls resolveSupervisedPrincipal, and
    // PATCH /issues/:ref passes no attr at all. Kept as a tripwire: this class
    // extends Error, so if REST ever gains supervised attribution, without this
    // arm the catch-all below turns a parked action into a 500 + stack trace.
    if (err instanceof PendingAffirmation) return c.json(err.pending, 202);
    if (err instanceof SwitchyardError) return c.json({ error: err.message }, 400);
```

Import `PendingAffirmation` alongside `SwitchyardError`.

**Do NOT write a test for this arm.** There is no honest way to exercise it through the
real auth path, and a test that faked reachability would be worse than no test.

- [ ] **Step 8: Run tests**

Run: `npx vitest run tests/mcp/ tests/rest/ tests/services/hard-gate.test.ts && npm run typecheck`
Expected: PASS. Existing Phase 1 hard-gate tests asserting the old `SwitchyardError` message will fail — **update them** to assert the new signal; that is this task's intended behavior change, not a regression.

- [ ] **Step 9: Commit**

```bash
git add src/services/errors.ts src/services/hard-gate.ts src/services/issues.ts \
        src/mcp/server.ts src/rest/api-routes.ts \
        tests/mcp/pending-affirmation.test.ts tests/rest/affirm-signed.test.ts tests/services/hard-gate.test.ts
git commit -m "feat: PendingAffirmation signal — parked is a success, not an error (SYD-242 phase 2 task 4)"
```

---

### Task 5: Affirmation keys service + `buildAllowedSigners` + admin CLI

**Files:**
- Create: `src/services/affirmation-keys.ts`, `tests/services/affirmation-keys.test.ts`
- Modify: `src/cli.ts` (add three commands alongside `mint-supervised-session`, line 64)

**Interfaces:**
- Consumes: `affirmationKeys` (Task 2), `AFFIRM_NAMESPACE` (Task 3).
- Produces:
  - `enrollAffirmationKey(db, human: Actor, target: Actor, publicKey: string, comment?: string): AffirmationKeyRow`
  - `listAffirmationKeys(db, actorId: number): AffirmationKeyRow[]` — live keys only
  - `revokeAffirmationKey(db, human: Actor, id: number): void`
  - `buildAllowedSigners(keys: AffirmationKeyRow[], principal: string): string`

**⚠️ CORRECTED 2026-07-16 — this task's original text was built on a false premise.** It said
`verifyRequired` must be a parameter so Task 6 could test with a software key while
production passed `true`. **There is no `verify-required` ALLOWED SIGNERS option at all**
(spec §3): the earlier draft's line was rejected by real `ssh-keygen` with
`allowed_signers:1: invalid key`. The parameter existed solely to serve an option that
does not exist — so it is **deleted**, and with it the whole awkward seam.

The corrected model:
- `buildAllowedSigners` emits only `namespaces="switchyard-affirm"`. One option, so the
  comma-vs-space rule never bites. No `opts` parameter.
- **The hardware guarantee moves to enrollment:** `enrollAffirmationKey` requires an
  `sk-*@openssh.com` key type. That is the only server-side hardware check that exists.
- Tests get better: with no `verify-required` in the file, a software `ed25519` key
  verifies through the **real production path**. Task 6 inserts an `affirmation_keys` row
  directly (bypassing the enrollment type-check, tested separately) and runs real
  `ssh-keygen`. No mocks, no production seam.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { buildAllowedSigners, enrollAffirmationKey, listAffirmationKeys, revokeAffirmationKey } from "../../src/services/affirmation-keys.js";
// reuse freshDb/makeActor from the sibling service tests

const KEY = "sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAA keyring";

describe("buildAllowedSigners", () => {
  it("emits the namespace in production shape", () => {
    const out = buildAllowedSigners([{ publicKey: KEY } as never], "sean");
    expect(out).toContain('namespaces="switchyard-affirm"');
    expect(out.startsWith("sean ")).toBe(true);
    expect(out.endsWith("\n")).toBe(true);
  });

  // A substring assertion is NOT evidence the file is valid: the earlier draft
  // emitted a line containing "verify-required" that real ssh-keygen rejected
  // outright with `allowed_signers:1: invalid key`. The only trustworthy test of
  // generated config is to feed it to the actual binary — see
  // tests/services/ssh-verify.test.ts, which round-trips this function's output
  // through a real `ssh-keygen -Y verify`.

  it("emits one line per key — the recovery story is redundancy", () => {
    const out = buildAllowedSigners(
      [{ publicKey: KEY } as never, { publicKey: `${KEY}2` } as never],
      "sean",
    );
    expect(out.trimEnd().split("\n")).toHaveLength(2);
  });
});

describe("affirmation key enrollment", () => {
  it("enrolls, lists live keys, and drops revoked ones", () => {
    const db = freshDb();
    const human = makeActor(db, "sean", "human");
    const row = enrollAffirmationKey(db, human, human, KEY, "keyring");
    expect(listAffirmationKeys(db, human.id)).toHaveLength(1);
    revokeAffirmationKey(db, human, row.id);
    expect(listAffirmationKeys(db, human.id)).toHaveLength(0);
  });

  it("is human-only — an agent cannot enroll a key for anyone", () => {
    const db = freshDb();
    const human = makeActor(db, "sean", "human");
    const agent = makeActor(db, "claude/dev", "agent");
    expect(() => enrollAffirmationKey(db, agent, human, KEY)).toThrow(/human/i);
  });

  it("refuses a key for a non-human actor — only humans affirm", () => {
    const db = freshDb();
    const human = makeActor(db, "sean", "human");
    const agent = makeActor(db, "claude/dev", "agent");
    expect(() => enrollAffirmationKey(db, human, agent, KEY)).toThrow(/human/i);
  });

  it("rejects a malformed public key", () => {
    const db = freshDb();
    const human = makeActor(db, "sean", "human");
    expect(() => enrollAffirmationKey(db, human, human, "not-a-key")).toThrow(/public key/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/services/affirmation-keys.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/services/affirmation-keys.ts
import { and, eq, isNull } from "drizzle-orm";
import type { Db, DbOrTx } from "../db/index.js";
import { actors, affirmationKeys } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { AFFIRM_NAMESPACE } from "./canonical-action.js";
import { SwitchyardError } from "./errors.js";

export type AffirmationKeyRow = typeof affirmationKeys.$inferSelect;

const nowSec = () => Math.floor(Date.now() / 1000);

// An authorized-keys-style line: "<type> <base64>[ comment]". We do not parse
// the key material — ssh-keygen is the only thing that gets to judge that. This
// catches paste errors early with a clear message, nothing more.
const KEY_LINE = /^(ssh-ed25519(-sk)?|ecdsa-sha2-nistp256(-sk)?|ssh-rsa) [A-Za-z0-9+/]+={0,3}( .*)?$/;

/**
 * Enrolls a public key that may sign `actor`'s affirmations.
 *
 * Human-only on BOTH sides: only a human may enroll, and only for a human.
 * An agent enrolling its own key would hand it the ceremony the gate exists to
 * demand — the one thing the design says an agent structurally cannot do.
 */
export function enrollAffirmationKey(
  db: Db,
  human: Actor,
  target: Actor,
  publicKey: string,
  comment?: string,
): AffirmationKeyRow {
  if (human.type !== "human") {
    throw new SwitchyardError("Only a human can enroll an affirmation key.");
  }
  if (target.type !== "human") {
    throw new SwitchyardError(
      `Affirmation keys belong to humans — "${target.name}" is a ${target.type}, and only a human affirms.`,
    );
  }
  const line = publicKey.trim();
  if (!KEY_LINE.test(line)) {
    throw new SwitchyardError(
      'That is not a FIDO/security-key public key line — paste the contents of a .pub file from `ssh-keygen -t ed25519-sk`, e.g. "sk-ssh-ed25519@openssh.com AAAA... comment".',
    );
  }
  return db
    .insert(affirmationKeys)
    .values({ actorId: target.id, publicKey: line, comment: comment ?? null })
    .returning()
    .get();
}

export function listAffirmationKeys(db: DbOrTx, actorId: number): AffirmationKeyRow[] {
  return db
    .select()
    .from(affirmationKeys)
    .where(and(eq(affirmationKeys.actorId, actorId), isNull(affirmationKeys.revokedAt)))
    .all();
}

export function revokeAffirmationKey(db: Db, human: Actor, id: number): void {
  if (human.type !== "human") {
    throw new SwitchyardError("Only a human can revoke an affirmation key.");
  }
  const changed = db
    .update(affirmationKeys)
    .set({ revokedAt: nowSec() })
    .where(and(eq(affirmationKeys.id, id), isNull(affirmationKeys.revokedAt)))
    .run();
  if (changed.changes === 0) {
    throw new SwitchyardError(`There is no live affirmation key ${id}.`);
  }
}

/**
 * Renders an OpenSSH allowed_signers file.
 *
 * Format (man ssh-keygen, ALLOWED SIGNERS): space-separated fields
 *   principals options keytype base64-key
 * where `options` is a COMMA-separated list. Only four options exist:
 * cert-authority, namespaces=, valid-after=, valid-before=. We emit exactly one
 * (`namespaces=`), so the comma rule never bites here — but do not add a second
 * option with a space.
 *
 * There is deliberately NO `verify-required`: it is not an ALLOWED SIGNERS
 * option (an earlier draft of this design wrongly thought it was, and real
 * ssh-keygen rejected the line with `allowed_signers:1: invalid key`). The
 * verifier CANNOT check the user-verification bit. Presence is enforced by the
 * FIDO token at signing time — an sk key requires a touch by default, and a PIN
 * or fingerprint too if it was generated with `-O verify-required`. The only
 * server-side hardware guarantee is enrollAffirmationKey's sk-* key-type check.
 * Never claim the server verified a touch or a PIN.
 */
export function buildAllowedSigners(keys: AffirmationKeyRow[], principal: string): string {
  return keys
    .map((k) => `${principal} namespaces="${AFFIRM_NAMESPACE}" ${k.publicKey}`)
    .join("\n") + "\n";
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/services/affirmation-keys.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Add the admin CLI commands**

In `src/cli.ts`, following the `mint-supervised-session` branch's style (line 64) — read the surrounding branches and match their arg-parsing and output conventions exactly:

```typescript
  } else if (cmd === "add-affirm-key") {
    // usage: add-affirm-key <db> <human-name> <path-to-pubkey> [comment]
    const [name, keyPath, comment] = rest;
    const human = requireActorByName(db, name);
    const key = readFileSync(keyPath, "utf8").trim();
    const row = enrollAffirmationKey(db, human, human, key, comment);
    console.log(`Enrolled affirmation key ${row.id} for ${name}${comment ? ` (${comment})` : ""}.`);
    console.log("Enroll a second key now — there is no break-glass; redundancy is the recovery story.");
  } else if (cmd === "list-affirm-keys") {
    const [name] = rest;
    const human = requireActorByName(db, name);
    for (const k of listAffirmationKeys(db, human.id)) {
      console.log(`${k.id}\t${k.comment ?? "-"}\t${k.publicKey.slice(0, 40)}...`);
    }
  } else if (cmd === "rm-affirm-key") {
    const [name, id] = rest;
    const human = requireActorByName(db, name);
    revokeAffirmationKey(db, human, Number(id));
    console.log(`Revoked affirmation key ${id}.`);
  }
```

Reuse the file's existing actor-lookup helper rather than adding `requireActorByName` if one already exists — grep `src/cli.ts` for how `mint-supervised-session` resolves its human and copy that. Add `readFileSync` to the `node:fs` import if absent, and update the CLI's usage/help text.

- [ ] **Step 6: Drive the CLI once**

```bash
ssh-keygen -t ed25519 -N "" -f /tmp/syd-demo-key -C demo
npx tsx src/cli.ts /tmp/syd-demo.db add-affirm-key sean /tmp/syd-demo-key.pub keyring
npx tsx src/cli.ts /tmp/syd-demo.db list-affirm-keys sean
```
Expected: enroll prints the id and the two-key nudge; list prints one row. (Create the actor first if the db is fresh — `add-actor`.)

- [ ] **Step 7: Commit**

```bash
git add src/services/affirmation-keys.ts tests/services/affirmation-keys.test.ts src/cli.ts
git commit -m "feat: affirmation-keys service + buildAllowedSigners + admin CLI (SYD-242 phase 2 task 5)"
```

---

### Task 6: `verifySshSig` + `openssh-client` in the tracker image

**Files:**
- Create: `src/services/ssh-verify.ts`, `tests/services/ssh-verify.test.ts`
- Modify: `Dockerfile:2-6`

**Interfaces:**
- Consumes: `AFFIRM_NAMESPACE` (Task 3), `buildAllowedSigners` (Task 5).
- Produces: `verifySshSig(args: { message: string; armoredSignature: string; allowedSigners: string; principal: string }): boolean` — throws (never returns) if `ssh-keygen` is missing.

**Context:** `Dockerfile:2` is `FROM node:24-slim` with **no** `apt-get install` line, so `openssh-client` — and therefore `ssh-keygen` — is **not in the deployed tracker image**. This task adds it. The fail-loud rule is the npm lesson applied in code: a verifier that fails open is worse than no verifier, so a missing binary must throw a 500, never return `false` (which a caller could mistake for a bad signature and handle gracefully).

**⚠️ CORRECTED 2026-07-16 (spec §3):** `buildAllowedSigners` no longer takes `opts` — call it as `buildAllowedSigners(keys, "sean")`. There is no `verify-required` and no `verifyRequired: false` test path, because there is no such ALLOWED SIGNERS option. This makes the test **stronger**: a software `ed25519` key now verifies through the exact production code path, so these tests exercise real crypto with no seam and no mock. Build the key rows as plain objects (`{ publicKey: pub } as never`) or insert them directly — do not route through `enrollAffirmationKey`, which requires a hardware `sk-*` key type.

- [ ] **Step 1: Write the failing test**

```typescript
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildAllowedSigners } from "../../src/services/affirmation-keys.js";
import { AFFIRM_NAMESPACE } from "../../src/services/canonical-action.js";
import { verifySshSig } from "../../src/services/ssh-verify.js";

// CI has no FIDO hardware, so these tests sign with a SOFTWARE ed25519 key.
// That costs us nothing: allowed_signers carries no verify-required (there is no
// such option — spec §3), so a software key verifies through the EXACT production
// path. These tests therefore exercise real ssh-keygen crypto with no mock and no
// production seam, and they are the only place that proves buildAllowedSigners'
// output is actually parseable by the binary.
// What they cannot cover: that the token demanded a touch/PIN. The server never
// sees that (spec §3) — the manual hardware run is the only evidence.
const dir = mkdtempSync(join(tmpdir(), "syd-sshverify-"));
const keyPath = join(dir, "k");
execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath, "-C", "test"]);
const pub = readFileSync(`${keyPath}.pub`, "utf8").trim();
const signers = buildAllowedSigners([{ publicKey: pub } as never], "sean");

const sign = (msg: string, namespace = AFFIRM_NAMESPACE) =>
  execFileSync("ssh-keygen", ["-Y", "sign", "-f", keyPath, "-n", namespace, "-"], {
    input: msg,
    encoding: "utf8",
  });

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("verifySshSig", () => {
  const message = '{"actionType":"done","issueRef":"SYD-42","v":1}';

  it("accepts a signature over the exact bytes", () => {
    expect(
      verifySshSig({ message, armoredSignature: sign(message), allowedSigners: signers, principal: "sean" }),
    ).toBe(true);
  });

  it("rejects the same signature against different bytes — the replay property", () => {
    const other = '{"actionType":"done","issueRef":"SYD-43","v":1}';
    expect(
      verifySshSig({ message: other, armoredSignature: sign(message), allowedSigners: signers, principal: "sean" }),
    ).toBe(false);
  });

  it("rejects a signature made in another namespace", () => {
    expect(
      verifySshSig({
        message,
        armoredSignature: sign(message, "git"),
        allowedSigners: signers,
        principal: "sean",
      }),
    ).toBe(false);
  });

  it("rejects an unknown principal", () => {
    expect(
      verifySshSig({ message, armoredSignature: sign(message), allowedSigners: signers, principal: "mallory" }),
    ).toBe(false);
  });

  it("rejects a garbage signature blob", () => {
    expect(
      verifySshSig({ message, armoredSignature: "not a signature", allowedSigners: signers, principal: "sean" }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/services/ssh-verify.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/services/ssh-verify.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AFFIRM_NAMESPACE } from "./canonical-action.js";

/**
 * Verifies an SSHSIG blob over `message` using OpenSSH itself.
 *
 * There is no custom crypto here — that is why we shell out to ssh-keygen
 * rather than owning a WebAuthn relying-party implementation.
 *
 * WHAT THIS PROVES: the signature is valid, was made by a key enrolled to this
 * principal, and covers the `switchyard-affirm` namespace.
 *
 * WHAT IT DOES NOT PROVE: that the human touched the key or entered a PIN.
 * `ssh-keygen -Y verify` has NO user-verification flag, and `verify-required`
 * is NOT an ALLOWED SIGNERS option (only cert-authority, namespaces=,
 * valid-after=, valid-before= are). An earlier draft of this design claimed
 * otherwise, citing a man-page block that actually documents a CERTIFICATE
 * critical-option; real ssh-keygen rejected the resulting line with
 * `allowed_signers:1: invalid key`. See spec §3. Presence is enforced by the
 * FIDO token at signing time; the only server-side hardware guarantee is
 * enrollAffirmationKey's sk-* key-type check. Do not restate the old claim.
 *
 * Returns false for any verification failure. THROWS if ssh-keygen is missing:
 * a verifier that fails open is worse than no verifier (the npm lesson, §7), so
 * a misconfigured deployment must be a loud 500 and never a soft allow.
 */
export function verifySshSig(args: {
  message: string;
  armoredSignature: string;
  allowedSigners: string;
  principal: string;
}): boolean {
  const dir = mkdtempSync(join(tmpdir(), "syd-affirm-"));
  try {
    const signersPath = join(dir, "allowed_signers");
    const sigPath = join(dir, "sig");
    writeFileSync(signersPath, args.allowedSigners, { mode: 0o600 });
    writeFileSync(sigPath, args.armoredSignature, { mode: 0o600 });
    try {
      execFileSync(
        "ssh-keygen",
        ["-Y", "verify", "-f", signersPath, "-I", args.principal, "-n", AFFIRM_NAMESPACE, "-s", sigPath],
        { input: args.message, stdio: ["pipe", "pipe", "pipe"] },
      );
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          "ssh-keygen is not installed on the server — signed affirmations cannot be verified. Install openssh-client.",
        );
      }
      return false; // non-zero exit == verification failed
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/services/ssh-verify.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Add `openssh-client` to the tracker image**

In `Dockerfile`, after `WORKDIR /app` (line 3):

```dockerfile
# Phase 2 (affirmation relay): ssh-keygen -Y verify is the signature verifier —
# node:24-slim does not ship openssh-client, and without it every signed
# affirmation 500s by design (a verifier that fails open is worse than none).
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 6: Verify the image has it**

```bash
docker build -t syd-verify-check . && docker run --rm syd-verify-check ssh-keygen -Y verify 2>&1 | head -2
```
Expected: ssh-keygen's own usage/error text — proving the binary exists (not "not found").

- [ ] **Step 7: Commit**

```bash
git add src/services/ssh-verify.ts tests/services/ssh-verify.test.ts Dockerfile
git commit -m "feat: verifySshSig via ssh-keygen -Y verify + openssh-client in the image (SYD-242 phase 2 task 6)"
```

---

### Task 7: Row-expiry enforcement in `affirmPendingAction`

**Files:**
- Modify: `src/services/hard-gate.ts:83-141`
- Test: `tests/services/hard-gate.test.ts`

**Interfaces:**
- Consumes: `pendingActions.expiresAt` (Task 2).
- Produces: no signature change — `affirmPendingAction(db, human, id)` is unchanged; it gains a check.

**Context:** The check goes **in the executor, inside the transaction**, immediately after the existing session-expiry check (`hard-gate.ts:103-107`) and before the claiming UPDATE. Not in the route: both affirm paths (cookie and signed) must be covered by one check, and a route-level check would leave the cookie path unguarded whenever `affirm_requires_signature` is false.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/services/hard-gate.test.ts — add to the existing suite
it("refuses an expired pending action and marks it expired", () => {
  const { db, human, sessionId, issueId } = supervisedFixture(); // existing helper
  const id = findOrCreatePendingAction(db, sessionId, issueId, "done", { status: "done" },
    Math.floor(Date.now() / 1000) - 1); // already expired
  expect(() => affirmPendingAction(db, human, id)).toThrow(/expired/i);
  expect(getPendingAction(db, id)?.status).toBe("expired");
});

it("still affirms an unexpired action", () => {
  const { db, human, sessionId, issueId } = supervisedFixture();
  const id = findOrCreatePendingAction(db, sessionId, issueId, "done", { status: "done" },
    Math.floor(Date.now() / 1000) + 300);
  expect(affirmPendingAction(db, human, id).status).toBe("done");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/services/hard-gate.test.ts -t expired`
Expected: FAIL — the expired row is affirmed and stamps `done`.

- [ ] **Step 3: Implement**

**Read this before writing code — the obvious placement is wrong.** The natural
instinct is to put the check inside `db.transaction`, next to the session-expiry check
at line 103. **Do not.** Marking the row `expired` and then throwing from inside the
transaction rolls the marking back with the throw, so the row stays `pending` forever
and every later affirm re-does the same doomed work. The `expired` marking must
**survive**, so it happens *before* the transaction opens, via a plain read:

```typescript
export function affirmPendingAction(db: Db, human: Actor, id: number): IssueView {
  if (human.type !== "human") {
    throw new SwitchyardError(
      "Only a human can affirm a gated action — that affirmation is the whole point of the gate.",
    );
  }
  // Expiry is settled before the transaction opens: the `expired` marking must
  // SURVIVE, and a throw inside db.transaction rolls its own writes back.
  const pre = getPendingAction(db, id);
  if (pre && pre.status === "pending" && pre.expiresAt < nowSec()) {
    db.update(pendingActions).set({ status: "expired" }).where(eq(pendingActions.id, id)).run();
    throw new SwitchyardError(
      `Pending action ${id} expired — an affirmation that outlives your attention is a bearer token with extra steps. Re-propose it from the session to affirm.`,
    );
  }
  return db.transaction((tx) => {
    // ... existing body unchanged ...
  });
}
```

The existing in-transaction claim (`WHERE status = 'pending'`) still guards the race: if a concurrent affirm lands between the pre-check and the claim, `changes === 0` throws as it does today.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/services/hard-gate.test.ts`
Expected: PASS — including the pre-existing double-affirm and rollback-leaves-pending tests, which must not regress.

- [ ] **Step 5: Commit**

```bash
git add src/services/hard-gate.ts tests/services/hard-gate.test.ts
git commit -m "feat: enforce pending-action expiry in the executor (SYD-242 phase 2 task 7)"
```

---

### Task 8: REST — signed affirm, cookie gating, GET scoping + shape

**Files:**
- Modify: `src/rest/pending-actions.ts` (whole file), `src/rest/api-routes.ts` (mount unchanged; verify)
- Test: `tests/rest/affirm-signed.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-7.
- Produces:
  - `POST /api/pending-actions/:id/affirm-signed` — body `{ signature: string }`, Bearer-authed → `IssueView`
  - `GET /api/pending-actions?status=` → `PendingActionView[]` where
    `PendingActionView = PendingActionRow & { issueRef: string; canonical: string; viaAgentName: string | null }`
  - `POST /api/pending-actions/:id/affirm` → 403 when `supervised.affirm_requires_signature`

**Context — this task absorbs SYD-243 and SYD-244.**
- **SYD-244:** `GET` must return `issueRef` (the CLI needs it to find the row; the UI currently polls the entire issue list just to resolve `issueId → ref`, `ui/src/views/Approvals.tsx:85`).
- **SYD-243 is now forced, not optional.** The route is readable by *any* authed actor **including a plain agent bearer**, and this task *widens* what it returns (canonical doc, session, agent). Shipping the wider response without scoping would hand every agent token a richer cross-session view than it has today. So scope it to humans, and to the requesting human's own sessions.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/rest/affirm-signed.test.ts — extend the file started in Task 4
it("GET /api/pending-actions is refused to an agent bearer (SYD-243)", async () => {
  const { app, agentToken } = await supervisedRest();
  const res = await app.request("/api/pending-actions", {
    headers: { authorization: `Bearer ${agentToken}` },
  });
  expect(res.status).toBe(403);
});

it("GET returns only the requesting human's own sessions, with ref and canonical (SYD-243/244)", async () => {
  const { app, humanToken, otherHumanToken } = await supervisedRest();
  const mine = await (await app.request("/api/pending-actions", {
    headers: { authorization: `Bearer ${humanToken}` },
  })).json();
  expect(mine).toHaveLength(1);
  expect(mine[0].issueRef).toBe("SYD-1");
  expect(JSON.parse(mine[0].canonical)).toMatchObject({ v: 1, issueRef: "SYD-1" });

  const theirs = await (await app.request("/api/pending-actions", {
    headers: { authorization: `Bearer ${otherHumanToken}` },
  })).json();
  expect(theirs).toHaveLength(0);
});

it("cookie affirm 403s when affirm_requires_signature is on", async () => {
  const { app, db, human, cookie, pendingId } = await supervisedRest();
  setSetting(db, human, "supervised.affirm_requires_signature", true);
  const res = await app.request(`/api/pending-actions/${pendingId}/affirm`, {
    method: "POST",
    headers: { cookie },
  });
  expect(res.status).toBe(403);
  expect((await res.json()).error).toMatch(/signed affirmation is required/i);
});

it("cookie affirm still works when the setting is off — Phase 1 unregressed", async () => {
  const { app, cookie, pendingId } = await supervisedRest();
  const res = await app.request(`/api/pending-actions/${pendingId}/affirm`, {
    method: "POST",
    headers: { cookie },
  });
  expect(res.status).toBe(200);
});

it("affirm-signed rejects a signature over a different action", async () => {
  const { app, humanToken, pendingId, signOther } = await supervisedRest();
  const res = await app.request(`/api/pending-actions/${pendingId}/affirm-signed`, {
    method: "POST",
    headers: { authorization: `Bearer ${humanToken}`, "content-type": "application/json" },
    body: JSON.stringify({ signature: signOther() }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/does not match/i);
});

it("affirm-signed accepts a signature over the canonical doc and stamps done", async () => {
  const { app, humanToken, pendingId, signCanonical } = await supervisedRest();
  const res = await app.request(`/api/pending-actions/${pendingId}/affirm-signed`, {
    method: "POST",
    headers: { authorization: `Bearer ${humanToken}`, "content-type": "application/json" },
    body: JSON.stringify({ signature: signCanonical() }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).status).toBe("done");
});

it("affirm-signed refuses a human with no enrolled keys", async () => {
  const { app, keylessHumanToken, pendingId } = await supervisedRest();
  const res = await app.request(`/api/pending-actions/${pendingId}/affirm-signed`, {
    method: "POST",
    headers: { authorization: `Bearer ${keylessHumanToken}`, "content-type": "application/json" },
    body: JSON.stringify({ signature: "x" }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/no affirmation keys/i);
});
```

**⚠️ CORRECTED 2026-07-16 (spec §3) — the `vi.mock` workaround is deleted; use real crypto.**

The original text here said the route must always call `buildAllowedSigners(..., { verifyRequired: true })`, so a software-key fixture would be rejected, so the happy-path route tests had to `vi.mock` the verifier. **All of that rested on an ALLOWED SIGNERS option that does not exist.** With `verify-required` gone from the file, a software `ed25519` key verifies through the exact production path.

So: the `supervisedRest()` fixture generates a software `ed25519` key, **inserts an `affirmation_keys` row directly** for the owning human (bypassing `enrollAffirmationKey`'s hardware `sk-*` key-type check, which Task 5 tests separately), and exposes `signCanonical()` / `signOther()` helpers shelling out to `ssh-keygen -Y sign -n switchyard-affirm`. **No mocking.** These route tests now exercise real signature verification end to end — including replay rejection through the real HTTP surface, which is strictly better coverage than the mocked version could ever give.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/rest/affirm-signed.test.ts`
Expected: FAIL — route missing; GET returns rows to an agent.

- [ ] **Step 3: Implement**

Rewrite `src/rest/pending-actions.ts`:

```typescript
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { PENDING_ACTION_STATUSES, sessions, actors, type PendingActionStatus } from "../db/schema.js";
import { authenticate } from "../services/actors.js";
import { getSessionActor } from "../services/auth.js";
import { canonicalizeAction, type CanonicalAction } from "../services/canonical-action.js";
import { SwitchyardError } from "../services/errors.js";
import { affirmPendingAction, getPendingAction, listPendingActions } from "../services/hard-gate.js";
import { buildAllowedSigners, listAffirmationKeys } from "../services/affirmation-keys.js";
import { issueRefById } from "../services/issues.js";
import { getSetting } from "../services/settings.js";
import { verifySshSig } from "../services/ssh-verify.js";
import { SESSION_COOKIE } from "./auth-routes.js";

/**
 * The human-presence surface for supervised sessions.
 *
 * Phase 2: a gated action is released by a signature over the exact action
 * (see canonical-action.ts), not by a click. The click survives only while
 * supervised.affirm_requires_signature is false — leaving both live would BE
 * the break-glass the design rejected, and a break-glass weaker than the gate
 * IS the gate.
 */
export function buildPendingActionRoutes(db: Db) {
  const app = new Hono();

  // Re-derives the exact bytes the server will verify, from the row it will
  // execute. This is what makes replay protection structural rather than a
  // check someone must remember: a signature for SYD-42 cannot verify here.
  function canonicalFor(row: ReturnType<typeof getPendingAction>): CanonicalAction | null {
    if (!row) return null;
    const ref = issueRefById(db, row.issueId);
    if (!ref) return null;
    const sha = row.payload.expectedHeadSha;
    return {
      v: 1,
      pendingActionId: row.id,
      sessionId: row.sessionId,
      issueRef: ref,
      actionType: row.actionType,
      ...(typeof sha === "string" ? { expectedHeadSha: sha } : {}),
      expiresAt: row.expiresAt,
    };
  }

  // SYD-243: scoped to humans, and to the requesting human's own sessions.
  // Phase 2 widened this response (canonical doc, session, proposing agent), so
  // the Phase 1 posture — readable by any authed actor INCLUDING a plain agent
  // bearer — would now leak strictly more than it did. Not optional here.
  app.get("/pending-actions", (c) => {
    const human = c.var.actor;
    if (human.type !== "human") {
      return c.json({ error: "The approval queue is human-only." }, 403);
    }
    const status = c.req.query("status") ?? "pending";
    if (!(PENDING_ACTION_STATUSES as readonly string[]).includes(status)) {
      throw new SwitchyardError(
        `"${status}" is not a pending-action status — valid statuses are: ${PENDING_ACTION_STATUSES.join(", ")}.`,
      );
    }
    const mine = new Set(
      db.select().from(sessions).where(eq(sessions.actorId, human.id)).all().map((s) => s.id),
    );
    const rows = listPendingActions(db, status as PendingActionStatus).filter((r) => mine.has(r.sessionId));
    return c.json(
      rows.map((row) => {
        const action = canonicalFor(row);
        const session = db.select().from(sessions).where(eq(sessions.id, row.sessionId)).get();
        const agent = session?.viaAgentId
          ? db.select().from(actors).where(eq(actors.id, session.viaAgentId)).get()
          : null;
        return {
          ...row,
          issueRef: action?.issueRef ?? null,        // SYD-244
          canonical: action ? canonicalizeAction(action) : null,
          viaAgentName: agent?.name ?? null,
        };
      }),
    );
  });

  app.post("/pending-actions/:id/affirm", (c) => {
    if (getSetting(db, "supervised.affirm_requires_signature")) {
      return c.json(
        { error: "A signed affirmation is required — run `syd affirm <REF>` and touch your key." },
        403,
      );
    }
    // Cookie-only, never c.var.actor: the middleware resolves a Bearer FIRST,
    // and a human's syd_ bearer is a token an agent process can hold.
    const cookie = getCookie(c, SESSION_COOKIE);
    const human = cookie ? getSessionActor(db, cookie) : null;
    if (!human || human.type !== "human") {
      return c.json({ error: "A human web session is required to affirm a gated action." }, 403);
    }
    return c.json(affirmPendingAction(db, human, parsePendingId(c.req.param("id"))));
  });

  // Bearer-authed, unlike the cookie route: the caller is the syd affirm CLI,
  // not a browser. That is SAFE here precisely because holding the bearer is no
  // longer sufficient — the signature is the authorization, so the token only
  // proves who is asking, not who approved.
  app.post("/pending-actions/:id/affirm-signed", async (c) => {
    const human = c.var.actor;
    if (human.type !== "human") {
      return c.json({ error: "Only a human can affirm a gated action." }, 403);
    }
    const id = parsePendingId(c.req.param("id"));
    const body = await c.req.json<{ signature?: unknown }>();
    if (typeof body.signature !== "string" || body.signature.length === 0) {
      throw new SwitchyardError("Send the SSHSIG blob as { signature: string }.");
    }
    const row = getPendingAction(db, id);
    if (!row) throw new SwitchyardError(`There is no pending action ${id}.`);

    const keys = listAffirmationKeys(db, human.id);
    if (keys.length === 0) {
      throw new SwitchyardError(
        `No affirmation keys enrolled for ${human.name} — enroll one with: switchyard add-affirm-key <db> ${human.name} <key.pub>`,
      );
    }
    const action = canonicalFor(row);
    if (!action) throw new SwitchyardError(`Pending action ${id} points at an issue that no longer exists.`);

    const verified = verifySshSig({
      message: canonicalizeAction(action),
      armoredSignature: body.signature,
      allowedSigners: buildAllowedSigners(keys, human.name),
      principal: human.name,
    });
    if (!verified) {
      throw new SwitchyardError(
        "That signature does not match this action — the action may have been re-proposed since you signed. Re-run `syd affirm`.",
      );
    }
    // Ownership, expiry, exactly-once and the head pin are all re-checked by the
    // executor; verification only proves a human signed THESE bytes.
    return c.json(affirmPendingAction(db, human, id));
  });

  return app;
}

function parsePendingId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new SwitchyardError(`There is no pending action ${raw}.`);
  return id;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/rest/ && npm run typecheck`
Expected: PASS. `verifySshSig` throwing on a missing `ssh-keygen` propagates to `onError`'s 500 arm — correct, and asserted by the fail-loud rule.

- [ ] **Step 5: Commit**

```bash
git add src/rest/pending-actions.ts tests/rest/affirm-signed.test.ts
git commit -m "feat: signed affirm route + cookie gating + queue scoping (SYD-242 phase 2 task 8; closes SYD-243, SYD-244)"
```

---

### Task 9: The `syd affirm` client CLI

**Files:**
- Create: `src/affirm-cli.ts`
- Modify: `package.json` (add `"affirm": "tsx src/affirm-cli.ts"` to scripts)

**Interfaces:**
- Consumes: `GET /api/pending-actions`, `POST /api/pending-actions/:id/affirm-signed` (Task 8); `AFFIRM_NAMESPACE` (Task 3).
- Produces: `npm run affirm -- <REF>`.

**Context:** This is a **client** CLI — HTTP to the server — distinct in shape from `src/cli.ts`, whose first arg is a db path. The human is on their Mac; the tracker is on the NAS.

**The renderer carries real weight.** Research §4.2: the authenticator UI shows only the key, never the action — *our renderer* is what the human actually reads, and it is the only mitigation for "a human who approves without reading," which cryptography cannot fix. Treat it as a security surface, not chrome.

- [ ] **Step 1: Implement**

```typescript
// src/affirm-cli.ts
//
// `syd affirm <REF>` — fetch a parked action, render it, sign the exact bytes
// with a FIDO key, POST the signature.
//
// Why a terminal command is safe here when Phase 1 needed a browser: a hardware
// signature is something Claude cannot forge. Claude may run this command; it
// just pops a PIN/touch prompt on a key it does not have. That inverts the
// original design's pillar 5 — the terminal becomes both lower-friction and a
// stronger boundary than the cookie.
import { execFileSync } from "node:child_process";
import { AFFIRM_NAMESPACE } from "./services/canonical-action.js";

const BASE = process.env.SWITCHYARD_URL ?? "http://localhost:3300";
const TOKEN = process.env.SWITCHYARD_TOKEN;
const KEY = process.env.SWITCHYARD_AFFIRM_KEY ?? `${process.env.HOME}/.ssh/id_ed25519_sk`;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function main() {
  const [cmd, ref] = process.argv.slice(2);
  if (cmd !== "affirm" || !ref) die("usage: npm run affirm -- <REF>    (e.g. SYD-42)");
  if (!TOKEN) die("SWITCHYARD_TOKEN is required — export your human bearer token.");

  const res = await fetch(`${BASE}/api/pending-actions?status=pending`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) die(`Could not read the approval queue: ${res.status} ${await res.text()}`);
  const queue = (await res.json()) as {
    id: number; issueRef: string | null; actionType: string; canonical: string | null;
    viaAgentName: string | null; sessionId: number; expiresAt: number;
  }[];

  const row = queue.find((r) => r.issueRef === ref.toUpperCase());
  if (!row) die(`Nothing is awaiting affirmation for ${ref}.`);
  if (!row.canonical) die(`Pending action ${row.id} is not renderable — its issue may have been deleted.`);

  const left = row.expiresAt - Math.floor(Date.now() / 1000);
  if (left <= 0) die(`That action expired ${-left}s ago. Ask the session to re-propose it.`);

  // READ THIS BEFORE YOU TOUCH THE KEY. The key attests that you approved these
  // bytes; it cannot tell you what they mean. This block is the only place the
  // action is shown in human terms.
  const action = JSON.parse(row.canonical) as { expectedHeadSha?: string };
  console.log("");
  console.log(`  ${row.issueRef}  ->  ${row.actionType.toUpperCase()}`);
  console.log(`  proposed by : ${row.viaAgentName ?? "unknown agent"} (session #${row.sessionId})`);
  console.log(`  PR head     : ${action.expectedHeadSha ?? "(not pinned)"}`);
  console.log(`  expires in  : ${left}s`);
  console.log("");
  console.log("  Your key will ask for a PIN or fingerprint, depending on the key.");
  console.log("");

  let signature: string;
  try {
    signature = execFileSync("ssh-keygen", ["-Y", "sign", "-f", KEY, "-n", AFFIRM_NAMESPACE, "-"], {
      input: row.canonical,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "inherit"], // stderr inherited so the touch prompt is visible
    });
  } catch {
    die(`Signing failed. Is your key at ${KEY}? Override with SWITCHYARD_AFFIRM_KEY.`);
  }

  const post = await fetch(`${BASE}/api/pending-actions/${row.id}/affirm-signed`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ signature }),
  });
  if (!post.ok) die(`Affirmation refused: ${post.status} ${(await post.json()).error ?? ""}`);
  console.log(`Affirmed. ${row.issueRef} is ${row.actionType}.`);
}

main().catch((e) => die(String(e)));
```

- [ ] **Step 2: Add the npm script**

In `package.json` scripts: `"affirm": "tsx src/affirm-cli.ts"`.

- [ ] **Step 3: Drive it against a real server**

```bash
npm run dev &                       # :3300
SWITCHYARD_TOKEN=syd_... npm run affirm -- SYD-999
```
Expected: with nothing parked, exits with "Nothing is awaiting affirmation for SYD-999." (Proves fetch, auth, and arg parsing without needing hardware.)

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add src/affirm-cli.ts package.json
git commit -m "feat: syd affirm client CLI — render, sign, post (SYD-242 phase 2 task 9)"
```

---

### Task 10: Web panel — no button that 403s

**Files:**
- Modify: `ui/src/views/Approvals.tsx`, `ui/src/api.ts:178-184`, `ui/src/types.ts:103-105`
- Test: `ui/src/views/Approvals.test.tsx`

**Interfaces:**
- Consumes: `GET /api/pending-actions` with `issueRef`/`canonical`/`viaAgentName` (Task 8); `GET /api/settings`.
- Produces: no new exports.

**Context:** Two changes. (1) When `supervised.affirm_requires_signature` is true the Approve button must not render — offering a button that 403s is worse than offering none. (2) `issueRef` now comes from the endpoint, so **delete the second `listIssues` poll** (`Approvals.tsx:85`), which existed only to resolve `issueId → ref` — that is SYD-244's over-fetch.

- [ ] **Step 1: Write the failing test**

```typescript
// ui/src/views/Approvals.test.tsx — follow the file's existing mock/render setup
it("renders the ref from the endpoint without polling the issue list", async () => {
  mockApi({ pendingActions: [row({ issueRef: "SYD-42", viaAgentName: "claude/dev" })], settings: { "supervised.affirm_requires_signature": false } });
  render(<Approvals />);
  expect(await screen.findByText("SYD-42")).toBeInTheDocument();
  expect(listIssuesSpy).not.toHaveBeenCalled();
});

it("hides Approve and explains why when signatures are required", async () => {
  mockApi({ pendingActions: [row({ issueRef: "SYD-42" })], settings: { "supervised.affirm_requires_signature": true } });
  render(<Approvals />);
  expect(await screen.findByText("SYD-42")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
  expect(screen.getByText(/syd affirm/i)).toBeInTheDocument();
});

it("still shows Approve when signatures are not required", async () => {
  mockApi({ pendingActions: [row({ issueRef: "SYD-42" })], settings: { "supervised.affirm_requires_signature": false } });
  render(<Approvals />);
  expect(await screen.findByRole("button", { name: /approve/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run ui/src/views/Approvals.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `ui/src/types.ts`, extend `PendingAction` with `issueRef: string | null`, `canonical: string | null`, `viaAgentName: string | null`, `expiresAt: number`.

In `ui/src/views/Approvals.tsx`:
- Delete the `issues` poll (line 85) and the `refById` map (line 90); take `action.issueRef` directly.
- Poll settings (reuse the existing settings fetch helper in `api.ts` — grep for how another view reads a setting; add one if none exists) and derive `requiresSignature`.
- Pass `requiresSignature` into `ApprovalRow`; when true, render instead of the button:

```tsx
        <span className="badge">signature required</span>
```

and in the list header, once:

```tsx
      {requiresSignature && (
        <p className="empty">
          These need a signed affirmation — run <code>npm run affirm -- &lt;REF&gt;</code> and
          touch your key. Your key will ask for a PIN or fingerprint, depending on the key.
        </p>
      )}
```

Show `action.viaAgentName` in the row where the session badge is, so the human can see who proposed it.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run ui/src/views/Approvals.test.tsx && npm run build:ui`
Expected: PASS; build succeeds.

- [ ] **Step 5: Screenshot it**

Run `npm run dev:ui`, seed a pending action, and capture the panel in both setting states. Attach both to SYD-242 (the repo's visual-verification norm).

- [ ] **Step 6: Commit**

```bash
git add ui/src/views/Approvals.tsx ui/src/views/Approvals.test.tsx ui/src/api.ts ui/src/types.ts
git commit -m "feat: approvals panel respects the signature gate; drop the ref over-fetch (SYD-242 phase 2 task 10)"
```

---

### Task 11: Full verify + the manual hardware run

**Files:** none (verification only; fixups committed with explicit paths).

**Context:** The manual run **is the deliverable**. The spike's success criterion is not "tests pass" — it is *does the ceremony feel like a meaningful beat, or friction you rubber-stamp?* Everything before this task exists to make this run possible.

- [ ] **Step 1: Full verify**

Run: `npm run verify`
Expected: node-version check + `TZ=UTC` typecheck + `build:ui` + full suite, all green. Fix and commit any fallout with explicit paths.

- [ ] **Step 2: Enroll two real keys**

```bash
ssh-keygen -t ed25519-sk -O resident -O verify-required -C "syd-affirm:sean"
npx tsx src/cli.ts switchyard.db add-affirm-key sean ~/.ssh/id_ed25519_sk.pub keyring
# repeat with the second key — there is no break-glass; redundancy IS the recovery story
npx tsx src/cli.ts switchyard.db list-affirm-keys sean
```
Expected: two live rows.

- [ ] **Step 3: Turn the gate on**

Set `supervised.affirm_requires_signature` to `true` via `PATCH /api/settings` (or the settings UI).

- [ ] **Step 4: Drive the whole loop**

Open a supervised session, propose `done` on a scratch issue, confirm the MCP call returns a **success** carrying the canonical doc (not an error), then:

```bash
SWITCHYARD_TOKEN=syd_... npm run affirm -- SYD-<scratch>
```

Expected: the action renders; the key prompts; the issue lands `done`.

- [ ] **Step 5: Prove the gate actually holds**

- Web Approve button is absent while the setting is on.
- `POST /api/pending-actions/:id/affirm` with the cookie → **403**.
- Re-POST the same signature → refused (exactly-once).
- Wait out `affirm_ttl_seconds`, then affirm → refused as expired.
- **The one that matters:** have Claude (this session) attempt `npm run affirm -- SYD-<scratch>` itself. It should hang on a prompt it cannot satisfy. *That is the whole spike in one observation — record what happens.*

- [ ] **Step 6: Write up the finding on SYD-242**

Comment with: did the ceremony feel meaningful or rubber-stamped; how the two-key enrollment felt; what Claude's own attempt did; and whether this is worth keeping on. Per the spec, the honest answer may be "no" — that is a valid outcome for a spike and must be recorded as plainly as a "yes."

- [ ] **Step 7: Move SYD-242 to `in_review`**

Per `CLAUDE.md`: `npm run verify` first (Step 1), then a human stamps `done`. Attach the screenshots from Task 10.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Why / scope / motivation-is-the-artifact | Task 11 Step 6 (the finding); constraints header |
| (a) threat framing | recorded in spec; no code |
| (b) `service` exempt by construction | no code — proven, not built |
| (c) no break-glass, key redundancy | Task 2 (table), Task 5 (multi-key + CLI nudge), Task 11 Step 2 |
| (d) `affirm_requires_signature` gates the click | Task 1 (setting), Task 8 (403), Task 10 (button) |
| §1 terminal inversion | Task 9 |
| §2 sign canonical doc, verify by re-deriving | Task 3, Task 8 (`canonicalFor`) |
| §3 token-enforces-presence / hardware key-type check at enrollment / accurate copy | Task 5 (`buildAllowedSigners` + `enrollAffirmationKey`), Global Constraints |
| Data model: `expiresAt`, `affirmation_keys`, settings | Tasks 1, 2 |
| Blocker #1: `PendingAffirmation` + 2 translations | Task 4 |
| Verification + Dockerfile | Task 6 |
| Surfaces: CLI / REST / web | Tasks 9, 8, 10 |
| Error handling table | Tasks 4, 6, 7, 8 |
| Testing (incl. the UV-bit exclusion) | Tasks 3, 5, 6, 8, 10, 11 |
| Absorbs SYD-243 / SYD-244 | Task 8 |

**Placeholder scan:** none. Every code step carries real code; every command carries expected output.

**Type consistency:** `AFFIRM_NAMESPACE`, `CanonicalAction`, `canonicalizeAction`, `PendingAffirmation`/`PendingAffirmationView`, `AffirmationKeyRow`, `buildAllowedSigners(keys, principal, opts)`, `verifySshSig({message, armoredSignature, allowedSigners, principal})`, `findOrCreatePendingAction(..., expiresAt)`, `affirmPendingAction(db, human, id)` — each defined once and used with the same shape throughout.

**Known sharp edges, flagged for the implementer rather than hidden:**
1. **Task 2 Step 4** — drizzle-kit may emit a bare `NOT NULL` add that SQLite rejects on a non-empty table. Read the generated SQL; hand-edit. Also confirm the partial-index predicate was emitted.
2. **Task 7 Step 3** — the `expired` marking must happen **outside** `db.transaction`, or the throw rolls it back. The plan restructures for this; do not "simplify" it back inside.
3. **Task 8 Step 1** — SUPERSEDED by the 2026-07-16 correction (spec §3). There is no `verify-required`, so no mock is needed: a software key verifies through the real production path. Route tests insert an `affirmation_keys` row directly and use real crypto.
4. **Task 4 Step 8** — Phase 1 hard-gate tests asserting the old `SwitchyardError` message will fail. Updating them is intended, not a regression.
