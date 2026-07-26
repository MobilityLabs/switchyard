# `approved`: separating "I authorized this" from "this shipped"

**Status:** design approved 2026-07-26, ready for an implementation plan
**Author:** interactive session with Sean, 2026-07-26

## Problem

Work that agents finish routinely never reaches `main`, and nothing notices.

SYD-265's audit found **12 issues stamped `done` whose commit is not on `main` by
patch-id, was never pushed, and never had a PR opened** — 5 of them carrying no
attention flag at all. Eleven were recovered by hand on 2026-07-25/26 (PRs
#208–#218); the twelfth (SYD-253) needed a full re-implementation because `main`
had moved 100+ commits underneath it.

A 400-event sample of the board (`1784908790`→`1785076876`, ~47 hours) shows the
shape of it:

| measure | value |
|---|---|
| `delivery_failed` events | 16 |
| `delivered` events | 2 |
| PRs merged | 37 |
| manual `redeliver_requested` | 8 |
| `process_deviation` raised / resolved | 27 / 2 |

So roughly **35 of 37 merges happened outside the delivery worker**, by hand.

### The stamp is not the bottleneck

The obvious theory — branches rot while waiting for human approval — is wrong.
`in_review → done` latency per issue in that window:

```
0h, 0h, 0h, 0h, 0h, 0.1h, 0.1h, 0.1h, 0.2h, 0.5h, 0.6h, 0.6h, 0.7h, 0.8h, 0.9h, 2h
```

One outlier at 19.8h (SYD-239); median ≈ 0. Sean approves nearly instantly.
Several issues even show `done → merge` as *negative* — the PR was merged by
hand first, then stamped.

The rot happens **after** the stamp:

- **10 of 33** done-stamped issues never reached `main` at all.
- **6 more** landed ~28–29h later, and only because a human recovered them.

### Why: `done` is an absorbing state

Once an issue is stamped `done`, it leaves every mechanism that could recover it:

- It is in no work queue — not `todo`, `in_progress`, or `in_review` — so neither
  dispatch nor `next_task` will surface it again.
- The delivery queue will not retry it. `listPendingDeliveryAuthorizations`
  (`src/services/delivery-attempts.ts:88-116`) selects authorizations
  `WHERE i.status = 'done' … AND NOT EXISTS (SELECT 1 FROM delivery_attempts da
  WHERE da.authorization_id = e.id)`. Once an attempt row exists for that
  authorization event, that authorization is never selected again — **one shot,
  no retry, by construction.**
- The only remaining signal is `done_without_merged_pr`, running 22 unresolved to
  2 resolved in this window. It is noise, and it misfires in both directions:
  SYD-265 found 5 silent misses, and SYD-266 carries the flag with the message
  "no PR ever recorded as open or merged" despite a `gh_pr_opened` event for
  PR #219 recorded ~2h *before* the flag fired.
- **No agent can pick it back up.** `updateIssue` refuses: *"only humans reopen a
  done issue."* Every recovery is therefore a human, manually, one issue at a
  time.

`done` is being asked to mean two things at once — the delivery worker treats it
as the *trigger*, the human reads it as the *receipt* — and everything that fails
in between falls into the gap.

### What the failures actually are

Of the 16 `delivery_failed` events, only **one** was a verdict about the work:

| cause | count | work at fault? |
|---|---|---|
| `rebase onto main hit real conflicts` | 6 | no — staleness/contention |
| `a commit landed … after its checks started — disarmed` | 4 | no — the SYD-216 read-after-write bug, whose fix sat unlanded 11 days |
| PR closed unmerged / no branch to rebase | 3 | no — dead-end bookkeeping |
| GitHub 504, `gh pr view` failure | 2 | no — transient infra |
| `required GitHub checks failed` | 1 | **yes** |

## Design

### 1. State machine

```
triage → backlog → todo → in_progress → in_review → approved → done
                                                        ↑         ↑
                                             human authorizes   merge confirmed
```

**`approved` is a new status** meaning "this commit chain is good to merge."

- **`in_review → approved`** is human-only — it replaces today's done-stamp as the
  delivery authorization, and carries the same `expected_head_sha`
  compare-and-set the done-stamp requires now, so authorizing a chain that moved
  under you still 400s naming the current head.
- **The delivery queue triggers on `approved`, not `done`.** This is the change
  that makes everything else work:
  `listPendingDeliveryAuthorizations`'s `WHERE i.status = 'done'` becomes
  `'approved'`, and the authorization event becomes the `→ approved` transition.
- **`done` is written by the delivery worker on a confirmed merge**, never by
  hand for code work. Authorized-but-unlanded work stays in `approved`: still in
  a queue, still owned, still visible.

**Issues with no code** (ops tasks, verifications, decisions) have no merge to
wait for. Rule: **if the issue has a delivery pin, only a confirmed merge can
write `done`; if it has none, a human stamps `done` exactly as today.** This
keeps the leak unrepresentable for code work without stranding everything else.

**Retry stops being one-shot.** The `→ approved` transition is still recorded as
the authorization event (it carries the pin and head SHA), but *selection* is by
state, not by "an authorization with no attempt row yet". An item that fails
therefore stays `approved` and is re-selected on the next pass, subject to §3's
backoff — instead of being permanently excluded by the `NOT EXISTS` clause.

Two exclusions keep that from becoming a spin: an item is skipped while its
backoff window is open, and an item carrying `needs_manual_rebase` is skipped
until a human clears the badge (clearing it is what re-queues the work).

### 2. Permissions

The delivery worker runs as a `service` actor (SYD-213, PR #154). That issue's
review — a multi-reviewer debate plus a pentester pass — found `service` tokens
would silently pass several guards written `type === "agent"`, leaking
"reopen-done, reassign, the free status machine." Rather than convert each guard,
`createIssue`/`updateIssue`/`requestHumanInput` **deny `service` wholesale**.

That denial is load-bearing and stays. This design adds exactly one capability:

- **A dedicated delivery-completion path granting `service` the single
  transition `approved → done`, taking a confirmed merge SHA.** No merge commit,
  no transition. It does *not* go through `updateIssue`, so `service` still
  cannot create, reassign, reopen, or move anything else.
- Dispatched agents remain unable to stamp `done` — the existing invariant is
  untouched. The thing that merged the work records it, not the thing that wrote
  it.

**Delivery authority derives from state, not assignment.** Any issue in
`approved` is deliverable regardless of assignee (`gemini/dev`, `codex/dev`, an
interactive session). The gates that couple assignment to progress —
`assertClaimable` (`src/services/issues.ts:258`) and `assertAssignee` (`:280`) —
are correct for *authoring*; they are what stops SYD-93-style double-work. They
must not sit in the delivery path, and under this design they don't: delivery no
longer routes through `AGENT_STATUS_TRANSITIONS` (`src/services/issues.ts:47-57`)
at all. Dispatch keeps its own skip of assigned issues
(`scripts/worker-select.ts:458`) unchanged — that is also an authoring concern.

### 3. Conflicts, retries, and the badge

**Step 1 — re-rebase, free.** Most conflicts in a busy queue are against
something still in flight. After each merge the queue re-rebases the remaining
`approved` items; a conflict that evaporates on retry never costs a session or a
human. Bounded attempts so it cannot spin.

**Step 2 — badge.** If the rebase keeps failing, the issue **stays in
`approved`** carrying a distinct flag (`needs_manual_rebase`) with the conflicted
file list. It does not fall out of the queue, it does not reach `done`, and it is
visible in the column *and* badged.

**No automated conflict-resolver session in v1**, deliberately. SYD-163 recorded
a night where resolver dispatch produced three sessions back to back (SYD-145,
140, 144) whose resolutions all went stale before their retry-merge because
`main` kept moving — three paid sessions, zero merges. SYD-164 concluded such a
resolver must hold the ref's queue slot while it works. Shipping steps 1 and 2
first means the badge tells us how often a human rebase was genuinely needed
before we spend sessions on it.

**Transient failures never badge.** A GitHub 504, a failed `gh pr view`, an
ssh/environment fault: auto-retry with backoff, escalate only after the budget is
exhausted. This depends on **SYD-276** (classifying environment failures
separately from delivery verdicts), which is what tells the queue whether a
failure is retryable — that issue is a prerequisite, not a nice-to-have.

Applied to this window: 2 transient retried silently, 4 disarms already gone with
SYD-216 landed, 6 conflicts handled at step 1 or badged at step 2, leaving the
1 genuinely-red-CI case for a human.

### 4. What this removes

- `done_without_merged_pr` stops being a concept. Unlanded work is visible in
  `approved` by construction, which doubles as the queue-depth readout. The
  22-unresolved-to-2 noise goes away rather than gaining a dismiss button — which
  also resolves the SYD-262/SYD-263 dismiss-path question by making it moot.
- `redeliver_requested` as a routine human action. It remains for genuine
  re-authorization, not as the standard recovery path.

## Migration

1. **Schema:** add `approved` to `STATUSES` (`src/db/schema.ts:12-21`) — a
   migration via `npm run db:generate`.
2. **Existing done-but-unlanded issues:** a one-off sweep moving any `done` issue
   with a delivery pin and no merge commit into `approved`, so the new queue
   picks them up instead of leaving them stranded. This is the automated version
   of what SYD-265 did by hand. Currently outstanding: SYD-219, 243, 244, 248,
   253, 261, 263, 264, 266, HEX-2 — verify each at implementation time rather
   than trusting this list.
3. **UI:** add the column to `BOARD_COLUMNS` (`ui/src/views/Board.tsx:9`) between
   `in_review` and `done`.
4. **Board-process hook:** `scripts/board-nudge-hook.ts` currently instructs
   agents to move issues to states the server forbids them from touching — it
   fired four times in one session asking for a transition no agent can perform.
   It needs updating for the new machine.
5. **Docs:** CLAUDE.md's server-enforced-rules list and the board-process norms
   both name the done-stamp as the authorization point.

## Testing

- `in_review → approved` is human-only; agents refused.
- `approved → done` succeeds for `service` **only** with a merge SHA, and fails
  without one.
- `service` still cannot create, reassign, reopen, or otherwise mutate issues —
  the SYD-213 pentest matrix must stay green.
- An issue in `approved` is deliverable while assigned to a different actor
  (the `gemini/dev` case).
- A failed delivery leaves the issue in `approved` and it is re-selected on the
  next pass (the direct regression test for the one-shot `NOT EXISTS` behavior).
- Rebase conflict → bounded retries → `needs_manual_rebase`, issue still
  `approved`.
- A badged item is **not** re-selected until the badge is cleared, and clearing
  it re-queues the work (guards against a spin on a permanently-conflicted item).
- Transient failure retries and never badges.
- A no-pin issue can still be stamped `done` by a human.
- Migration sweep moves a done-but-unlanded issue to `approved` and leaves a
  genuinely-merged one alone.

## Out of scope

- **Branch strategy** (production/staging/main, with `main` as ready-to-deploy).
  Recorded as Sean's thinking on 2026-07-26; orthogonal to this change.
- **Automated conflict-resolver sessions** — step 2 above, revisit once badge
  data exists.
- **Dispatch-side claim gates** — unchanged; they are authoring concerns.
- **Agent participation in recovery.** In v1, `approved` transitions stay
  human-only apart from the service's completion. Whether an assignee agent may
  take a badged `needs_manual_rebase` item back to `in_progress` is an open
  question, deferred until the badge shows how often it happens.
