# SYD-281 Human-Act Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a human-only gate actually require a human act, by splitting the three questions a supervised `Principal` currently conflates — who authorizes, whose credential, whose name goes on the row.

**Architecture:** Three accessors in `src/services/principal.ts`. `asHuman` returns a branded `HumanActor` or null (null inside a supervised session). `actingAgent` resolves the agent whose claim and lease govern the write. `effectiveActor` is the identity written to row-identity columns, and fails closed. Human-only services take `HumanActor`; mixed services take a required `ctx: Attribution` and apply a per-line predicate table. Adapters mint, services demand.

**Tech Stack:** TypeScript, drizzle-orm + better-sqlite3, hono (REST), @modelcontextprotocol/sdk, vitest.

**Spec:** `docs/superpowers/specs/2026-08-27-human-act-integrity-design.md` (revision 5, approved by a seven-seat panel over four rounds; findings in `docs/reviews/2026-08-27-syd281-panel.md`).

## Global Constraints

- **All business logic in `src/services/*`.** MCP, REST, and UI are thin adapters. Services throw `SwitchyardError` for user-facing failures.
- **`ctx: Attribution` is required — no default — on every function that calls an accessor.** The `= {}` default is the fail-open this work removes.
- **`effectiveActor` is for row-identity columns only** (`assigneeId`, `creatorId`, `declaredBy`, `claim_leases.actorId`). It must **never** replace `events.actorId`, `pendingActions.affirmedById`, or `attachments.actorId`.
- **Resolve `effectiveActor` once at function entry**, not per branch — otherwise fail-closed is branch-dependent.
- **Never `as HumanActor`** outside `principal.ts` and the single CLI mint. Never a bare `{}` as `ctx` — use `NO_SESSION`.
- Branch `feat/syd-281-human-act-integrity`, worktree `/Users/sean/sites/switchyard-syd281`. Commit messages reference `(SYD-281)`.
- Before the PR: `npm run lint && npm run format:check && npm run typecheck && npm test`.

---

### Task 1: The three accessors

**Files:**
- Modify: `src/services/principal.ts`
- Modify: `src/services/attribution.ts`
- Test: `tests/services/principal.test.ts` (create)

**Interfaces:**
- Produces: `HumanActor` (branded `Actor`), `asHuman(actor, ctx): HumanActor | null`, `actingAgent(db, actor, ctx): Actor | null`, `effectiveActor(db, actor, ctx): Actor` (throws when ctx is supervised and no agent resolves), `NO_SESSION: Attribution`.

- [ ] **Step 1: Write the failing tests** in `tests/services/principal.test.ts` covering: `asHuman` returns a value for an unsupervised human and null when `sessionId` or `viaAgentId` is set or the actor is not human; `actingAgent` returns the agent for a plain agent actor, resolves `viaAgentId` from the db, returns null on a missing row and on a row no longer typed `agent`; `effectiveActor` returns the resolved agent, returns the actor when ctx is empty, and **throws** when ctx is supervised and the agent row is missing or retyped.
- [ ] **Step 2: Run `npx vitest run tests/services/principal.test.ts`** — expect failures for undefined exports.
- [ ] **Step 3: Implement** the three accessors and `NO_SESSION` per the spec's "The identity rule" section. `actingAgent` uses an inline `db.select().from(actors)` (not `getActorById`, which takes `Db` not `DbOrTx` and throws on a missing row).
- [ ] **Step 4: Run the test file** — expect PASS.
- [ ] **Step 5: Commit** `feat: three accessors splitting authorization, credential and row identity (SYD-281)`.

---

### Task 2: Thread `Principal` into the MCP adapter

**Files:**
- Modify: `src/mcp/server.ts` (`buildMcpServer` signature), `src/server.ts:94-101`
- Test: `tests/mcp/supervised.test.ts` (extend if present, else create)

**Interfaces:**
- Consumes: Task 1's accessors.
- Produces: `buildMcpServer(db, principal: Principal, attachmentsDir?, connectionLeaseToken?)`. `attribution` and `viaAgent` positional params are removed — derive both from the principal inside.

- [ ] **Step 1: Write a failing test** asserting a supervised MCP connection's `whoami` reports both the accountable human and the acting agent.
- [ ] **Step 2: Run it** — expect FAIL.
- [ ] **Step 3: Change `buildMcpServer` to take a `Principal`**; inside, derive `const attribution = attributionOf(principal)` and `const viaAgent = principal.viaAgent`. Update `src/server.ts` to pass `principal ?? { actor }`. Collapse `mcp/server.ts:417`'s `viaAgent ?? actor` to `effectiveActor(db, actor, attribution)` — behaviourally identical, preserving `events.actorId` as the agent for progress notes.
- [ ] **Step 4: Run `npx vitest run tests/mcp/`** — expect PASS.
- [ ] **Step 5: Commit** `refactor: buildMcpServer takes a Principal (SYD-281)`.

---

### Task 3: Population A — human-only services take `HumanActor`

**Files:**
- Modify: `src/services/settings.ts`, `actors.ts`, `projects.ts`, `webhooks.ts`, `github-repos.ts`, `triage-actions.ts`, `affirmation-keys.ts`, `hard-gate.ts`, `pr-links.ts` (`confirmPrLink`, `backfillPrLinksFromPrState`), `supervised-sessions.ts`, `src/rest/api-routes.ts`, `src/rest/pending-actions.ts` (`:69`, `:138` only), `src/cli.ts`, `src/services/linear-import.ts`
- Test: `tests/rest/api-settings.test.ts`, `tests/rest/api-projects.test.ts` (extend); delete the service-level agent-refusal tests they replace

- [ ] **Step 1: Write failing adapter tests** asserting an agent bearer is refused at the REST boundary for settings, projects, webhooks, github-repos, triage-actions and actors.
- [ ] **Step 2: Run them** — some pass already; note which fail.
- [ ] **Step 3: Change the population-A signatures** to `HumanActor`, delete the six private `requireHuman` helpers (`settings.ts:113`, `actors.ts:12`, `projects.ts:11`, `webhooks.ts:10`, `github-repos.ts:23`, `triage-actions.ts:45`), and make `requireHumanCaller` return `HumanActor`. **Keep** the inline checks in `affirmPendingAction` (`hard-gate.ts:91-95`) and `openSupervisedSession` (`supervised-sessions.ts:24-27`) — they are roots of trust. Add a `requireHumanActor` helper in `cli.ts` returning `HumanActor`, used by `cliActor` and `linear-import.ts:352`.
- [ ] **Step 4: Delete** `tests/services/settings.test.ts:95-99` and `tests/services/projects.test.ts:32-52` (and the same shape in webhooks/github-repos/triage-actions/actors service tests) — replaced by the adapter tests. **No `as HumanActor` in any test.**
- [ ] **Step 5: Run `npm run typecheck && npx vitest run`** — expect PASS.
- [ ] **Step 6: Commit** `feat: human-only services demand a HumanActor the adapter minted (SYD-281)`.

---

### Task 4: `pr-links.ts` predicate table (closes SYD-298)

**Files:**
- Modify: `src/services/pr-links.ts` (`:241-254`, `:289`, `:291-292`, `:305`, `:409-421`, `:585`, `:593`, `:598`)
- Test: `tests/services/pr-links-supervised.test.ts` (create), `tests/rest/api-pr-links.test.ts` (extend)

- [ ] **Step 1: Write failing tests** — driven through the **MCP tool** with a real `sup_` token, not by calling `declarePrLink` directly: a supervised declare is refused without a claim, refused without the agent's lease, forces `role: "delivers"`, writes `declaredBy` = the agent, leaves `confirmedBy` null so `provesLanded` is false, **and emits `pr_link_declared` with `confirmed: false`**. Plus: a supervised agent can revoke its own declaration and cannot revoke one the human declared in person. Plus: a `service` actor calling `POST /issues/:ref/pr-links/confirm` is refused.
- [ ] **Step 2: Run them** — expect FAIL.
- [ ] **Step 3: Apply the spec's `pr-links.ts` predicate table** verbatim. `confirmPrLink` moves to population A (Task 3 changed its signature; here change its gate).
- [ ] **Step 4: Run `npx vitest run tests/services/pr-links tests/rest/api-pr-links`** — expect PASS.
- [ ] **Step 5: Commit** `fix: a supervised declaration is a claim, not a human's vouch (SYD-281)`.

---

### Task 5: `issues.ts` — the identity rule and the claim path

**Files:**
- Modify: `src/services/issues.ts` (the 24-row table in the spec), `src/services/needs-input.ts:43-44`
- Test: `tests/services/issues-supervised.test.ts` (create)

- [ ] **Step 1: Write failing tests** through the MCP tool with a `sup_` token: `file_issue` lands in `triage` with provenance required; `update_issue` out of `triage` is refused; adding `auto` is refused; reassigning another actor is refused; `update_issue` with a **status equal to the current status** does not clear `needsInput`; `claim_issue` assigns the **agent** and mints a lease whose `claim_leases.actorId` is the agent, and a subsequent claim-scoped write with that token validates; the bare-PATCH `update_issue {status:"in_progress"}` on an unassigned issue assigns the same agent; an `assigneeOnly` transition on an agent-assigned issue succeeds; a supervised session whose agent row is retyped mid-flight throws on `update_issue {priority}` rather than writing as the human.
- [ ] **Step 2: Run them** — expect FAIL.
- [ ] **Step 3: Implement.** Hoist `const eff = effectiveActor(tx, actor, attr)` once at the top of `updateIssue`, `createIssue`, and `claimIssue`, then apply the spec's `issues.ts` table. Give `assertClaimable` and `assertAssignee` a `ctx: Attribution` parameter and compare `effectiveActor` internally; update their four call sites (`:425`, `:547`, `:632`, `:778`). Event `actorId` at `:693`/`:762` stays `actor.id`.
- [ ] **Step 4: Run `npx vitest run tests/services/issues`** — expect PASS.
- [ ] **Step 5: Commit** `feat: in a supervised session the agent holds the work (SYD-281)`.

---

### Task 6: `comments.ts`, `dependencies.ts`, `agent-sessions.ts`

**Files:**
- Modify: `src/services/comments.ts:44`, `src/services/dependencies.ts:134` + `nextTask:259`, `src/services/agent-sessions.ts:47` + owner tie `:145`
- Test: `tests/services/comments.test.ts`, `tests/services/dependencies.test.ts` (extend)

- [ ] **Step 1: Write failing tests**: a supervised `comment` does not clear `needsInput`; a supervised `remove_dependency` is refused at the registry default and **diverts** once `dependency.remove` is in `supervised.hard_gate_actions` (assert **both**, in this file, so the operator dependency is visible in the diff); `next_task` in a supervised session surfaces an issue the agent holds.
- [ ] **Step 2: Run them** — expect FAIL.
- [ ] **Step 3: Implement.** `comments.ts:44` → `asHuman(...) !== null`. `dependencies.ts:134` → `asHuman(...) === null`. `nextTask`: the assignee leg (`:259`) keys to `effectiveActor`; `isAttendedCaller`/`callerClassification` keep the human. `requireAgent` → `actingAgent(...) !== null`, thread `ctx` into `startAgentSession`/`endAgentSession` and re-key the owner tie at `:145` to `effectiveActor`.
- [ ] **Step 4: Run the two test files** — expect PASS.
- [ ] **Step 5: Commit** `fix: an agent cannot answer its own escalation (SYD-281)`.

---

### Task 7: Supervised-agent namespacing

**Files:**
- Modify: `src/services/supervised-sessions.ts` (`openSupervisedSession`), `src/cli.ts:89-104`
- Test: `tests/services/supervised-sessions.test.ts` (extend)

- [ ] **Step 1: Write failing tests**: `openSupervisedSession(db, human, "claude")` creates an actor named `claude/supervised/<human>` with `attended: true`; an engine argument containing `/` is rejected; binding to an existing dispatch actor is impossible.
- [ ] **Step 2: Run them** — expect FAIL.
- [ ] **Step 3: Implement.** Derive `<engine>/supervised/<human>` (engine first, so `callerClassification`'s `split("/")[0]` still yields the engine). Pass `attended: true` when creating. Reject `/` in the engine argument and update the CLI usage string.
- [ ] **Step 4: Run the test file** — expect PASS.
- [ ] **Step 5: Commit** `fix: a supervised session cannot borrow a dispatch worker's identity (SYD-281)`.

---

### Task 8: The migration

**Files:**
- Create: `src/services/supervised-claim-cutover.ts`
- Modify: `src/db/schema.ts` (marker table), `src/server.ts` (wire after `ensureClaimLeaseCutover`)
- Test: `tests/services/supervised-claim-cutover.test.ts` (create)

- [ ] **Step 1: Write failing tests**: a pre-existing supervised claim (selected by its latest `assigned` event's `sessionId`) is released to `todo`/unassigned with its lease invalidated, and the agent can then re-claim **and perform a holder mutation with the re-minted token without throwing**; an in-person human claim in the same fixture is left untouched; open supervised sessions are soft-closed; running twice changes nothing.
- [ ] **Step 2: Run them** — expect FAIL.
- [ ] **Step 3: Implement** per the spec's Migration section: marker-guarded, selects on the `assigned` event's `sessionId`, sets `status→todo` and `assigneeId→null`, calls `invalidateLease(tx, issue.id)` **in the same transaction**, records `claim_released`, and soft-closes open supervised sessions. Generate the marker table migration with `npm run db:generate`.
- [ ] **Step 4: Run the test file** — expect PASS.
- [ ] **Step 5: Commit** `feat: reset supervised claims to the new holder identity (SYD-281)`.

---

### Task 9: The lint rule

**Files:**
- Modify: `eslint.config.js`
- Test: none (lint is its own check)

- [ ] **Step 1: Add a `no-restricted-syntax` rule** banning `TSAsExpression` to `HumanActor` outside `src/services/principal.ts` and `src/cli.ts`, and banning an empty `ObjectExpression` passed where `ctx` is expected — permitting `NO_SESSION`. Allowlist `src/services/hard-gate.ts`'s two executor sites with their existing comments.
- [ ] **Step 2: Run `npm run lint`** — fix any legitimate hits by switching them to `NO_SESSION`.
- [ ] **Step 3: Commit** `chore: make the wrong choice greppable, not invisible (SYD-281)`.

---

### Task 10: Message sweep and `whoami`

**Files:**
- Modify: error strings in `src/services/issues.ts`, `agent-sessions.ts`, `needs-input.ts`, `comments.ts`; `src/mcp/server.ts` (`whoami`)
- Test: `tests/mcp/whoami.test.ts` (extend)

- [ ] **Step 1: Write a failing test** asserting `whoami` in a supervised session reports both the accountable human and the acting agent.
- [ ] **Step 2: Run it** — expect FAIL.
- [ ] **Step 3: Update `whoami`** and reword the refusal messages that now fire for supervised agents ("Only humans move issues out of triage", "Only agent actors record progress notes", the `needs-input` assignee message, and `comments.ts`'s refusal) so they explain the supervised case.
- [ ] **Step 4: Run the test** — expect PASS.
- [ ] **Step 5: Run the full gate** `npm run lint && npm run format:check && npm run typecheck && npm test`.
- [ ] **Step 6: Commit** `docs: say why a supervised session was refused (SYD-281)`.

---

## Self-review notes

- **Spec coverage:** every section of revision 5 maps to a task — accessors (1), MCP threading (2), population A (3), pr-links table (4), issues table + claim path (5), populations B remainder (6), namespacing (7), migration (8), lint (9), sweep (10). The REST residual and the operator settings step are documentation, carried in the PR description rather than code.
- **Not in scope, by decision:** `delivery-events.ts`, `delivery-attempts.ts`, `api-routes.ts:672` — REST-only, `ctx` always empty, no reachable gain. `attachments.actorId` stays the human. Population C is untouched.
- **Still open after this work:** SYD-298 closes only when Task 4's service-token refusal test passes; do not close it before.
- **PR must state:** the operator settings write (`supervised.hard_gate_actions` → `["done","dependency.remove"]`), that it fails closed without it, the workers-down precondition for the migration, and the `done_without_merged_pr` second-order effect.
