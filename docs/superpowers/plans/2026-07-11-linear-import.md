# Linear Workspace Importer (SYD-37) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `scripts/import-linear.ts` imports a Linear workspace (teams, states, users, issues, comments, relations, labels, embedded/attached files) into a Switchyard db with refs preserved, original authorship/timestamps, a dry-run mode, and idempotent re-runs.

**Architecture:** Three layers matching repo conventions. `scripts/import-linear-lib.ts` is the network adapter (Linear GraphQL client with pagination + authenticated file downloads, `fetch` injectable). `src/services/linear-import.ts` is the business logic (pure mapping functions, plan building, plan execution against a `Db` — writes issues/events directly with explicit `createdAt`, which services can't do, while co-writing the audit log the same way services do). `scripts/import-linear.ts` is the thin CLI (args, env key, wiring, report printing).

**Tech Stack:** TypeScript (tsx), drizzle + better-sqlite3, native `fetch`, vitest. No new dependencies.

## Global Constraints

- `LINEAR_API_KEY` comes from the environment only — never argv (repo security invariant).
- Importer is **read-only against Linear** (queries + file GETs; no mutations).
- Refs preserved: Linear `MOB-123` → Switchyard `MOB-123` (explicit `number`, counter bumped to `max(number)+1` afterward, never decreased).
- Idempotent: issues carry `sourceType: "manual"`, `sourceDetail: "linear:<linear-issue-uuid>"`; re-run skips issues whose `linear:<uuid>` already exists in the target db. Re-run on an already-imported workspace is a no-op.
- Direct `events` writes carry original authorship (imported tokenless human actors) and original timestamps (ISO → unix seconds).
- Dry-run prints the full mapping (projects, state table, users, per-issue lines, deps, attachments) and writes nothing.
- Status mapping by Linear state **type**: `triage→triage`, `backlog→backlog`, `unstarted→todo`, `started→in_progress`, `completed→done`, `canceled→canceled`, `duplicate→canceled`; override: a `started` state whose *name* matches `/review/i` → `in_review`.
- Priority mapping (Linear number): `0→none`, `1→urgent`, `2→high`, `3→medium`, `4→low`.
- Only `blocks`-type relations become dependencies (`issue` blocks `relatedIssue`); `related`/`duplicate`/`similar` are skipped with a warning line.
- Files on `uploads.linear.app` (issue/comment markdown embeds and file-type attachment entities) are downloaded with the API key in the `Authorization` header, re-uploaded via `saveAttachment`, and their URLs rewritten in the stored text. Disallowed extensions keep the original URL + warning. Non-file attachment entities (external links) are appended to the description under an `### Imported links` section.
- Team keys must match Switchyard's `/^[A-Z]{2,10}$/`; otherwise fail with a legible `SwitchyardError` before writing anything.
- Verification gate before any commit: `npm run typecheck && npx vitest run <new tests> && npm test`.

---

## File Structure

- Create: `scripts/import-linear-lib.ts` — `fetchLinearExport(opts)`: paginated GraphQL pulls (workflowStates, users, issues with nested comments/relations/labels/attachments; nested comment pagination per issue when `hasNextPage`), plus `downloadUpload(url, apiKey, fetchImpl)` and `extractUploadUrls(markdown)`.
- Create: `src/services/linear-import.ts` — types (`LinearExport`, `ImportPlan`, `ImportReport`), `mapStateToStatus`, `mapPriority`, `buildImportPlan(db, data)`, `executeImportPlan(db, plan, deps)` where `deps = { download: (url) => Promise<{ data: Buffer } | null> }`.
- Create: `scripts/import-linear.ts` — CLI: `npx tsx scripts/import-linear.ts <db-path> [--dry-run] [--team KEY]`.
- Test: `tests/services/linear-import.test.ts` — mapping + plan + execution + idempotency against `openDb(":memory:")` fixtures.
- Test: `tests/scripts/import-linear-lib.test.ts` — GraphQL pagination and download auth with mocked `fetch`; URL extraction.

## Key Interfaces

```ts
// src/services/linear-import.ts
export type LinearState = { id: string; name: string; type: string; teamKey: string };
export type LinearUser = { id: string; name: string; displayName: string; email: string; active: boolean };
export type LinearComment = { id: string; body: string; authorId: string | null; createdAt: string };
export type LinearRelation = { type: string; relatedIdentifier: string };
export type LinearAttachment = { id: string; title: string; url: string };
export type LinearIssue = {
  id: string; identifier: string; number: number; teamKey: string;
  title: string; description: string; priority: number;
  stateName: string; stateType: string;
  assigneeId: string | null; creatorId: string | null;
  labels: string[]; parentIdentifier: string | null;
  createdAt: string; updatedAt: string;
  comments: LinearComment[]; relations: LinearRelation[]; attachments: LinearAttachment[];
};
export type LinearTeam = { id: string; key: string; name: string };
export type LinearExport = {
  orgName: string; orgUrlKey: string;
  teams: LinearTeam[]; states: LinearState[]; users: LinearUser[]; issues: LinearIssue[];
};

export function mapStateToStatus(state: { name: string; type: string }): Status;
export function mapPriority(p: number): Priority;
export function buildImportPlan(db: Db, data: LinearExport): ImportPlan;   // read-only; computes skips/collisions/warnings
export async function executeImportPlan(db: Db, plan: ImportPlan, deps: ExecuteDeps): Promise<ImportReport>;
export function renderPlan(plan: ImportPlan): string;                      // dry-run text
```

Execution order inside `executeImportPlan` (per project, then per issue ascending by number): create/reuse project → create/reuse tokenless human actors (`getOrCreateActor` by `displayName`) + fallback `linear-import` actor for null authors → insert issue row (explicit number/status/priority/labels/timestamps/provenance, raw description) → `created` event (original creator + createdAt) → download+`saveAttachment` for each upload URL found in description/comments, building `url → /api/attachments/<id>/<file>` map → update description with rewritten URLs + `### Imported links` section → insert `comment` events (rewritten bodies, original author + createdAt, `payload.linearId`) → second pass over all issues: set `parentId`; insert dependency rows + `blocked_by_added` events → bump `nextIssueNumber`.

No single wrapping transaction (nested `db.transaction` in `saveAttachment` would conflict; idempotent re-run is the recovery story). Number collision with a non-Linear-imported existing issue → `SwitchyardError` before any write for that project.

---

### Task 1: Mapping functions (TDD)

Files: `src/services/linear-import.ts`, `tests/services/linear-import.test.ts`

- [ ] Failing tests: state-type table incl. `duplicate→canceled` and `started+/review/i→in_review`; unknown type → `SwitchyardError`; priority table 0–4; out-of-range priority → `none`.
- [ ] Implement `mapStateToStatus`, `mapPriority`. Run tests → green. Commit.

### Task 2: buildImportPlan (TDD)

- [ ] Failing tests on fixture `LinearExport` (2 teams, 5 issues covering: parent/child, blocks relation, labels, comments, upload embeds, invalid team key, already-imported issue in db, number collision):
  plan lists projects (new vs existing), actors, issues with mapped status/priority, skips already-imported (`linear:<id>` in sourceDetail), collision → throws, invalid key → throws, warnings for non-blocks relations.
- [ ] Implement. Green. Commit.

### Task 3: executeImportPlan (TDD)

- [ ] Failing tests: rows written with exact numbers/refs, timestamps preserved (unix seconds of fixture ISO), events authored by imported actors with original createdAt, comments carry `payload.linearId`, deps + `blocked_by_added` recorded, parentId set across projects, counter bumped, upload URLs rewritten (fake `download` returning a PNG buffer), unsupported extension keeps URL + warning, link attachments appended, second run over same data → report `{skipped: n, created: 0}` and identical row counts (no-op).
- [ ] Implement with `deps.download` injected. Green. Commit.

### Task 4: Linear client lib (TDD)

Files: `scripts/import-linear-lib.ts`, `tests/scripts/import-linear-lib.test.ts`

- [ ] Failing tests with mocked `fetch`: issues pagination follows `pageInfo.endCursor` until `hasNextPage=false`; per-issue comment pagination when nested `hasNextPage`; Authorization header = raw key on both GraphQL and `downloadUpload`; GraphQL errors surface as thrown Error with message; `extractUploadUrls` finds embed + plain-link URLs and ignores non-uploads hosts.
- [ ] Implement `fetchLinearExport` (batched top-level queries, `first: 50` issues, nested `first: 100`), `downloadUpload`, `extractUploadUrls`. Green. Commit.

### Task 5: CLI entry + end-to-end acceptance

Files: `scripts/import-linear.ts`

- [ ] Implement CLI (usage line matching `src/cli.ts` style; `--dry-run`, `--team KEY` filter; key from `process.env.LINEAR_API_KEY`, exit 1 with message if missing; `SwitchyardError` → stderr + exit 1).
- [ ] `npm run typecheck && npm test` — full gates green.
- [ ] Acceptance vs real workspace: dry-run against a scratch db prints full mapping; real run imports MOB-1..4 with refs/numbers preserved, embedded uploads re-uploaded and URLs rewritten, counter at 5; immediate re-run reports all-skipped and identical dump (`sqlite3 .dump` diff or row counts). Verify a description image resolves via `GET /api/attachments/...` locally.
- [ ] Commit; update SYD-37 with verification evidence; move to in_review.
