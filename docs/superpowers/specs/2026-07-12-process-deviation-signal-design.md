# Server-side process-deviation attention signal (SYD-188)

**Status:** design approved 2026-07-12
**Issue:** SYD-188
**Files touched (anticipated):** `src/services/deviation.ts` (new), `src/services/attention.ts`, `src/services/pr-status.ts`, `src/services/webhook-dispatcher.ts`, `src/services/settings.ts`, `ui/src/types.ts`, `ui/src/views/Board.tsx`, `ui/src/views/Review.tsx`, `ui/src/views/IssueDetail.tsx`, plus tests.

## Why

The board process (`claim → in_progress → PR → in_review → human stamps done`) is
enforced only at each mutation. Nothing flags an issue that has *drifted* out of
process — e.g. a PR is open but the issue is still `in_progress`. In the SYD-182
session this exact drift happened (PR opened, issue left `in_progress`) and only a
human caught it.

Switchyard already derives its `attention` / open-PR / unanswered-question signals
from the append-only `events` log rather than storing them (`src/services/attention.ts`,
`src/services/pr-status.ts`), and already ingests GitHub PR webhooks and fans **every**
new `events` row out to registered webhooks (`src/services/webhook-dispatcher.ts`). So
the server already holds every fact needed to detect drift. We derive a deviation
signal there — the architecturally correct "standing monitor" — rather than bolt an
external poller onto the outside.

## Scope decisions (resolved during brainstorming)

1. **Signal shape — extend the `attention` union.** Deviation reasons fold into the
   existing single `attention` flag as a discriminated union. `getAttention` returns
   the highest-priority reason. One field, one chip; every existing consumer picks up
   deviations for free. (Alternative — a separate `deviation` field/chip — rejected as
   more surfaces to wire for no semantic gain.)
2. **Webhook push — yes, via a deduped `process_deviation` event.** Emitted once per
   drift episode from the dispatcher tick so it fans out through the existing webhook
   path ("push not poll"). Dedup is derived from events; no stored "already notified"
   column.
3. **Stale-claim threshold — warn earlier than auto-release.** A new
   `claims.deviation_seconds` (default 3600 = 1h) flags a claim as going stale *before*
   the existing 4h `claims.stale_seconds` auto-release (`releaseStaleClaims`) reclaims
   it — so the signal is actionable (the session can post a `progress_note` and keep
   the claim) rather than firing exactly as the claim vanishes.

## Constraints (from the issue + CLAUDE.md)

- **Derive, don't store.** No new stored, drift-prone column. The deviation *state* is
  always computed from `events` + issue status + PR status. The only rows we write are
  `process_deviation` audit/notification events (see below), which are legitimate
  records of "drift detected at time T", not a materialized state cache.
- **No autonomous board mutation.** The signal only flags. A human or a session
  advances the issue. (This service must never change issue `status`/`assignee`.)
- **Keep tests** covering each deviation case and its negative case.

## Architecture

### 1. `src/services/deviation.ts` (new) — pure derivation

Mirrors the shape of `attention.ts` / `pr-status.ts`: standalone functions over `Db`,
no stored column, safe to call on read.

```ts
export type DeviationReason =
  | "open_pr_not_in_review"
  | "merged_pr_not_done"
  | "stale_claim";

export type DeviationFlag = { reason: DeviationReason; message: string };

export function getDeviation(db: Db, issueId: number): DeviationFlag | null;
export function listDeviationByIssueId(db: Db): Map<number, DeviationFlag>;
```

Derivation per reason (all facts already available):

| reason | condition |
|---|---|
| `open_pr_not_in_review` | issue.status ∈ {`todo`, `in_progress`} **and** `getOpenPr(db, id)` ≠ null |
| `merged_pr_not_done` | issue.status = `in_review` **and** issue has a merge event (`gh_pr_merged` or `delivered`) **and** `getOpenPr(db, id)` = null |
| `stale_claim` | issue.status = `in_progress` **and** `!needsInput` **and** `now − MAX(events.createdAt) > claims.deviation_seconds` |

- Priority when several apply to one issue:
  `merged_pr_not_done` > `open_pr_not_in_review` > `stale_claim`.
- Idle computation for `stale_claim` mirrors `releaseStaleClaims`: newest event
  `createdAt` (fall back to `issue.createdAt`), compared to `now − deviation_seconds`.
  `needsInput` issues are skipped (an agent that escalated correctly is waiting on a
  human, not idling) — same carve-out the auto-release uses.
- Messages are human-readable and name the PR number / status, e.g.
  `"PR #41 is open but issue is in_progress — move it to in_review"`,
  `"PR #41 is merged — a human can stamp this done"`,
  `"claimed but idle for ~1h — post a progress note or release the claim"`.

`merged_pr_not_done` needs a small "issue has a merged PR" derivation. Add a helper in
`pr-status.ts` (keeps all PR-lifecycle derivation in one module), e.g.
`hasMergedPr(db, issueId): boolean` — true when a `gh_pr_merged`/`delivered` event
exists for the issue. Combined with `getOpenPr === null` and `status === in_review` this
is unambiguous (an old merge followed by a new open PR yields `getOpenPr !== null`, so
`merged_pr_not_done` does not fire; and an `in_review` issue with an open PR is the
*correct* state, not a deviation).

### 2. `src/services/attention.ts` — aggregator

Widen the exported type to a discriminated union and compose the deviation source:

```ts
export type AttentionFlag =
  | { reason: "delivery_failed"; message: string }
  | { reason: "merged_pr_not_done"; message: string }
  | { reason: "open_pr_not_in_review"; message: string }
  | { reason: "stale_claim"; message: string };
```

- `getAttention(db, id)`: return the existing `delivery_failed` flag first (the hard
  error keeps top priority); otherwise `getDeviation(db, id)`.
- `listAttentionByIssueId(db)`: merge the delivery-failure map with
  `listDeviationByIssueId(db)`; `delivery_failed` wins on collision.

No change to any consumer's call site or the issue shape — REST list/detail
(`src/rest/api-routes.ts`), MCP `get_issue` / `search_issues` (`src/mcp/server.ts`), and
the `attention` search filter (`src/services/search.ts`) all read `attention` and now
receive deviations automatically.

**Deliberate consequence:** the `attention` search filter (`search_issues attention:true`)
now also returns process-drifted issues. This is intended — the separately-filed
in-session layer (`/syd-watch` + Stop hook) queries `attention=true` to read this signal
cheaply. The Board "errors" filter in the Done column checks `reason === "delivery_failed"`
specifically and is therefore unaffected.

### 3. UI — chip switches on `reason`

- `ui/src/types.ts`: widen the `attention` field to the same union.
- `Board.tsx`, `Review.tsx`, `IssueDetail.tsx`: map `reason` → `(label, severity)`.
  `delivery_failed` keeps its red `danger` chip (⛔ delivery failed). The three
  deviation reasons render as a softer `warning` nudge chip:
  - `open_pr_not_in_review` → "⚠ PR open — move to review"
  - `merged_pr_not_done` → "⚠ merged — stamp done"
  - `stale_claim` → "⚠ claim going stale"
- A small helper (e.g. `attentionChip(attention)` → `{ text, className, title }`) keeps
  the three views consistent and is the single place the reason→label map lives.
  `title` uses `attention.message`.

### 4. Webhook push — `process_deviation` event, once per episode

New `emitProcessDeviations(db)` called each tick in `startWebhookDispatcher` alongside
`releaseStaleClaims` (wrapped in its own try/catch so a failure can't stop the sweep).

For every currently-drifting issue (from the same derivation as §1), record a
`process_deviation` event **only if one has not already been recorded for this
(issue, reason) since the current episode began**:

- Episode-start marker per reason:
  - `open_pr_not_in_review` → the id of the open PR's opening event (`pr_opened`/`gh_pr_opened` for that prNumber).
  - `merged_pr_not_done` → the id of the merge event (`gh_pr_merged`/`delivered`).
  - `stale_claim` → the id of the claim start (latest `status_changed` to `in_progress`, i.e. the current claim).
- Emit iff `NOT EXISTS (process_deviation event for this issue with this reason AND id > episodeStart)`.

This makes emission exactly-once per episode and **self-re-arming**: when the drift
resolves (issue moves to `in_review`, PR merges, claim released) and later re-drifts, a
new episode-start id is higher than the last `process_deviation`, so a fresh event
emits. No stored "already notified" flag is needed.

- `payload`: `{ reason, prNumber? }` (prNumber included for the two PR cases).
- `actorId`: `assigneeId ?? creatorId` — mirrors `releaseStaleClaims`.
- `process_deviation` is **not** added to `webhooks.suppressed_events`, so the existing
  dispatcher fans it out to every active (project-scoped) webhook with the standard
  signed payload. It also appears in the issue activity feed — a legitimate audit
  record, kept non-noisy by the once-per-episode dedup.

### 5. Settings

Add to `src/services/settings.ts` defaults: `claims.deviation_seconds = 3600`. Read
fresh each tick (like `claims.stale_seconds`) so a human's change takes effect on the
next sweep.

## Data flow

```
events log ──derive──> deviation.ts (getDeviation / listDeviationByIssueId)
                              │
                    ┌─────────┴──────────┐
                    ▼                    ▼
      attention.ts aggregator     emitProcessDeviations(db)  (dispatcher tick)
      (getAttention / list…)      records process_deviation event (deduped)
                    │                    │
      REST / MCP / UI / search           └─> existing webhook fan-out ──> external consumers
      read `attention` (chip + filter)
```

## Error handling

- `emitProcessDeviations` wraps its work in try/catch (per-issue and top-level) so a
  malformed row or a transient DB error can't kill the `setInterval` sweep — matching
  how `releaseStaleClaims` / `sweepOrphanedAgentSessions` are guarded in
  `startWebhookDispatcher`.
- The service never mutates issue `status`/`assignee` — it only reads and records
  events. (Enforced by review + tests; there is no write path to `issues` in
  `deviation.ts`.)

## Testing

New `tests/services/deviation.test.ts` (and additions to webhook-dispatcher tests):

- **open_pr_not_in_review**: `in_progress`/`todo` + open PR ⇒ flagged; `in_review` +
  open PR ⇒ **not** flagged; no PR ⇒ not flagged.
- **merged_pr_not_done**: `in_review` + merged PR (no open PR) ⇒ flagged; `done` +
  merged ⇒ not flagged; `in_review` + still-open PR ⇒ not flagged.
- **stale_claim**: `in_progress` idle > `deviation_seconds` ⇒ flagged; idle <
  threshold ⇒ not; `needsInput` set ⇒ not; not `in_progress` ⇒ not.
- **attention priority**: an issue with both an unresolved `delivery_failed` and a
  deviation returns `delivery_failed`.
- **webhook dedup**: `emitProcessDeviations` records exactly one `process_deviation`
  per episode across repeated ticks; after the drift resolves and re-drifts, a second
  event is recorded; no event when nothing is drifting.
- Existing `attention` / `pr-status` / webhook-dispatcher tests continue to pass
  (union widening is additive; `delivery_failed` behavior unchanged).

## Out of scope

- The in-session local layer (`/syd-watch` + Stop hook) that consumes this signal —
  filed separately.
- Flagging `todo`-auto-dispatch races (the `dispatch-races-interactive-sessions`
  pattern) as a deviation — adjacent, not part of this issue.
- Any autonomous advancement of an issue's status. The signal only nudges.
