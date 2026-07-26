# `approved`: separating "I authorized this" from "this shipped"

**Status:** design, revised after two rounds of multi-model review (2026-07-26)
**Author:** interactive session with Sean, 2026-07-26

> **Round-3 note.** Rounds 1–2 established one structural lesson that now governs
> the whole design: **`pr_state` is not the system of record for "this issue has
> code."** It is written only for a strict `agent/<ref>` branch
> (`src/services/github-webhook.ts:216-223`; `src/services/pr-status.ts:9-12`
> states it outright: *"Only attributed rows … ever reach these results.
> Display-only rows … are audit history"*). Interactive `feat/` work — the branch
> convention `CLAUDE.md` prescribes, and the majority of this board's merges —
> produces **display events only** (`github-webhook.ts:259-288`). Round 2 caught
> that the previous revision moved the *evidence* test onto the event log but left
> the *pin* test and the entire completion path on `pr_state`, which would have
> made every interactive issue permanently unclosable. **This revision defines
> both evidence and completion over the event log, with `pr_state` as an optional
> stronger form.**

## Problem

Work that agents finish routinely never reaches `main`, and nothing notices.

SYD-265's audit found **12 issues stamped `done` whose commit is not on `main` by
patch-id, was never pushed, and never had a PR opened** — 5 carrying no attention
flag at all. Eleven were recovered by hand on 2026-07-25/26 (PRs #208–#218); the
twelfth (SYD-253) needed full re-implementation because `main` had moved 100+
commits underneath it.

A 400-event board sample (`1784908790`→`1785076876`, ~47 hours):

| measure | value |
|---|---|
| `delivery_failed` events | 16 |
| `delivered` events | 2 |
| PRs merged | 37 |
| manual `redeliver_requested` | 8 |
| `process_deviation` raised / resolved | 27 / 2 |

Roughly **35 of 37 merges happened outside the delivery worker**, by hand. (The 12
above come from SYD-265's all-time branch audit; the 10 in Migration come from
this 47-hour window — different windows, overlapping sets.)

### The stamp is not the bottleneck

`in_review → done` latency per issue in that window:

```
0h, 0h, 0h, 0h, 0h, 0.1h, 0.1h, 0.1h, 0.2h, 0.5h, 0.6h, 0.6h, 0.7h, 0.8h, 0.9h, 2h
```

Median of that sample **0.15h** (~9 minutes); a separate outlier at 19.8h
(SYD-239) is excluded from the median. Sean approves promptly. Several issues show
`done → merge` as *negative* — the PR was merged by hand first, then stamped.

The rot happens **after** the stamp: **10 of 33** done-stamped issues never reached
`main`; **6 more** landed ~28–29h later, and only because a human recovered them.

### Why: `done` is an absorbing state

- It is in no work queue, so neither dispatch nor `next_task` surfaces it again.
- The delivery queue will not retry it. **Three** independent mechanisms enforce
  once-only, and all three must change together:
  1. `listPendingDeliveryAuthorizations` — `WHERE i.status = 'done' … AND NOT
     EXISTS (… delivery_attempts …)` (`delivery-attempts.ts:99`, `:114`).
  2. `startDeliveryAttempt` — throws *"already has a delivery attempt — once per
     human trigger"* (`delivery-attempts.ts:194-199`, message at `:197`).
  3. `ensureRolloutBackfill` — fences history with `skipped_rollout` rows
     (`delivery-attempts.ts:402-423`), which works *only* because selection is
     `NOT EXISTS (attempt row)`.
- The only signal is `done_without_merged_pr`, 22 unresolved to 2 resolved, and it
  missed 5 of the 12 outright.
- **No agent can pick it back up** — *"only humans reopen a done issue."*

### What the failures actually are

Of the 16 `delivery_failed` events, **one** was a verdict about the work:

| cause | count | work at fault? |
|---|---|---|
| `rebase onto main hit real conflicts` | 6 | no — staleness/contention |
| `a commit landed … after its checks started — disarmed` | 4 | no — SYD-216, unlanded 11 days |
| PR closed unmerged / no branch to rebase | 3 | no — dead-end bookkeeping |
| GitHub 504, `gh pr view` failure | 2 | no — transient infra |
| `required GitHub checks failed` | 1 | **yes** |

## Design

### 0. The merge record (foundation for everything below)

**Definition — a *merge record* for an issue is a recorded `gh_pr_merged` event
on that issue.** It exists for both webhook paths: the attributed path writes it
via `pr-state.ts:218`, the display-only path via `github-webhook.ts:275-276`. Both
arrive through the same HMAC-verified receiver (`github-routes.ts:20-25`,
`timingSafeEqual`), so a display-path record is exactly as trustworthy as an
attributed one. It carries `prNumber` and `mergeSha`.

**`mergeSha` is nullable** at every capture site (`pr-state.ts:218`,
`github-webhook.ts:276`, both from `pr.merge_commit_sha ?? null`). Explicit rule:
**a null `mergeSha` fails closed** — completion is refused — with a named
human-attested override (§3d). Never a silent skip.

`pr_state` remains what it is today: the claim-gating state for agent branches. It
is an *optional stronger form* of the merge record, never the only one.

### 1. State machine

```
triage → backlog → todo → in_progress → in_review → approved → done
                                                        ↑         ↑
                                             human authorizes   merge proven
```

- **`in_review → approved`** is the human authorization, carrying the
  `expected_head_sha` CAS that the done-stamp carries today
  (`src/services/issues.ts:435-453`).
- **The delivery queue triggers on `approved`.**
- **`done` means a merge record proves it landed** (§3).

#### 1a. Code evidence, and which transition it gates

**This test gates `in_review → approved` and any human `→ done`.** (Round 2: the
enforcement point was unstated and an implementer would have guessed.)

**Evidence = a recorded `gh_pr_opened` or `gh_pr_merged` event on the issue.**
That is the only source with backing data. The two sources the previous revision
listed are **dropped**:

- *"a known `agent/<ref>` branch"* — there is no branch table; the only branch
  record is `pr_state.branch`, which exists only once a PR was observed, making it
  redundant with the event source and blind to an unpushed branch.
- *"an agent session that produced commits"* — `agent_sessions`
  (`src/db/schema.ts:343-363`) stores no branch, SHA, or commit count. Read
  loosely it means "any dispatched issue," which would refuse `done` on all of
  them.

| evidence | `done` may be written by |
|---|---|
| a merge record exists | the completion path (§3) — human or service, proof enforced |
| PR evidence but no merge record | **nobody**, until a merge record arrives or the human takes the attested exit (§3d) |
| no evidence at all | a human, **with a required note** (`resolveDeviation`'s shape, `triage-actions.ts:212-216`) |

**Stated plainly, because round 2 caught the previous wording implying otherwise:**
the 12 audited issues score **no evidence** (they never opened a PR), so they take
the note path. The note therefore must *not* ask the human to attest "there is no
code" — that would be false. It asks them to record **why no PR exists for this
work**. The class is not made unrepresentable; it is made **deliberate, attributed,
and audited**, and §6's sweep still alarms on it.

#### 1b. Authorization is a standing grant — bound it

1. **Newest authorization wins.** Selection scopes pin/priorHeads to the most
   recent authorization event, preserving the `MAX(e2.id)` scoping at
   `delivery-attempts.ts:106-111`. "Authorization event" means a `→ approved`
   transition **or** a badge-clear re-authorization (§5) — selection reads both.
2. **Head-moved is terminal.** A pin mismatch or SHA-chain disarm drops the item
   out of automatic selection and demands fresh human re-authorization. It must
   never be classified retryable by SYD-276 and never enter the rebase loop.
3. **Approvals go stale.** Default `delivery.approval_max_age_hours = 72` — raised
   above the 28–29h human-recovery latency this board actually exhibits, because a
   24h default would have expired the six recovered approvals 4–5h *before* the
   human reached them. Enforced **in `startDeliveryAttempt`, in-transaction**
   (`delivery-attempts.ts:179-199`) — the one chokepoint every attempt class passes
   through; selection-SQL-only enforcement is skipped by `resumeAttempt` and
   `runDeployRetry`, which run off separate lists (`scripts/deliver.ts:948-955`).
   **Expiry emits an attention flag** — otherwise it is a new silent-rot class with
   the same shape as the one being replaced.

### 2. Permissions and the affirmation gate

#### 2a. The hard gate follows the authorization

Supervised sessions resolve the acting identity to the bound **human**
(`principal.ts:1-10`, `supervised-sessions.ts:72`), so `actor.type === "human"`
passes for an agent inside one; `hard-gate.ts:19-25` says the gate exists "most
importantly [to stop] agents stamping `done`." Required:

1. Add `"approved"` to `EXECUTABLE_GATE_ACTIONS` (`settings.ts:94`) — the
   validator (`settings.ts:152-157`) otherwise rejects gating it.
2. Change the `supervised.hard_gate_actions` default **and migrate stored rows** —
   `getSetting` returns `row ? row.value : REGISTRY[key].default`
   (`settings.ts:166`), so a deployed `["done"]` row beats a new default.
3. Generalize the executor off its hard-coded `status: "done"`
   (`hard-gate.ts:193`). `EXECUTABLE_GATE_ACTIONS` is `readonly string[]`, so
   `.includes()` narrows nothing — the executor needs an explicit
   `STATUSES.includes(actionKind)` guard or `"dependency.remove"` becomes
   assignable to a `Status` field.
4. Badge-clear gets its own gate entry and executor arm, like `dependency.remove`
   has (`hard-gate.ts:170-183`). See §5.
5. **`done` is removed from `EXECUTABLE_GATE_ACTIONS`** at the same time
   `approved` joins — not merely dropped from the default, so an operator cannot
   re-add it and deadlock the executor against §3's proof.
6. No change needed for the parked payload: `issues.ts:345-350` already carries
   `expectedHeadSha` for *any* status. This is a test to write, not code to change.

Because 1–6 must land together with §3 (a gated `approved` with no completion path
is a stall), **§1a, §2, and §3 are one atomic phase.**

#### 2b. Guards fail closed

- `in_review → approved` uses the `requireHuman` deny-unless-human shape
  (`triage-actions.ts:11-15`), not a `type === "agent"` test — the shape that let
  `service` tokens fall through and forced SYD-213's wholesale denial.
- **The wholesale `service` denials (`issues.ts:179`, `:378`) stay untouched**, and
  the completion path therefore **does not route through `updateIssue`** — see §3.
  The previous revision asserted both "asserts `service` positively" and "the
  denials stay untouched," which cannot both hold; that contradiction is resolved
  in §3's favour.
- The SYD-213 pentest matrix is re-run against the new status: `service` must
  still fail `in_review → approved`, `approved → in_progress`, and every other
  transition.

#### 2c. Delivery authority from state, not assignment

Any issue in `approved` is deliverable regardless of assignee. `assertClaimable`
(`issues.ts:259`) and `assertAssignee` (`:280`) are authoring guards that stop
SYD-93-style double-work; delivery no longer routes through
`AGENT_STATUS_TRANSITIONS` (`:47-57`) at all. Dispatch keeps its own skip of
assigned issues (`worker-select.ts:458`).

### 3. Completion

#### 3a. One named surface

**`completeDelivery(db, actor, ref, mergeSha)`** — a dedicated service function
that:

- leaves `issues.ts:378`'s service denial untouched (it is not `updateIssue`);
- accepts **human or service** — enforcement is on the transition, not the actor
  type, because `resolveInfraToken` falls back to `SWITCHYARD_TOKEN`
  (`delivery-lib.ts:23-25`), so a single-token deployment authenticates the worker
  as a human, and a `service`-positive assertion would make such installs unable to
  complete anything;
- writes the status change through the same internal path `updateIssue` uses, so
  the event log stays co-written;
- records which observation drove it.

Invoked from (a) the webhook/poller's merged transition and (b) a delivery-worker
endpoint.

#### 3b. The proof

1. A **merge record** exists for the issue (§0) — `gh_pr_merged`, either path.
2. `mergeSha` on that record is non-null and **equals** the supplied SHA.
3. The merge record's `prNumber` equals the authorization pin's PR number **when a
   pin exists**; otherwise equals the merge record's own PR number (the
   interactive case, where no pin can exist).
4. The supplied SHA matches `/^[0-9a-f]{40}$/` before it reaches an event payload
   the UI renders and `json_extract` queries.

Rule 2 needs the SHA from `json_extract(payload, '$.mergeSha')` on the
`gh_pr_merged` event — **there is no merge-commit column**: `pr_state` is `repo,
prNumber, branch, issueRef, status, headSha, ghUpdatedAt, url,
lastTransitionEventId, updatedAt` (`schema.ts:255-275`) and `getMergedPr` returns
`{ prNumber, eventId }` (`pr-status.ts:101`). Adding a `merge_commit_sha` column
to `pr_state` is an acceptable alternative for the attributed path, but the event
read is required regardless, because it is the only record interactive work has.

#### 3c. Ordering, and the webhook race

**`done` is written at merge-proof time, before the deploy step.** This is
load-bearing twice over:

- It closes the third-list overlap. `listDeployRetries` selects authorizations
  whose latest *finished* attempt is `merged_deploy_failed`, which has no
  unfinished attempt and so passes §4's new `pending` filter too; `deliver.ts:948-955`
  runs `unfinished`, `pending`, `deployRetries` sequentially. Writing `done` at
  proof time means the issue has left `approved` before any deploy failure, so it
  cannot be freshly re-delivered.
- It resolves the worker/webhook TOCTOU. The worker merges synchronously and would
  beat the async webhook, so a `pr_state`-only proof would reject a successful
  merge and record a spurious failure. **The worker does not assert completion from
  its own knowledge**; it finishes its attempt, and completion is driven by the
  merge record. To avoid waiting on webhook latency, `completeDelivery` may
  **synchronously read live GitHub state** when no merge record is present yet —
  the same live-state consultation `resumeAttempt` already performs — and record
  the resulting merge event itself.

#### 3d. Exits, so no state is a dead end

- **PR evidence, no merge record, and the human knows it landed anyway** (or the
  PR was closed deliberately): a human + required note completes or cancels. A
  guard with no exit is a guard people route around.
- **Closed pins are not a dead end.** `deliveryPinFor` returns `closed` pins too
  (`pr-status.ts:72-84`), which is 3 of the 16 sampled failures; those reach
  `canceled` or an attested `done` via the same note path.

### 4. Retry model

- **Many attempts per authorization** — the once-per-trigger guard
  (`delivery-attempts.ts:194-199`) is replaced by backoff from the latest attempt
  row. **Refuse when the latest attempt is unfinished** (there is no `finishedAt`
  to compute from), since the service-side guard is the only real enforcement.
- **Selection excludes in-flight work** —
  `AND NOT EXISTS (… delivery_attempts WHERE finished_at IS NULL)`.
- **Deploy retries get their own counter** — `listDeployRetries`' `COUNT(*)`
  (`delivery-attempts.ts:376`) gains `AND c.outcome = 'merged_deploy_failed'`.
  Verified arithmetic with deploy-class-only counting: n=1 → `0<3` wait 300s; n=2 →
  `1<3` wait 600s; n=3 → `2<3` wait 1200s; n=4 → stop. Exactly
  `MAX_DEPLOY_RETRIES = 3`, `retryNumber` stays 1-based. Without the fix, k=3
  non-deploy failures make the deploy attempt #4 → `4-1=3`, not `< 3` → no retry
  ever.
- **Transient retries need an attempt cap**, not just the time bound — the 72h
  staleness window otherwise permits a great many GitHub API attempts against a
  persistently-failing transient class.
- **Rollout fence** — `ensureRolloutBackfill`'s `skipped_rollout` rows become
  no-ops under state-based selection; re-express the fence, or guarantee no
  historical issue is in `approved` (which the §Migration landing in `in_review`
  does).

### 5. Conflicts and the badge

**Step 1 — re-rebase, free.** After each merge, re-rebase remaining `approved`
items; bounded attempts.

**Step 2 — badge.** On exhaustion the issue stays in `approved` carrying
`needs_manual_rebase` with the conflicted file list, skipped by selection until
cleared. **Cap the file list** (first N + a count): those paths come from
`git diff --name-only --diff-filter=U` (`delivery-lib.ts:563`), are
agent-influenceable, and are unbounded — a wide rebase conflicts on hundreds of
files, all landing in an event payload and a rendered banner.

**Badge-clear is a distinct, gated re-authorization.** The previous revision made
it "a fresh `→ approved` event," which cannot work: `updateIssue` enters the status
branch only when `patch.status !== current.status` (`issues.ts:396`), and the item
is *already* `approved`, so it would record **no event** — leaving selection bound
to the pre-force-push authorization and making the human's CAS theater. The
hard-gate divert carries the same condition (`issues.ts:316`), so it would also
escape the gate §2a just secured, letting an absorbed agent force-push and
self-re-authorize. Instead, badge-clear:

- has **its own event type**, on the `redeliver_requested` precedent
  (`triage-actions.ts:103`), carrying the new head;
- is read by §1b rule 1's "newest authorization wins" alongside `→ approved`;
- is **human-only, note-required, and CAS'd on the current head**
  (`triage-actions.ts:134-143`'s shape), refused when the PR is closed;
- is **routed through the hard gate** with its own `EXECUTABLE_GATE_ACTIONS` entry
  and executor arm.
- Under webhook/poller lag the recorded head trails the human's push; surface
  *"recorded head hasn't caught up to your push yet"* (`triage-actions.ts:129-132`'s
  message shape) rather than a bare mismatch.

**Note:** `redeliverIssue` has this same ungated-supervised-human gap **today**.
Fixing both in one pass is cheaper than fixing one.

**No automated conflict-resolver in v1** — SYD-163 recorded three resolver sessions
back to back whose resolutions all went stale; SYD-164 concluded a resolver must
hold the ref's queue slot.

**Transient failures never badge** — depends on **SYD-276**, a hard prerequisite.

**New storage:** `AttentionFlag` is a closed union (`attention.ts:40`,
`DeviationReason` at `deviation.ts:24`), duplicated in `ui/src/types.ts:47-53` and
switched exhaustively in `ui/src/attention.ts:10-21`; `DELIVERY_OUTCOMES`
(`schema.ts:287-296`) has `conflict_bounced` but no "gave up" or environment
outcome.

### 6. Detection: rewritten, not narrowed

Round 2 found two independent defects in the previous revision's treatment, both
of which would have removed the safety net:

1. **The recording site dies.** `doneWithoutMergedPr` is scoped
   `fromStatus !== "in_review" → return null` (`deviation.ts:119`) and its only
   recording site is inside the `patch.status === "done"` block (`issues.ts:458`).
   Once `done` is reachable only from `approved`, it never records again.
2. **The proposed predicate inverts the axis.** Today it fires **iff
   `openPr === null && merged === null`** — iff there is *no PR evidence at all*.
   That is precisely why it caught 7 of the 12 issues that "never had a PR
   opened." Adding `+ code evidence` as a conjunct is the complement of that axis
   and would stop it firing on 100% of the motivating population.

So: **keep the predicate's axis, and move it from a transition-time record to a
swept signal.** A recomputed sweep over `status = 'done'` rows — the shape
`emitProcessDeviations` already uses (`deviation.ts:175-181`) — is also the only
form that can catch a bypass, since every bypass named earlier funnels through
`updateIssue`, where the new refusal lives; a detector whose recording site is a
transition its own guard rejects cannot fire.

Its **message text** is separately wrong and should be fixed: it is not false "when
an open-unmerged PR exists" (`deviation.ts:119` suppresses the flag entirely in
that case) — it is false when an open PR exists that **`pr_state` cannot see**, i.e.
a `feat/` branch or poller lag. Fix the string at `deviation.ts:122-123`, not the
predicate.

**Keep the open-PR suppression until the completion phase lands.** Shipping the
sweep before `done` implies a merge would fire a `process_deviation` and fan out a
webhook on every ordinary authorization.

`restampable` (`triage-actions.ts:120`, keyed on `status === "done" && pin open`)
must move to `approved`, or the manual retry door closes for exactly the state
failures now sit in.

### 7. Dependencies: `approved` is open

`CLOSED = ["done","canceled"]` (`dependencies.ts:15`, re-encoded at `:240`).
**Decision: `approved` stays open** — the code is not on `main`. Consequence,
stated deliberately: a badged or expired item freezes its dependency subtree out of
dispatch (`worker-select.ts:463`, `issues.ts:721-726`) until a human acts — which
is why §1b.3 requires an attention flag on expiry and §3d requires exits.

## Phasing

- **Phase A — the atomic core.** `approved` in `STATUSES`; the human authorization
  + CAS; §1a's evidence test; §2's gate move and fail-closed guards; §3's
  `completeDelivery` and proof; the full consistency sweep; the detector rewrite
  (§6) shipped *with* it, retaining open-PR suppression until this phase is live.
  Round 2 established these cannot be split: §1a without §3 stalls every
  code-bearing issue, and §3 without §1a leaves `→ done` writable with no CAS at
  all — weaker than today.
- **Phase B — retry model (§4).** Requires SYD-276.
- **Phase C — conflicts and badge (§5).**
- **Phase D — migration sweep.**

## Consistency sweep

**Server:** `schema.ts:12-20` (`STATUSES`) · `delivery-attempts.ts:99`, `:104`,
`:110` (three `'done'` literals) · `attention.ts:84` · **`deviation.ts:114-119`
(the detector predicate + its `fromStatus` scoping)** and **`:69` (the
`merged_pr_not_done` branch — widening `CANDIDATE_STATUSES` at `:37` alone is a
no-op, since every reason inside is independently status-gated)** ·
`triage-actions.ts:120` · `dependencies.ts:15`, `:240` · `hard-gate.ts:193` ·
`settings.ts:52-57`, `:56` (the `"(done, dependency.remove)"` string), `:94` ·
`search.ts:23` · `linear-import.ts:564` · a new
`delivery.approval_max_age_hours` REGISTRY key.

**Verified safe:** `settings.ts:255-259` (`getDispatchPolicy` guards with
`key in REGISTRY`) · `src/mcp/server.ts:118`, `:271`, `src/rest/schemas.ts:33`,
`ui/src/views/Search.tsx:6`, `:40` (all derive from `STATUSES`). Agents are denied
`approved` only because `AGENT_STATUS_TRANSITIONS` is a `Partial<Record<…>>` with
no key — correct but implicit; test it.

**UI:** `ui/src/types.ts:10-18` (a **second hand-maintained `STATUSES` copy**) and
`:47-53` · `Board.tsx:9` (`BOARD_COLUMNS`), `:10-16` (`LABELS`, typed
`Record<string, string>` — a missing entry renders `undefined` with no typecheck
error) · **`Board.tsx:97`, `:105`, `:121`, `:124` — the SYD-171 done-column
delivery filters, whose stated purpose is "the done column is where delivery
problems surface"; under this design they surface in `approved`** ·
`Board.tsx:59` and `IssueDetail.tsx:433` (`status === "done" ? expectedHeadSha` —
both must move together or drag-to-approve silently drops the CAS) ·
**`Review.tsx:110-113` — `approve()` sends `status: "done"`; this is *the* human
approval button** · `IssueDetail.tsx:303`, `:617` · `ui/src/attention.ts:10-21` ·
`ui/src/types.ts:105` and `Approvals.tsx:84` (both carry `done`-specific gate
wording).

**Prompt/doc text:** `worker-select.ts:801` · `agent-worker.ts:645-649` ·
`init-worker-lib.ts:629` · `src/mcp/server.ts:258` and **`:264-266`** (the
`update_issue` description hard-codes "Stamping status: done … authorizes
delivery") · `CLAUDE.md`.

**Dropped:** the board-nudge item. `board-nudge-hook.ts` contains no instruction
text; the reminder is `nudgeReminder` (`board-nudge-lib.ts:37-45`) and it asks for
`in_review`, which *is* an allowed agent transition (`issues.ts:51`). The real
friction was narrower — the nudge is unsatisfiable for an issue already in `done`.
Re-scope as its own issue.

## Migration

1. **Schema:** `issues.status` is plain `text NOT NULL` with no CHECK constraint
   (`drizzle/0000_rich_lord_hawal.sql:35`); drizzle's `text("status", { enum })` is
   compile-time only. So `db:generate` will likely emit **no SQL** — verify rather
   than assume. Conversely, once rows hold `'approved'`, reverting the code leaves
   values outside the `Status` union still being read and rendered: **a revert
   needs a data migration back to `in_review`.**
2. **Settings:** migrate stored `supervised.hard_gate_actions` rows.
3. **The sweep lands issues in `in_review`, not `approved`** — each then gets a
   fresh human approval with a current CAS. This forges no authorization events and
   avoids an automated mass re-authorization of week-old pins. Human-run with
   `--dry-run`, **not** wired to server startup the way `ensureRolloutBackfill` is
   (`server.ts:156`). Skips issues whose pin status is `closed`. Candidates from
   this window: SYD-219, 243, 244, 248, 253, 261, 263, 264, 266, **HEX-2 (a
   different project — the sweep is not SYD-scoped)**; several are pin-less, so
   verify the predicate against the actual set.

## Testing

**Authorization & gate** — `in_review → approved` human-only, agents and `service`
refused · SYD-213 pentest matrix green against the new status · a supervised
session gets `PendingAffirmation` for `in_review → approved`, and with
`affirm_requires_signature=true` the web click is refused · a stored `["done"]`
gate row is migrated and the validator accepts `"approved"` · the parked payload
carries `expectedHeadSha` (existing behavior — assert it) · `done` cannot be
re-added to `EXECUTABLE_GATE_ACTIONS`.

**Completion** — refused with no merge record; on a null `mergeSha`; on a SHA
mismatch; on a PR-number mismatch against the pin · **an interactive `feat/` issue
with a display-path `gh_pr_merged` completes** (the round-2 CRITICAL) · refused for
a *human* token too on an evidence-bearing issue with no merge record (the
single-token deployment case) · a hand-merged PR completes without a re-merge · a
squash-merge whose SHA differs from the approved head completes · `done` is written
before the deploy step.

**Retry** — a second attempt against the same authorization succeeds (test the
attempt, not the query) · an issue with an unfinished attempt is in `unfinished`
and **not** `pending`, and the service-side guard refuses it · after k=3 failed
attempts a `merged_deploy_failed` attempt still yields a due deploy retry · a
`merged_deploy_failed` authorization does not also appear in `pending` ·
head-moved is terminal · an approval past `approval_max_age_hours` is refused **in
`startDeliveryAttempt`** and raises an attention flag · the three selection
literals behave (`delivery-attempts.ts:99/104/110`).

**Badge** — conflict → bounded retries → `needs_manual_rebase`, still `approved`,
not re-selected · badge-clear refused for agents, requires a note and a matching
`expectedHeadSha`, refused on a closed PR, **records an event selection reads**,
and **is hard-gated** · the file list is capped.

**Detection & consistency** — the sweep still fires on a `done` issue with no PR
evidence (the 12-issue class) · it does not fire on an ordinary authorization
before the completion phase · `deviation.ts:69` widening actually produces
`merged_pr_not_done` coverage for `approved` · every `Status` in `BOARD_COLUMNS`
has a `LABELS` entry **and every non-terminal `Status` is present in
`BOARD_COLUMNS`** (the converse is the more severe failure: `BOARD_COLUMNS` is
typed `Status[]`, a subset type, so omitting `approved` is not a type error and the
state where all work waits becomes invisible) · `ui/src/types.ts` `STATUSES` equals
the server's · `Review.tsx` sends `approved` · `restampable` follows to `approved`
· an issue blocked by an `approved` blocker is reported blocked · migration moves a
done-but-unlanded issue to `in_review`, leaves a merged one alone, skips a
closed-PR issue.

## Out of scope

- **Branch strategy** (production/staging/main) — Sean's thinking 2026-07-26.
- **Automated conflict-resolver sessions** — revisit once badge data exists.
- **Dispatch-side claim gates** — authoring concerns, unchanged.
- **Agent participation in recovery** — deferred until badge data exists.
- **The board-nudge reminder** — its own issue.
- **A real "code was pushed" evidence source.** The worker could record a push
  event at `buildPushArgs` (`delivery-lib.ts:180-181`), which would let §1a see
  unpushed-but-committed work. Worth filing; not required for this design, since
  that class lands in the note path and the §6 sweep.
