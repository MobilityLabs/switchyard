# Board working order — 2026-07-28

**Why this file exists:** Switchyard has no rank or ordering field. Priority is a
four-value enum, dependencies express hard blocks, and neither captures "do this
one before that one" between two unblocked `high` issues. This is that ordering,
written down so it survives the session that produced it.

**Status:** a recommendation, not a commitment. Re-derive it rather than trust it
if the board has moved much — the counts below are measurements taken on
2026-07-28 and will drift. Where an ordering decision rests on a fact, the fact
is stated so it can be rechecked.

**Context it was written in:** SYD-280 (declared attribution) and SYD-287
(link-aware observation) had just shipped and deployed. Sean confirmed that
clearing the stale-flag backlog is a **UI** task, not a script.

---

## The measurement that drives most of this

Board-wide, 2026-07-28, after SYD-280 + SYD-287:

```
~36-44  done issues carry an unresolved done_without_merged_pr
     0  of them have ANY live pr_link
    16  of them have a gh_pr_merged event   (landed, just never declared)
     7  issues additionally carry delivery_failed
    25  of the flagged are cross-project     (21 NOC, 4 HEX)
```

The spread is a predicate difference: `getAttention` reports 44 across all
projects; a direct query of the deviation arm reports 36. Either way: dozens.

**The zero is the important number.** SYD-280 correctly removed the free-text
auto-clear; SYD-287 supplied the correct replacement. Clearing a flag now
requires a human to *declare* a link and then *confirm* it — and both acts are
CLI-only. So the whole backlog is gated on one UI issue, which is why SYD-290
outranks work that looks more urgent.

---

## Tier 1 — cheap, live risk, or unblocks a person

| # | Issue | Why here |
|---|---|---|
| 1 | **SYD-284** | `main` has **no** required checks and `enforce_admins: false` — verified against the GitHub API today. PR #227 merged into `main` with nothing enforcing CI. Minutes of settings work, `high`, unblocked, and currently false-secure: SYD-222 is stamped done, so the board claims protection that does not exist. |
| 2 | **SYD-269** | HEX sessions cannot `yarn install` — the egress allowlist omits `registry.yarnpkg.com`. An allowlist line that unblocks an entire project's sessions. |
| 3 | **SYD-290** | The remediation bottleneck (see above). Sean clicks through the ~36 flags once this exists; nothing else clears them. Raised `medium -> high` today. Scope note: include a way to *find* the flagged issues — clicking through 36 means locating them first, and that filter is likely the difference between the backlog getting worked and not. |

Tier 1 is ordered by cost-to-value, not severity. 284 and 269 are each well under
an hour and one of them is a live security gap; 290 is larger but everything in
Tier 3 waits on it.

## Tier 2 — the SYD-279 epic critical path

Strictly sequential, enforced by dependencies:

```
SYD-280 (A) done  ->  SYD-281 (B)  ->  SYD-282 (C)  ->  SYD-283 (D)  ->  SYD-292
```

**SYD-281** (human-act integrity — `requireHuman` does not currently mean human)
is the only actionable link and is `high`. Everything downstream is blocked on it,
so it is the highest-leverage single issue on the board after Tier 1.

Two notes:

- **SYD-272 / SYD-276** are children of SYD-283 and were unblocked; both are about
  delivery-failure *messaging* while 283 decides the failure *model*, so they were
  blocked on 283 today to prevent rework.
- **SYD-292** carries a constraint that must not be lost: it must **not** remove
  the `agent/<ref>` queue guard SYD-287 added to
  `listPendingDeliveryAuthorizations`. That guard comes out only in the same
  change that teaches delivery to use a PR's real head branch. Removing it early
  re-opens the auto-close hazard that closed PR #227.

## Tier 3 — attention-signal cleanup (mostly gated on SYD-290)

| Issue | Note |
|---|---|
| **SYD-274** | Do the *test* first — it is not gated on 290. Multi-issue `delivers` links are believed representable, but the "event co-written per linked issue" behaviour is asserted in a code comment and covered by no test. If it passes, this is a data task; if it fails, it is a small bug. SYD-243/SYD-244 are the live case. |
| **SYD-285** | Premise moved: the mechanism is fixed by SYD-287. Residue is prompting, which is SYD-290's. Fold in or close. |
| **SYD-265** | Was an audit; the audit is done (numbers above). Re-scope to "work the flagged backlog", gated on 290. |
| **SYD-275** | Cross-project arm of the same pass — 25 of the flagged are NOC/HEX, and those projects have nobody working them daily, so their flags rot longest. Caveat: HEX-1 has a *separate* cause (SYD-261), so clearing it by declaration would paper over a delivery bug. |
| **SYD-273**, **SYD-261** | Delivery dead-ends. SYD-261 is unaffected by SYD-287 — the pin is captured at stamp time, so a PR registered *after* the stamp still never enqueues. |

## Tier 4 — infrastructure debt

**SYD-291** (a one-time migration has no operator path) is listed here but is a
**prerequisite for any future schema migration**, so it jumps the queue the moment
one is needed. SYD-280's backfill already hit this wall. Then **SYD-270**
(concurrent worker starts race the egress sidecar) and **SYD-268** (precompile host
scripts).

## Tier 5 — hygiene and UX, no ordering between them

SYD-286 (no `todo -> in_review` for agents — verified still true at
`issues.ts:47-57`) · SYD-288 (no label-vocabulary discovery; 66% of issues
unlabeled) · SYD-289 (done parents with open children — SYD-280 is itself one,
with 7) · SYD-278 (stop-hook nudges repeat unsatisfiable instructions) · SYD-277
(board-nudge fabricates refs from prose — verified, `/\b([A-Za-z]{2,10})-(\d+)\b/`
at `board-nudge-lib.ts:11`) · SYD-247, SYD-226 (spikes) · SYD-19 (on hold).

---

## Board hygiene noted, not fixed

- **SYD-19** was labeled `hold` but sat in `todo` with no worker preference, so it
  was dispatchable despite its description ending "Blocked on: Sean deciding when
  to invite the team." Set to `interactive` today; **`backlog` is the honest
  status** and an agent cannot make that transition.
- **SYD-279** (the epic) sits in `todo` itself. It is a container with 5 children,
  not work. Harmless while it is `interactive`, but it clutters the ready queue.
- **SYD-280** is `done` with 7 open children — an instance of SYD-289's own
  complaint, which is useful as its test case.
