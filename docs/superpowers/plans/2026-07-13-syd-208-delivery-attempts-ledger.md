# SYD-208: delivery_attempts Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the delivery worker's event-feed cursor with a `delivery_attempts` ledger triggered from state: SHA-pinned compare-and-set human authorizations (done-stamp + Retry), once-per-trigger attempts, deploy-only retries, live-GitHub crash resumption, and a rollout backfill that fires nothing on day one.

**Architecture:** A new `delivery_attempts` table is the delivery-side twin of `pr_state`. Authorizations are the existing human-written events (`status_changed`→done and `redeliver_requested`), now carrying a `pin: {repo, prNumber, headSha}` payload validated compare-and-set against `pr_state` at write time. The per-tick trigger is a server-side query — issues whose *current* status is `done` with an authorization that has no attempt row — exposed at `GET /api/delivery-work`; the worker starts an attempt row before acting and finishes it with an outcome. The cursor file, `feedGap`, and the feed-scanning functions are deleted.

**Tech Stack:** TypeScript, Drizzle ORM (SQLite/better-sqlite3), Hono, Zod, Vitest, React (thin UI client), `gh` CLI in the worker.

**Spec:** `docs/2026-07-12-sync-simplification-assessment.md` rev 4, section "2. Trigger delivery from state + an attempt ledger, not an event cursor". Issue: SYD-208.

## Global Constraints

- All business logic in `src/services/*`; MCP/REST/UI are thin adapters. Services throw `SwitchyardError` for user-facing failures.
- The complete outcome enum, verbatim from the spec: `merged_deployed | merged_deploy_failed | verify_failed | conflict_bounced | merge_failed | checks_timeout | sha_chain_disarmed | skipped_rollout`. (`checks_timeout` and `sha_chain_disarmed` are *written* only by SYD-209's orchestrator; the enum, column, and Retry affordance for them land now.)
- Once per human trigger: a failed attempt goes quiet until a human re-stamps or clicks Retry. Failed attempts STILL record a `delivery_failed` event (that lights the attention chip and gates `redeliverIssue`).
- The rollout backfill and the trigger derive the authorization set from the IDENTICAL function (`listPendingDeliveryAuthorizations`) — parity by construction, plus its own test.
- Crash resumption consults GitHub live (`gh pr view`), never `pr_state`.
- Only delivery infrastructure (human-typed token) may write attempt rows — same actor-type gate as `recordDeliveryEvent` (SYD-108).
- Tokens never in argv. After edits to `src/db/schema.ts`, run `npm run db:generate`.
- Run tests with `npx vitest run <file>`; full gates before any commit: `npm run typecheck && npm run build:ui && npx vitest run` (subagent commit gate — run in-transcript, never report unrun evidence).
- Commit messages reference the issue, e.g. `feat: delivery_attempts ledger schema + service (SYD-208)`.

---

### Task 1: Schema — `delivery_attempts` + `delivery_rollout` tables

**Files:**
- Modify: `src/db/schema.ts` (append after the `prState` table, before `settings`)
- Create: `drizzle/0013_*.sql` (generated — never hand-edit)
- Test: `tests/services/delivery-attempts.test.ts` (created here with one schema smoke test; Task 2 grows it)

**Interfaces:**
- Produces: `deliveryAttempts`, `deliveryRollout` tables; `DELIVERY_OUTCOMES` const array and `DeliveryOutcome` type — imported by Tasks 2, 4.

- [ ] **Step 1: Write the failing test**

Create `tests/services/delivery-attempts.test.ts`. Mirror the setup style of `tests/services/pr-state.test.ts` (open an in-memory db via the existing test helper — check `tests/db` or how `pr-state.test.ts` builds its db and copy that exactly):

```ts
import { describe, it, expect } from "vitest";
import { deliveryAttempts, DELIVERY_OUTCOMES } from "../../src/db/schema.js";
// ...same db/test fixtures imports as tests/services/pr-state.test.ts

describe("delivery_attempts schema", () => {
  it("stores and reads an attempt row with the full outcome enum available", () => {
    const db = /* same in-memory openDb/fixture pattern as pr-state.test.ts,
                  including a seeded project/issue/actor and one event to
                  reference as authorizationId */;
    expect(DELIVERY_OUTCOMES).toEqual([
      "merged_deployed",
      "merged_deploy_failed",
      "verify_failed",
      "conflict_bounced",
      "merge_failed",
      "checks_timeout",
      "sha_chain_disarmed",
      "skipped_rollout",
    ]);
    db.insert(deliveryAttempts)
      .values({ issueRef: "SYD-1", prNumber: 7, headSha: "abc", authorizationId: 1 })
      .run();
    const row = db.select().from(deliveryAttempts).all()[0];
    expect(row.outcome).toBeNull();
    expect(row.finishedAt).toBeNull();
    expect(row.startedAt).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/services/delivery-attempts.test.ts`
Expected: FAIL — `deliveryAttempts`/`DELIVERY_OUTCOMES` not exported.

- [ ] **Step 3: Implement the schema**

In `src/db/schema.ts`, after the `prState` table:

```ts
// The delivery-side twin of pr_state (SYD-208, spec: docs/2026-07-12-sync-
// simplification-assessment.md Step 2): one row per delivery attempt, keyed by
// the human authorization event (a done-stamp or redeliver_requested) that
// authorized it. The trigger query — done issues with an authorization that
// has no attempt row — replaces the deliver-cursor, so "once per human
// trigger" is a table constraint, not a cursor invariant. headSha is the
// authorized head (S0); derivedHeadSha is the post-rebase head (S1) the
// SYD-209 orchestrator persists for crash re-anchoring. outcome is null while
// an attempt is running; a start row with no finish is crash evidence, resumed
// against live GitHub (never pr_state).
export const DELIVERY_OUTCOMES = [
  "merged_deployed",
  "merged_deploy_failed",
  "verify_failed",
  "conflict_bounced",
  "merge_failed",
  "checks_timeout",
  "sha_chain_disarmed",
  "skipped_rollout",
] as const;
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];

export const deliveryAttempts = sqliteTable(
  "delivery_attempts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    issueRef: text("issue_ref").notNull(),
    prNumber: integer("pr_number"),
    headSha: text("head_sha"),
    derivedHeadSha: text("derived_head_sha"),
    authorizationId: integer("authorization_id")
      .notNull()
      .references(() => events.id),
    startedAt: integer("started_at").notNull().default(now()),
    finishedAt: integer("finished_at"),
    outcome: text("outcome", { enum: DELIVERY_OUTCOMES }),
  },
  (t) => [
    index("delivery_attempts_authorization_id_idx").on(t.authorizationId),
    index("delivery_attempts_issue_ref_idx").on(t.issueRef),
  ],
);

// One-row marker: the SYD-208 rollout backfill (skipped_rollout rows for every
// pre-existing authorization) ran. A marker, not an empty-table check — on a
// fresh install the table stays empty until the first real stamp, and that
// stamp must not be swallowed by a restart.
export const deliveryRollout = sqliteTable("delivery_rollout", {
  id: integer("id").primaryKey(),
  completedAt: integer("completed_at").notNull().default(now()),
});
```

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate`
Expected: a new `drizzle/0013_*.sql` creating both tables. Inspect it; commit it as-is.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/services/delivery-attempts.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts drizzle tests/services/delivery-attempts.test.ts
git commit -m "feat: delivery_attempts + delivery_rollout schema (SYD-208)"
```

---

### Task 2: Service — `src/services/delivery-attempts.ts`

**Files:**
- Create: `src/services/delivery-attempts.ts`
- Test: `tests/services/delivery-attempts.test.ts` (extend Task 1's file)

**Interfaces:**
- Consumes: `deliveryAttempts`, `deliveryRollout`, `DELIVERY_OUTCOMES`, `DeliveryOutcome` (Task 1); `recordEvent` is NOT used here (the ledger is a table, not events).
- Produces (exact signatures — Tasks 4 and 6 depend on these):

```ts
export type DeliveryPinPayload = { repo: string; prNumber: number; headSha: string | null };
export type PendingAuthorization = {
  authorizationId: number;
  ref: string;
  kind: "done_stamp" | "redeliver";
  pin: DeliveryPinPayload | null;
};
export type DeliveryAttemptRow = typeof deliveryAttempts.$inferSelect;
export type DeployRetry = {
  authorizationId: number;
  ref: string;
  prNumber: number | null;
  headSha: string | null;
  retryNumber: number; // 1-based: first automatic retry is 1
};

export function listPendingDeliveryAuthorizations(db: DbOrTx): PendingAuthorization[];
export function startDeliveryAttempt(
  db: Db, actor: Actor, ref: string,
  input: { authorizationId: number; prNumber?: number; headSha?: string; deployRetry?: boolean },
): DeliveryAttemptRow;
export function finishDeliveryAttempt(
  db: Db, actor: Actor, attemptId: number,
  input: { outcome: DeliveryOutcome; derivedHeadSha?: string },
): DeliveryAttemptRow;
export function listUnfinishedAttempts(db: Db): DeliveryAttemptRow[];
export const MAX_DEPLOY_RETRIES = 3;
export const DEPLOY_RETRY_BACKOFF_SECONDS = 300;
export function deployRetryDue(attemptCount: number, finishedAt: number, nowSeconds: number): boolean; // pure
export function listDeployRetries(db: Db, nowSeconds?: number): DeployRetry[];
export function ensureRolloutBackfill(db: Db): { backfilled: number; alreadyDone: boolean };
```

**Semantics (implement exactly):**

- `listPendingDeliveryAuthorizations` — issues whose CURRENT status is `done`, with an authorization event that has no attempt row for that `authorizationId`. Authorization events are: every `redeliver_requested`, and — for done-stamps — only the LATEST `status_changed`→`done` event per issue (an older stamp that was retracted and re-stamped stays disarmed; the human's retract explicitly withdrew it). Use raw SQL via `db.all` (the `attention.ts` pattern):

```sql
SELECT e.id AS authorizationId,
       p.key || '-' || i.number AS ref,
       CASE e.type WHEN 'redeliver_requested' THEN 'redeliver' ELSE 'done_stamp' END AS kind,
       json_extract(e.payload, '$.pin.repo') AS pinRepo,
       json_extract(e.payload, '$.pin.prNumber') AS pinPrNumber,
       json_extract(e.payload, '$.pin.headSha') AS pinHeadSha
FROM events e
JOIN issues i ON i.id = e.issue_id
JOIN projects p ON p.id = i.project_id
WHERE i.status = 'done'
  AND (
    e.type = 'redeliver_requested'
    OR (
      e.type = 'status_changed'
      AND json_extract(e.payload, '$.to') = 'done'
      AND e.id = (
        SELECT MAX(e2.id) FROM events e2
        WHERE e2.issue_id = e.issue_id
          AND e2.type = 'status_changed'
          AND json_extract(e2.payload, '$.to') = 'done'
      )
    )
  )
  AND NOT EXISTS (SELECT 1 FROM delivery_attempts da WHERE da.authorization_id = e.id)
ORDER BY e.id ASC
```

Map rows: `pin` is the object when `pinRepo` is non-null, else `null`.

- `startDeliveryAttempt` — refuse agent actors with the same rationale/wording style as `recordDeliveryEvent` (SYD-108). In a transaction: load the issue by ref (`getIssue`); assert the authorization event exists, belongs to this issue, and is one of the two authorization types (`SELECT` on `events`); if `deployRetry` is NOT set, refuse when ANY attempt row exists for `authorizationId` (`"...already has a delivery attempt — once per human trigger; re-stamp or click Retry to re-authorize."`); if `deployRetry` IS set, require the LATEST attempt for that authorizationId to have outcome `merged_deploy_failed`. Insert `{issueRef: issue.ref, prNumber, headSha, authorizationId}` and return the row.
- `finishDeliveryAttempt` — human-token gate; row must exist and have `finishedAt IS NULL` (else `SwitchyardError`); refuse outcome `skipped_rollout` (`"skipped_rollout is written only by the rollout backfill."`); set `outcome`, `derivedHeadSha` (if given), `finishedAt = unixepoch()`.
- `listUnfinishedAttempts` — `finishedAt IS NULL`, ordered by id.
- `deployRetryDue(attemptCount, finishedAt, now)` — pure: `attemptCount - 1 < MAX_DEPLOY_RETRIES && now >= finishedAt + DEPLOY_RETRY_BACKOFF_SECONDS * 2 ** (attemptCount - 1)`.
- `listDeployRetries` — authorizations whose LATEST attempt has outcome `merged_deploy_failed`, filtered by `deployRetryDue` with the attempt count for that authorization. `retryNumber = attemptCount` (the original attempt is attempt 1, so the first automatic retry reports `retryNumber: 1`). SQL: latest-row-per-authorization via `da.id = (SELECT MAX(id) ... same authorization_id)` plus a `COUNT(*)` subquery; apply `deployRetryDue` in TS.
- `ensureRolloutBackfill` — one transaction: if a `deliveryRollout` row exists return `{backfilled: 0, alreadyDone: true}`; else insert, for every row of `listPendingDeliveryAuthorizations(tx)`, an attempt `{issueRef: ref, prNumber: pin?.prNumber ?? null, headSha: pin?.headSha ?? null, authorizationId, finishedAt: now, outcome: "skipped_rollout"}` (set `finishedAt` explicitly with `Math.floor(Date.now()/1000)`), then insert the marker `{id: 1}`. Parity with the trigger is by construction — same function.

- [ ] **Step 1: Write the failing tests** (extend `tests/services/delivery-attempts.test.ts`; use the existing fixture helpers for db/actors/issues — a human actor, an agent actor, a project, issues, and `updateIssue`/`recordEvent` to author real events)

Test list — implement each with real assertions:

```ts
describe("listPendingDeliveryAuthorizations", () => {
  it("returns a done-stamped issue's stamp with its pin payload", ...);
    // seed: pr_state open row via upsertPrState, stamp done via updateIssue
    // with expectedHeadSha (Task 3 — until then, author the status_changed
    // event with recordEvent carrying payload {from:"in_review",to:"done",
    // pin:{repo:"o/r",prNumber:7,headSha:"abc"}} and set issue status done
    // directly through updateIssue by a human without a PR, or insert the
    // event via recordEvent after a plain human stamp; assert authorizationId
    // matches that event id and pin round-trips)
  it("no-spin: once an attempt row exists for the authorization, it is not pending", ...);
  it("status-retract disarms: stamp then move done->in_review leaves nothing pending", ...);
  it("stamp -> retract -> re-stamp yields exactly one pending authorization (the newest)", ...);
  it("every redeliver_requested is its own authorization", ...);
  it("observation lag: pr_state still open + finished attempt row => nothing pending (no re-merge)", ...);
});

describe("startDeliveryAttempt / finishDeliveryAttempt", () => {
  it("refuses agent actors", ...);
  it("is once-per-authorization: second start throws", ...);
  it("deployRetry start requires latest outcome merged_deploy_failed", ...);
  it("finish sets outcome + finishedAt; refuses a second finish", ...);
  it("finish refuses skipped_rollout", ...);
});

describe("deploy retries", () => {
  it("deployRetryDue: bounded at MAX_DEPLOY_RETRIES and backs off exponentially", () => {
    expect(deployRetryDue(1, 1000, 1000 + 300)).toBe(true);
    expect(deployRetryDue(1, 1000, 1000 + 299)).toBe(false);
    expect(deployRetryDue(2, 1000, 1000 + 600)).toBe(true);
    expect(deployRetryDue(4, 1000, 1_000_000)).toBe(false); // bound: 3 retries max
  });
  it("listDeployRetries surfaces only latest-attempt merged_deploy_failed past backoff", ...);
  it("a merged_deployed retry outcome clears the issue from the retry list", ...);
});

describe("ensureRolloutBackfill", () => {
  it("rollout fires nothing: writes skipped_rollout for BOTH kinds and empties the pending list", ...);
    // seed one historical done-stamp AND one historical redeliver_requested on
    // done issues; run; assert listPendingDeliveryAuthorizations() === [] and
    // rows have outcome skipped_rollout with finishedAt set
  it("is once-only: a second call is a no-op even with new pending authorizations", ...);
    // run once; stamp a NEW issue done; run again; assert the new
    // authorization is STILL pending (not swallowed) and backfilled === 0
});
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/services/delivery-attempts.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `src/services/delivery-attempts.ts`** per the semantics block above. Header comment names SYD-208 and the spec section, and states the parity-by-construction rule and the latest-stamp-per-issue rule.

- [ ] **Step 4: Run to verify they pass** — `npx vitest run tests/services/delivery-attempts.test.ts` → PASS.

- [ ] **Step 5: Full gates, then commit**

```bash
npm run typecheck && npm run build:ui && npx vitest run
git add src/services/delivery-attempts.ts tests/services/delivery-attempts.test.ts
git commit -m "feat: delivery-attempts service — trigger predicate, ledger writes, deploy retries, rollout backfill (SYD-208)"
```

---

### Task 3: SHA-pinned compare-and-set authorizations (service layer)

**Files:**
- Modify: `src/services/pr-status.ts` (openRows gains `repo`/`headSha`; new `deliveryPinFor`)
- Modify: `src/services/issues.ts` (done-stamp pin validation + pinned event payload)
- Modify: `src/services/triage-actions.ts` (`redeliverIssue` pin)
- Test: `tests/services/pr-status.test.ts`, `tests/services/issues-update.test.ts`, `tests/services/triage-actions.test.ts`

**Interfaces:**
- Consumes: `findPrState`-style reads via raw SQL over `pr_state` (existing pattern in pr-status.ts).
- Produces:

```ts
// pr-status.ts
export type OpenPr = { prNumber: number; url: string; repo: string; headSha: string | null };
export type DeliveryPin = { repo: string; prNumber: number; headSha: string | null; status: "open" | "merged" | "closed" };
export function deliveryPinFor(db: DbOrTx, issueId: number): DeliveryPin | null;
// issues.ts
export type UpdateIssueInput = { /* existing */ expectedHeadSha?: string };
// triage-actions.ts
export function redeliverIssue(db: Db, actor: Actor, ref: string, expectedHeadSha?: string): IssueView;
```

**Semantics:**

- `openRows` (pr-status.ts): add `ps.repo AS repo, ps.head_sha AS headSha` to the SELECT; thread through `getOpenPr`/`listOpenPrByIssueId`. All existing consumers keep working (extra fields).
- `deliveryPinFor`: the issue's attributed `pr_state` row a Retry would re-authorize — preference open > merged > closed, newest first:

```sql
SELECT ps.repo AS repo, ps.pr_number AS prNumber, ps.head_sha AS headSha, ps.status AS status
FROM pr_state ps, issues i, projects p
WHERE i.project_id = p.id
  AND i.id = ${issueId}
  AND ps.issue_ref = p.key || '-' || i.number
ORDER BY CASE ps.status WHEN 'open' THEN 0 WHEN 'merged' THEN 1 ELSE 2 END,
         COALESCE(ps.gh_updated_at, 0) DESC, ps.pr_number DESC
LIMIT 1
```

- `updateIssue` done-stamp pin (issues.ts): inside the status-change branch, when `patch.status === "done"` (actor is human by construction — agents were already rejected), compute the pin before pushing the `status_changed` event:

```ts
// SYD-208: stamping done on an issue with an open agent PR authorizes
// delivery, so it is compare-and-set on the PR head — the client submits the
// SHA it displayed, and a third-party push landing seconds before the click
// is rejected instead of silently authorized. The validated pin rides the
// status_changed payload; the delivery trigger reads it from there.
let donePin: { repo: string; prNumber: number; headSha: string } | null = null;
if (patch.status === "done") {
  const open = getOpenPr(tx, current.id);
  if (open) {
    if (open.headSha === null) {
      throw new SwitchyardError(
        `${ref}'s open agent PR #${open.prNumber} has no recorded head SHA yet — wait for the poller/webhook to record one, then stamp again.`,
      );
    }
    if (patch.expectedHeadSha === undefined) {
      throw new SwitchyardError(
        `Stamping ${ref} done authorizes delivery of PR #${open.prNumber} — pass expectedHeadSha (the head SHA you reviewed) to confirm. Current head: ${open.headSha}.`,
      );
    }
    if (patch.expectedHeadSha !== open.headSha) {
      throw new SwitchyardError(
        `${ref}'s PR #${open.prNumber} head moved since you looked: you reviewed ${patch.expectedHeadSha}, but the head is now ${open.headSha} — review the new commits, then stamp again.`,
      );
    }
    donePin = { repo: open.repo, prNumber: open.prNumber, headSha: open.headSha };
  }
}
```

and the event push becomes:

```ts
toRecord.push({
  type: "status_changed",
  payload: { from: current.status, to: patch.status, ...(donePin ? { pin: donePin } : {}) },
});
```

(No open PR → no pin required, plain stamp — interactive work keeps working.)

- `redeliverIssue` (triage-actions.ts): keep the human gate and the `delivery_failed` attention gate; then:

```ts
const pin = deliveryPinFor(db, current.id);
if (!pin) {
  throw new SwitchyardError(`${ref} has no agent PR on record — nothing to redeliver.`);
}
if (pin.headSha === null) {
  throw new SwitchyardError(
    `${ref}'s PR #${pin.prNumber} has no recorded head SHA yet — wait for the poller/webhook to record one, then retry.`,
  );
}
if (expectedHeadSha === undefined) {
  throw new SwitchyardError(
    `Retrying ${ref} re-authorizes delivery of PR #${pin.prNumber} — pass expectedHeadSha (the head SHA you reviewed) to confirm. Current head: ${pin.headSha}.`,
  );
}
if (expectedHeadSha !== pin.headSha) {
  throw new SwitchyardError(
    `${ref}'s PR #${pin.prNumber} head moved since you looked: you saw ${expectedHeadSha}, but the head is now ${pin.headSha} — review the new commits before re-authorizing.`,
  );
}
recordEvent(db, {
  issueId: current.id,
  actorId: actor.id,
  type: "redeliver_requested",
  payload: { pin: { repo: pin.repo, prNumber: pin.prNumber, headSha: pin.headSha } },
});
```

The "head moved" error IS the post-disarm old→new delta surface the spec requires — a reflexive Retry click after a `sha_chain_disarmed` cannot silently re-pin the refused push, because the client's displayed SHA no longer matches.

- [ ] **Step 1: Write the failing tests**

`tests/services/issues-update.test.ts` additions (follow the file's existing fixture style):

```ts
describe("done-stamp SHA pin (SYD-208)", () => {
  it("stamps done with no open PR without any pin", ...);
  it("refuses stamping done over an open agent PR without expectedHeadSha", ...);
  it("refuses when expectedHeadSha does not match pr_state's current head, naming both SHAs", ...);
    // assert the error message contains both the submitted and current SHA
  it("records the pin on the status_changed payload when the SHA matches", ...);
    // stamp with the right SHA; read the newest status_changed event; assert
    // payload.pin deep-equals {repo, prNumber, headSha}
  it("fails closed when the open PR row has no headSha", ...);
});
```

`tests/services/triage-actions.test.ts` additions:

```ts
describe("redeliverIssue SHA pin (SYD-208)", () => {
  it("refuses without expectedHeadSha", ...);
  it("refuses a moved head, naming old and new SHAs", ...);
  it("records redeliver_requested with the pin when the SHA matches", ...);
  it("pins the merged PR when no open PR exists (deploy-retry authorization)", ...);
  it("refuses when the issue has no attributed PR row at all", ...);
});
```

`tests/services/pr-status.test.ts` additions: `deliveryPinFor` prefers open over merged over closed; returns null with no rows; `getOpenPr` now carries `repo` and `headSha`.

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/services/issues-update.test.ts tests/services/triage-actions.test.ts tests/services/pr-status.test.ts`

- [ ] **Step 3: Implement** the three service edits above. Note `redeliverIssue`'s existing callers (REST route, tests) still compile — the new param is optional (they now FAIL at runtime without it; Task 4 updates the route, and existing redeliver tests must be updated here to pass a pin — seed a pr_state row via `upsertPrState` first).

- [ ] **Step 4: Run to verify they pass**, including the untouched suites that exercise stamping done (`tests/rest/api-issues.test.ts`, `tests/services/stale-claims.test.ts`, deviation/attention tests): `npx vitest run tests/services tests/rest`
Expected: PASS — done-stamps in older tests have no open pr_state rows, so no pin is demanded. Fix any test that stamps done over a seeded open PR by passing `expectedHeadSha`.

- [ ] **Step 5: Full gates, then commit**

```bash
npm run typecheck && npm run build:ui && npx vitest run
git add -A src tests
git commit -m "feat: SHA-pinned compare-and-set done-stamp + Retry authorizations (SYD-208)"
```

---

### Task 4: REST surface + startup rollout backfill

**Files:**
- Modify: `src/rest/schemas.ts`, `src/rest/api-routes.ts`, `src/server.ts`
- Test: Create `tests/rest/api-delivery-attempts.test.ts`; modify `tests/rest/api-escalation.test.ts` (redeliver body), `tests/rest/api-issues.test.ts` (detail `deliveryPin`, PATCH `expectedHeadSha` passthrough)

**Interfaces:**
- Consumes: everything from Tasks 2–3.
- Produces (the worker's Task-6 contract):
  - `GET /api/delivery-work` → `{ pending: PendingAuthorization[], unfinished: DeliveryAttemptRow[], deployRetries: DeployRetry[] }` — human-token only (agents 400).
  - `POST /api/issues/:ref/delivery-attempts` body `{authorizationId, prNumber?, headSha?, deployRetry?}` → attempt row JSON.
  - `PATCH /api/delivery-attempts/:id` body `{outcome, derivedHeadSha?}` → attempt row JSON. `outcome` schema excludes `skipped_rollout`.
  - `PATCH /api/issues/:ref` accepts `expectedHeadSha?: string`.
  - `POST /api/issues/:ref/redeliver` body `{expectedHeadSha?: string}`.
  - `GET /api/issues/:ref` response gains `deliveryPin: DeliveryPin | null`; `openPr` (list + detail) now carries `repo`/`headSha`.

- [ ] **Step 1: Write the failing tests**

`tests/rest/api-delivery-attempts.test.ts` (mirror `tests/rest/api-delivery-events.test.ts` fixture style — app via `buildApiRoutes`, human + agent tokens):

```ts
describe("GET /api/delivery-work", () => {
  it("refuses agent tokens", ...);
  it("returns pending authorizations with pins, unfinished attempts, and deploy retries", ...);
});
describe("POST /api/issues/:ref/delivery-attempts", () => {
  it("starts an attempt and enforces once-per-authorization on a second call", ...);
  it("refuses agent tokens", ...);
});
describe("PATCH /api/delivery-attempts/:id", () => {
  it("finishes with an outcome; rejects skipped_rollout at the schema layer (400)", ...);
});
```

`api-issues.test.ts` additions: PATCH to done over an open PR without `expectedHeadSha` → 400 whose error names the current head; with the right SHA → 200 and detail shows `deliveryPin`.
`api-escalation.test.ts`: update redeliver tests to seed a pr_state row and POST `{expectedHeadSha}`; add a 400 moved-head case.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.** `schemas.ts`:

```ts
import { STATUSES, PRIORITIES, DELIVERY_OUTCOMES } from "../db/schema.js";

export const issueUpdateBody = z.object({
  /* ...existing fields unchanged... */
  expectedHeadSha: z.string().min(1).optional(),
});
export const redeliverBody = z.object({ expectedHeadSha: z.string().min(1).optional() });
export const deliveryAttemptStartBody = z.object({
  authorizationId: z.number().int().positive(),
  prNumber: z.number().int().positive().optional(),
  headSha: z.string().min(1).optional(),
  deployRetry: z.boolean().optional(),
});
const WORKER_OUTCOMES = DELIVERY_OUTCOMES.filter((o) => o !== "skipped_rollout") as [
  string, ...string[],
];
export const deliveryAttemptFinishBody = z.object({
  outcome: z.enum(WORKER_OUTCOMES),
  derivedHeadSha: z.string().min(1).optional(),
});
```

`api-routes.ts`: import the Task-2 service; add the three routes (id parsing per the `parseActorId` pattern); change redeliver to `body(redeliverBody)` and pass `expectedHeadSha`; add `deliveryPin: deliveryPinFor(db, issue.id)` to the detail response. The agent-refusal lives in the service (`startDeliveryAttempt` etc.) — for the read endpoint add the check inline in the service `listDeliveryWork(db, actor)`? No: add a small service wrapper in `delivery-attempts.ts`:

```ts
export function getDeliveryWork(db: Db, actor: Actor): {
  pending: PendingAuthorization[]; unfinished: DeliveryAttemptRow[]; deployRetries: DeployRetry[];
} {
  requireDeliveryInfra(actor); // shared private helper with start/finish
  return {
    pending: listPendingDeliveryAuthorizations(db),
    unfinished: listUnfinishedAttempts(db),
    deployRetries: listDeployRetries(db),
  };
}
```

`server.ts` entrypoint (after `openDb`, before `startServer`):

```ts
const { ensureRolloutBackfill } = await import("./services/delivery-attempts.js");
const rollout = ensureRolloutBackfill(db);
if (!rollout.alreadyDone)
  console.log(`delivery rollout backfill: ${rollout.backfilled} authorization(s) marked skipped_rollout`);
```

- [ ] **Step 4: Run to verify they pass** — `npx vitest run tests/rest tests/services`.

- [ ] **Step 5: Full gates, then commit**

```bash
npm run typecheck && npm run build:ui && npx vitest run
git add -A src tests
git commit -m "feat: delivery-work + delivery-attempts REST surface, startup rollout backfill (SYD-208)"
```

---

### Task 5: UI — submit the SHA the human saw

**Files:**
- Modify: `ui/src/types.ts`, `ui/src/api.ts`, `ui/src/views/Review.tsx`, `ui/src/views/IssueDetail.tsx`, `ui/src/views/Board.tsx`
- Test: `ui/src/views/IssueDetail.test.tsx`, `ui/src/views/Review.test.tsx` (if present), `ui/src/views/Board.test.tsx`

**Interfaces:**
- Consumes: Task 4's REST contract.
- Produces: every done-stamp site sends `expectedHeadSha: <the openPr.headSha it rendered>`; Retry sends the rendered `deliveryPin.headSha`.

- [ ] **Step 1: Write the failing tests** — in each view test, seed an issue fixture with `openPr: { prNumber: 7, url: "...", repo: "o/r", headSha: "abc123" }` (and `deliveryPin` on the detail fixture), spy on the fetch/api call, and assert the PATCH body contains `expectedHeadSha: "abc123"` when stamping done, and the redeliver POST body contains the deliveryPin SHA. Follow each test file's existing mock pattern exactly.

- [ ] **Step 2: Run to verify they fail** — `npx vitest run ui/src/views/IssueDetail.test.tsx ui/src/views/Board.test.tsx` (and Review's test file if it exists).

- [ ] **Step 3: Implement.**

`types.ts`:

```ts
openPr: { prNumber: number; url: string; repo: string; headSha: string | null } | null;
// on IssueDetail:
deliveryPin: { repo: string; prNumber: number; headSha: string | null; status: "open" | "merged" | "closed" } | null;
```

`api.ts`: `updateIssue`'s patch type gains `expectedHeadSha?: string`;

```ts
export const redeliverIssue = (ref: string, expectedHeadSha?: string) =>
  api<Issue>(`/api/issues/${ref}/redeliver`, {
    method: "POST",
    body: JSON.stringify({ expectedHeadSha }),
  });
```

`Review.tsx` approve:

```ts
updateIssue(current.ref, {
  status: "done",
  expectedHeadSha: current.openPr?.headSha ?? undefined,
}).then(/* unchanged */);
```

`IssueDetail.tsx` status select:

```tsx
onChange={(e) =>
  act(() =>
    updateIssue(refId, {
      status: e.target.value as Status,
      expectedHeadSha:
        e.target.value === "done" ? (data.openPr?.headSha ?? undefined) : undefined,
    }),
  )
}
```

and Retry:

```tsx
onRetry={() => act(() => redeliverIssue(refId, data.deliveryPin?.headSha ?? undefined))}
```

`Board.tsx` move — look the issue up in the loaded list:

```ts
const move = (ref: string, status: Status) => {
  const issue = data.find((i) => i.ref === ref);
  return updateIssue(ref, {
    status,
    expectedHeadSha: status === "done" ? (issue?.openPr?.headSha ?? undefined) : undefined,
  }).then(/* unchanged */);
};
```

(Server errors — moved head, missing SHA — surface through each view's existing error bar; the message carries the old→new delta.)

- [ ] **Step 4: Run to verify they pass** — `npx vitest run ui/src`.

- [ ] **Step 5: Full gates, then commit**

```bash
npm run typecheck && npm run build:ui && npx vitest run
git add -A ui
git commit -m "feat: UI submits the displayed PR head on done-stamp and Retry (SYD-208)"
```

---

### Task 6: Worker — trigger from state; delete the cursor

**Files:**
- Modify: `scripts/deliver.ts` (tick + deliver + doc header rewrite), `scripts/delivery-lib.ts` (delete cursor/feed code; add work types + pure helpers), `scripts/delivery-exec.ts` (add `prLiveState`)
- Test: `tests/scripts/deliver.test.ts` (rewrite), `tests/scripts/delivery-lib.test.ts` (prune + add), `tests/scripts/delivery-exec.test.ts` (add argv/parse coverage per its existing style)

**Interfaces:**
- Consumes: `GET /api/delivery-work`, `POST /api/issues/:ref/delivery-attempts`, `PATCH /api/delivery-attempts/:id` (Task 4).
- Produces (delivery-lib.ts):

```ts
export type WorkPin = { repo: string; prNumber: number; headSha: string | null };
export type WorkAuthorization = {
  authorizationId: number;
  ref: string;
  kind: "done_stamp" | "redeliver";
  pin: WorkPin | null;
};
export type WorkAttempt = {
  id: number; issueRef: string; prNumber: number | null; headSha: string | null;
  authorizationId: number; startedAt: number;
};
export type WorkDeployRetry = {
  authorizationId: number; ref: string; prNumber: number | null; headSha: string | null; retryNumber: number;
};
export type DeliveryWork = {
  pending: WorkAuthorization[]; unfinished: WorkAttempt[]; deployRetries: WorkDeployRetry[];
};
export type AttemptOutcome =
  | "merged_deployed" | "merged_deploy_failed" | "verify_failed" | "conflict_bounced" | "merge_failed";
export function filterWorkToProjects(work: DeliveryWork, projectKeys: Iterable<string>): DeliveryWork; // pure
export type ResumeAction = "finish-delivery" | "fail-quiet";
export function resumeActionFor(liveState: "OPEN" | "MERGED" | "CLOSED"): ResumeAction; // MERGED -> finish-delivery, else fail-quiet
export function crashedAttemptComment(ref: string, prNumber: number | null): string;
```

- Produces (delivery-exec.ts, mirroring `prFreshness` at delivery-exec.ts:90):

```ts
export type PrLiveState = { state: "OPEN" | "MERGED" | "CLOSED"; headRefOid: string; mergeCommit: string | null };
export async function prLiveState(repo: string, prNumber: number): Promise<PrLiveState>;
// gh pr view <n> -R <owner/repo> --json state,headRefOid,mergeCommit
```

**Worker algorithm (rewrite `tick` and the per-ref flow in deliver.ts):**

```
tick:
  work = GET /api/delivery-work, filtered by filterWorkToProjects(config project keys)
  1. for each work.unfinished (crash resumption — live GitHub, never pr_state):
       if prNumber === null -> PATCH finish merge_failed; POST delivery_failed event
         ("crashed mid-attempt with no PR pinned")
       else live = prLiveState(project.repo, prNumber)
         resumeActionFor(live.state):
           finish-delivery -> run finishDelivery(...) with mergeSha = live.mergeCommit,
             then PATCH finish merged_deployed | merged_deploy_failed
           fail-quiet -> PATCH finish merge_failed; comment + delivery_failed event via
             crashedAttemptComment (the merge never landed; a human re-authorizes)
  2. for each work.pending (sequential, as today):
       dry-run: print and continue (no attempt writes — dry runs stay non-mutating)
       pin === null -> start attempt, finish merge_failed, comment + delivery_failed
         ("authorization carries no PR pin — nothing to merge")
       else:
         attempt = POST start {authorizationId, prNumber: pin.prNumber, headSha: pin.headSha}
         live = prLiveState(...)
         MERGED  -> finishDelivery deploy tail with live.mergeCommit -> merged_deployed/merged_deploy_failed
         CLOSED  -> merge_failed + delivery_failed event ("PR was closed unmerged")
         OPEN    -> existing merge flow (queue or legacy) against pin.prNumber
                    -> outcome mapping below; PATCH finish {outcome, derivedHeadSha?}
  3. for each work.deployRetries:
       attempt = POST start {authorizationId, prNumber, headSha, deployRetry: true}
       live = prLiveState(...) -> deploy tail (ensureCleanClone/runVerification/runDeploy +
         delivered comment/event on success) -> merged_deployed / merged_deploy_failed
```

Outcome mapping (thread return values instead of `void`):
- `finishDelivery` returns `"merged_deployed"` (deploy ok or skipped) or `"merged_deploy_failed"` (post-merge verify failed OR deploy failed) — it already distinguishes these branches.
- `deliverQueue` returns: `conflict_bounced` (rebase conflict), `verify_failed` (post-rebase verify), `finishDelivery`'s outcome on success; a merge error after retries exhaust propagates → `merge_failed`.
- Legacy flow: unresolved conflict / failed resolution → `conflict_bounced`; rebase `verify-failed` → `verify_failed`; other merge errors → `merge_failed`; success → `finishDelivery`'s outcome.
- `derivedHeadSha`: pass `rebase.sha` / `resolution.sha` when a rebase/force-push produced the merged head, else omit.
- Every failed outcome keeps posting its comment + `delivery_failed` event exactly as today (that lights the attention chip and the Retry button).
- The outer per-ref catch: PATCH finish `merge_failed` (if an attempt row was started) + existing failure comment/event.

Delete from deliver.ts: `readCursor`, `writeCursor`, `cursorPath`, the `/api/events` fetch, `feedGap` warning, cursor advance; from delivery-lib.ts: `findRefsMatching`, `findDeliverableRefs`, `findRedeliverRefs`, `feedGap`, `parseCursorText`, `DeliveryFeedEvent`. Rewrite deliver.ts's header comment: trigger is `GET /api/delivery-work` (state + ledger, SYD-208); no cursor file; approvals stamped while the worker is down are simply still pending on restart.

- [ ] **Step 1: Write the failing tests**

`tests/scripts/delivery-lib.test.ts`: DELETE the `findDeliverableRefs`/`findRedeliverRefs`/`feedGap`/`parseCursorText` describes; ADD:

```ts
describe("filterWorkToProjects", () => {
  it("drops pending/unfinished/deployRetries rows whose ref is outside the configured projects", ...);
});
describe("resumeActionFor", () => {
  it("finishes delivery only for MERGED; OPEN and CLOSED fail quiet", () => {
    expect(resumeActionFor("MERGED")).toBe("finish-delivery");
    expect(resumeActionFor("OPEN")).toBe("fail-quiet");
    expect(resumeActionFor("CLOSED")).toBe("fail-quiet");
  });
});
```

`tests/scripts/deliver.test.ts`: rewrite on the existing mock scaffolding (`vi.mock("../../scripts/delivery-exec.js", ...)` + a fetch mock). Cover, at minimum:
- a pending authorization with an OPEN pin → starts an attempt (POST body carries authorizationId/prNumber/headSha), merges via the existing flow, finishes `merged_deployed`;
- a pending authorization whose PR is already MERGED live → `mergeAgentPr` is NEVER called (no re-merge), deploy tail runs, outcome `merged_deployed`;
- a failed verify → outcome `verify_failed` AND a `delivery_failed` event POST (Retry keeps working);
- an unfinished attempt + live MERGED → resumption deploy tail; live OPEN → `merge_failed` finish + `delivery_failed` event, and `mergeAgentPr` never called;
- a deploy retry entry → `attemptAutoRebase`/`mergeAgentPr` NEVER called, deploy tail runs, start POST carries `deployRetry: true`;
- `--dry-run` → zero POST/PATCH mutations;
- refs outside configured projects are skipped.

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/scripts/deliver.test.ts tests/scripts/delivery-lib.test.ts`

- [ ] **Step 3: Implement** delivery-lib.ts changes, `prLiveState`, and the deliver.ts rewrite per the algorithm block. Keep: pid lock, tick gate, egress guard, sequential per-ref loop, `postWithRetry`, `postComment`, `postDeliveryEvent`, `finishDelivery`, `deliverQueue`, the legacy flow, dry-run semantics.

- [ ] **Step 4: Run to verify they pass**, then the whole scripts suite: `npx vitest run tests/scripts`.

- [ ] **Step 5: Full gates, then commit**

```bash
npm run typecheck && npm run build:ui && npx vitest run
git add -A scripts tests
git commit -m "feat: deliver.ts triggers from the delivery-attempts ledger — cursor + feedGap deleted (SYD-208)"
```

---

### Task 7: Final verification, PR, board

- [ ] **Step 1:** `npm run typecheck && npm run build:ui && npx vitest run` — all green, full counts in the transcript.
- [ ] **Step 2:** Self-review the diff against the spec section (`git diff origin/main --stat`, then read the risky hunks): every spec property has a test — no-spin, retract-disarm, rollout-both-kinds, once-only backfill, moved-head rejection (stamp AND Retry), no-re-merge, live resumption, deploy-only retry bounds.
- [ ] **Step 3:** Push `feat/syd-208-delivery-ledger`, open PR titled `SYD-208: delivery_attempts ledger — SHA-pinned authorizations replace the deliver cursor`, body summarizing the above + rollout notes (deploy order: tracker deploy runs `ensureRolloutBackfill` at boot; worker host pulls after).
- [ ] **Step 4:** Comment the verification evidence on SYD-208 and move it to `in_review` (never `done`).

## Rollout notes (for the PR body)

- Deploying the tracker runs `ensureRolloutBackfill` at startup — every historical done-stamp (latest per issue) and `redeliver_requested` gets a `skipped_rollout` row before the first `/delivery-work` read; day one fires nothing.
- The worker host must pull the same commit before its next deliver tick: the old worker's `/api/events` cursor loop keeps working until then (routes unchanged), but the UI will already be sending pinned stamps — old worker + new tracker is safe (stamps just sit as pending authorizations the old worker also sees as events; brief double-coverage window ends at worker restart). Deploy tracker and kickstart the deliver worker in the same maintenance window.
- `.superpowers/deliver-cursor` on the worker host becomes dead; delete it after go-live.
