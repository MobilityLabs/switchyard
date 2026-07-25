# Per-column WIP limits (design)

- **Date:** 2026-07-14
- **Status:** Draft — awaiting review
- **Requested by:** Sean, 2026-07-14: "a configurable limit for how many issues can sit in any one column before we stop working on items … having 10 items that need to be merged isn't ideal so maybe a default of 5."

## Goal

Give each board column (issue **status**) an optional work-in-progress (WIP)
limit. When a project's column is at or over its limit, the dispatch worker
**stops starting new work** for that project (`todo → in_progress`) until the
column drains. This is Kanban back-pressure: if the merge backlog (`in_review`)
is deep, finishing more sessions only makes it worse, so pause the pull.

## Decisions (settled with Sean, 2026-07-14)

1. **Back-pressure on agents only.** Hitting a limit pauses *agent dispatch* of
   new work. Humans move cards freely; the delivery worker keeps draining
   `in_review`; answer sessions are unaffected. It is **not** a hard transition
   guard — nothing rejects a human (or the delivery flow) moving an issue into a
   full column.
2. **Any column individually configurable.** A per-status limit. Ships with
   `in_review` defaulting to **5** and every other status **off**.
3. **`0` = unlimited / off** is the sentinel.
4. **Per-project counts.** A column's fullness is counted within each project's
   own board. `SYD` `in_review` at 5/5 pauses new `SYD` dispatch but not `NOC`.
5. **Counts exposed by extending the worker-facing dispatch-policy** (not a new
   endpoint).
6. **Board badge deferred.** The core back-pressure ships first; a `5/5`
   over-limit column badge in the web UI is a follow-up.

## Non-goals

- Hard/server-enforced transition blocking (rejecting `PATCH status→X` when X is
  full) — explicitly chosen against in favor of back-pressure.
- Limiting/altering human actions, the delivery worker, or answer sessions.
- Per-worker or per-engine limits (this is a per-project board property, shared
  by every engine's worker).
- The board-column badge UI (follow-up).

## Background: what exists

- **Statuses** (`STATUSES`, `src/db/schema.ts`): `triage, backlog, todo,
  in_progress, in_review, done, canceled`.
- **Settings registry** (`src/services/settings.ts`): typed entries with
  defaults, human-only to change (`requireHuman`). The `dispatch.*` group
  (`max_concurrent`, `poll_seconds`, …) is the **worker-facing subset**, served
  by `GET /api/dispatch-policy` (`getDispatchPolicy` → `DispatchPolicy`), read by
  the worker each tick (`refreshDispatchPolicy` → `applyDispatchPolicy`,
  `scripts/worker-select.ts`).
- **Dispatch selection** (`selectDispatchable`, `scripts/worker-select.ts`): pure
  filter over `todo` issues — project match, unassigned, not needs-input, not
  dependency-blocked, no open agent PR. Unit-tested. The WIP gate is one more
  filter here.
- **Worker tick** (`runTick`, `scripts/agent-worker.ts`): fetches ready issues,
  filters, claims host-side, dispatches.

## Design

### A. Settings — `wip.limit.<status>`

Add one registry entry per meaningful status (at minimum `in_review`,
`in_progress`; including all non-terminal statuses is fine and uniform):

```
"wip.limit.in_review":   { type: "number", default: 5 },
"wip.limit.in_progress": { type: "number", default: 0 },
"wip.limit.todo":        { type: "number", default: 0 },
...                                        // 0 = unlimited
```

Human-only to change (inherits the registry's `requireHuman`). Validation:
reject negative values.

### B. Worker-facing exposure

Extend `DispatchPolicy` (`getDispatchPolicy`) and the `GET /api/dispatch-policy`
payload with:

- `wipLimits: { [status]: number }` — the configured limits (0 omitted or kept, implementer's choice; keep it simple).
- `columnCounts: { [projectKey]: { [status]: number } }` — current per-project
  per-status open-issue counts, from a new service `boardColumnCounts(db)`.

`boardColumnCounts` is a single grouped count query over `issues` (by project,
by status). Terminal columns (`done`, `canceled`) may be excluded from counting
since they're never limited in practice, but counting them is harmless.

`applyDispatchPolicy` overlays `wipLimits` (and the worker reads `columnCounts`)
onto the in-memory `WorkerConfig`/tick state, same pattern as the existing
`dispatch.*` overlay.

### C. The gate — pure + tested

New pure helper (in `worker-select.ts`, next to `selectDispatchable`):

```
projectsBlockedByWip(
  columnCounts: Record<string, Record<string, number>>,
  wipLimits: Record<string, number>,
): Set<string>   // project keys where SOME status count >= its (nonzero) limit
```

`selectDispatchable` (or `runTick` just before it) takes the blocked set and
**skips `todo` issues whose project is blocked**, logging the suppression once
per blocked project per tick (no silent cap — e.g.
`WIP limit: pausing SYD dispatch — in_review 5/5`).

### D. Scope of effect

Only the **code-role work-dispatch** path (`todo → in_progress`) consults the
gate. Answer sessions (`drainUnansweredQuestions`), the delivery worker
(`deliver.ts`), and every human/REST/MCP transition are untouched.

## Testing

- `projectsBlockedByWip`: under / at / over limit; `0`=off ignored; per-project
  isolation (one project blocked, another not); multiple columns over at once.
- `boardColumnCounts`: counts by project+status; ignores other projects; a
  freshly-moved issue changes its column's count.
- Settings: `wip.limit.in_review` default is 5; others 0; negative rejected;
  human-only.
- `selectDispatchable`/`runTick`: a `todo` issue in a blocked project is
  suppressed (and logged); the same issue dispatches once the column drains.

## Rollout

Server-side settings + `dispatch-policy` fields require a **tracker redeploy**
(`npm run deploy`, NAS); the worker gate ships with a worker-host `git pull` +
restart. Default `in_review = 5` takes effect immediately on deploy; set other
columns' limits via the settings API/UI as desired.
