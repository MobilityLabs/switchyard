# Skeptic review — Declared PR↔issue links (round 1)

Every file:line the plan cites was verified against source this session; all of
them check out (`pr-status.ts:9-12/28-42/44/72-84/101/108`,
`github-webhook.ts:82/194/216-223`, `api-routes.ts:602`,
`delivery-lib.ts:180-181/220-241`, `delivery-attempts.ts:105`,
`Review.tsx:110-113`, `triage-actions.ts:11-15`). The problems below are not
citation problems — they are runtime-path problems the plan's citations stop
just short of.

---

## CRITICAL 1 — The plan designs link *creation* but no link *lifecycle*: a non-attributed pr_state row is never status-updated by anything

Both writers of PR status flow through the same gate, and the plan changes
neither:

- Webhook: `src/services/github-webhook.ts:222-223` — `upsertPrState` is called
  only when `attributed` (strict `agent/<ref>` branch on a bound repo). All
  other PRs take the display path (`record()`, events only, `pr_state` never
  touched).
- Poller: `scripts/github-poll-lib.ts:59-75,113-118` synthesizes
  webhook-shaped `pull_request` payloads and POSTs them to `/github-events`,
  which routes into the *same* `handlePullRequest` and the *same* attributed
  gate. The poller's targeted refresh (`selectRefreshCandidates`,
  `github-poll-lib.ts:140-152`) likewise ends in a synthesized payload that
  dies at the gate for a non-agent branch.

So trace a proposed link end-to-end: a trailer on `fix/syd-253-…` creates a
`pr_state` row (`proposed`, status `open`). The PR later merges. GitHub sends
`pull_request closed/merged`; `attributedRef` returns null for the branch; the
webhook takes the display path and records an event — **the row's status stays
`open` forever**. The poller cannot heal it either: same gate. Consequences:

1. `getOpenPr` (`pr-status.ts:44`) returns the stuck row forever → the claim
   gate (`issues.ts:271`) **permanently blocks** any future claim on that issue
   (sent back, reopened, follow-up — never claimable again). The plan calls a
   wrong link's over-block "harmless"; here a *correct* link over-blocks
   *forever*.
2. `getMergedPr` (`pr-status.ts:108`) requires `ps.status = 'merged'` and never
   sees the merge → **the plan's own headline regression test —
   "`done_without_merged_pr` does not fire for an issue with a confirmed link
   and a merged PR" — cannot pass as specified.** The SYD-253 false positive
   this design exists to fix is not fixed.
3. Second-order leak: the stuck-open row enters the poller's refresh candidate
   set every `intervalMs` forever (`github-poll-lib.ts:147-151`) — one wasted
   GitHub API call per stuck row per interval, growing monotonically.

The fix is tractable — route a PR through `upsertPrState` when it is attributed
**or** a `pr_state` row already exists for `(repo, prNumber)` — but it is not a
detail: it rewrites `upsertPrState`'s stated contract ("Free-text ref scans
never reach this function", `pr-state.ts:28`), and it makes the co-write at
`pr-state.ts:199` record canonical `gh_pr_merged` transition events against a
*merely proposed* (possibly guessed) issue. The plan must specify this routing
change, the `link_source` preservation through `upsertPrState`'s update path
(`pr-state.ts:229-245` doesn't know the column exists), and what the co-write
means for unconfirmed links. Right now the spec is silent on all of it.

## CRITICAL 2 — The read-split table misclassifies `getOpenPr`: it is also the delivery-pin source, so a *proposed* link becomes a delivery authorization

The plan's §1 table lists `getOpenPr`'s consumer as "claim gate" and reasons
"a wrong link over-blocks — fails safe." That is not `getOpenPr`'s only
consumer. The done-stamp pin comes from `getOpenPr`, not `deliveryPinFor`:
`src/services/issues.ts:436-453` — `updateIssue(status: 'done')` calls
`getOpenPr`, compare-and-sets `expectedHeadSha` against the row's head, and
writes `donePin` into the `status_changed` payload (`issues.ts:471`). That pin
is exactly what `listPendingDeliveryAuthorizations` selects on
(`delivery-attempts.ts:104-105`).

Trace it under the plan: an issue in `in_review` has an open PR with only a
**proposed** link (a free-text guess is enough). The human clicks approve —
`Review.tsx:108-114` sends `status: done` with `expectedHeadSha` taken from
`current.openPr` (which the API now populates from the proposed row,
`api-routes.ts:261`). Server-side `getOpenPr` returns the same proposed row,
the SHA matches by construction, a pin is recorded, and the issue becomes a
pending delivery authorization. The delivery worker then runs `buildPushArgs`
→ `git push origin agent/<ref>` (`delivery-lib.ts:180-182`) on a branch that
does not exist — manufacturing the exact "no branch to rebase" failure the
plan's §4 says it is avoiding, triggered by a *guess* no human ever confirmed.

The same contradiction exists for `confirmed` via the path the table explicitly
blesses: `deliveryPinFor` "accepts branch, confirmed" (§1 table), and
`redeliverIssue` (`api-routes.ts:428`) uses `deliveryPinFor` — so a human
clicking Retry on a confirmed interactive issue authorizes delivery against a
nonexistent agent branch. Two of the plan's own tests are therefore
unimplementable against its own table:

- "An interactive issue with a confirmed link is **not** selected by
  `listPendingDeliveryAuthorizations`" — but the confirm-at-approve action *is*
  the done-stamp that records the pin `listPendingDeliveryAuthorizations` keys
  on.
- The `done_without_merged_pr` regression test (also broken by CRITICAL 1).

Root cause: the plan splits reads on the **trust** axis (`link_source`) but §4
needs a split on the **deliverability** axis (is there an `agent/<ref>` branch
for the machinery to push?). Those are different axes and the table conflates
them. The fix must be explicit: the done-pin and `deliveryPinFor` must require
`link_source = 'branch'` (or an equivalent branch-shape check), while
`merged_pr_not_done` / `getMergedPr`-style *detection* reads accept
`confirmed`. That means splitting `deliveryPinFor`'s row of the table in two —
"delivery authorization" and "completion proof" do not belong in the same cell.

## MAJOR 3 — The safety story is "a human declines the bad guess," and there is no decline mechanism anywhere in the design

§1: "a bad guess becomes a proposal a human declines." §3: "more than one
proposal → the human picks." Neither the decline nor the fate of the unpicked
proposal is specified: `link_source` has no rejected value, `/pr-state` is
GET-only (`api-routes.ts:602`), `link_pr` only creates, `upsertPrState` is the
sole writer and has no delete/unlink path. Meanwhile a proposal takes effect
*immediately* in `getOpenPr` (openRows joins purely on
`issue_ref`/`status='open'`, `pr-status.ts:35-38` — note: **no repo-binding
check** on that join). Combined:

- `link_pr` is agent-callable and the server has no GitHub credentials to
  verify the PR even exists — an agent can propose `(repo: anything, pr:
  99999)` against any issue and instantly claim-block it, with no tool, UI
  action, or state value by which a human removes the block. Under CRITICAL 1
  the block is also permanent. "Fails safe" is doing a lot of unexamined work:
  this is an unbounded, unremediable DoS on claimability, reachable by the
  least-trusted principal in the system.
- The declined half of a two-proposal ambiguity has nowhere to go.

The design needs: a rejected/unlinked state (or row deletion semantics), a
human-only unlink action, and a decision about whether `link_pr` proposals
require an existing `pr_state` row or observed PR. None are edge cases — the
decline path is the load-bearing safety argument.

## MAJOR 4 — The backfill's stated data source cannot enforce the backfill's own rule

§Migration: "re-scan into proposals from the `gh_pr_opened` events already
recorded, only where the PR's title and body contain exactly one distinct
ref." The display-path `gh_pr_opened` payload is `{ prNumber, url, branch,
headSha, ghUpdatedAt }` (`github-webhook.ts:261-268`) — **no title, no body**.
And the event exists only on the *first-matched* issue (`REF_RE.exec` takes
the first hit, `github-webhook.ts:89-92`), so multi-ref-ness is not
reconstructible from events at all. As written, the backfill would reproduce
exactly the first-match bias the plan's own PR #221 worked example warns
about. The script must fetch title/body from GitHub (`gh pr view`) per PR —
fine for a human-run script, but the spec should say so, because "from the
events already recorded" reads as an offline-safe operation and is not.

## MAJOR 5 — `link_pr` must mint a `pr_state` row whose status it cannot know; the plan's own motivating scenario (link after merge) is the worst case

Most interactive PRs have **no** `pr_state` row (that is the whole problem
statement — PR #220 had none). So `link_pr(ref, repo, pr_number)` must insert
one, and `pr_state.status` is NOT NULL. With what status? The server never
talks to GitHub. Mint `open` and the SYD-253 flow — merge first, declare
after, precisely the observed 15:22→15:24 sequence — creates a row that is
wrong at birth and (per CRITICAL 1) uncorrectable, permanently claim-blocking
the issue while still never satisfying `getMergedPr`. The spec must define
where status/headSha/ghUpdatedAt come from on a link_pr-minted row (poller
heal after the routing fix? refuse to link an unobserved PR? a `status
unknown` value?). Currently unaddressed.

## MAJOR 6 — The primary channel silently misses the flow the plan advertises: a trailer added by editing the PR body never arrives via webhook

"a human can type it in the GitHub UI" — typed at creation, fine; but the
common flow is opening the PR and *then* editing the body. GitHub sends
`pull_request` action `edited`, which is not in `PR_ACTIONS`
(`github-webhook.ts:186`) and is dropped at `:197-199`. On a webhook-delivered
repo the declaration is silently lost. The poller happens to heal it — it
re-emits full title/body every tick (`github-poll-lib.ts:113-118`) — but only
if the implementation scans trailers on **every** `pull_request` observation
regardless of action, including the `closed` re-emissions the poller sends for
merged PRs (a trailer added just before merge otherwise misses its last
webhook too). The spec should state exactly that scan-on-every-observation
rule (or add `edited` to `PR_ACTIONS`); as written, a natural implementation
scans only `opened` and the primary channel develops a silent hole.

## MINOR 7 — `DEFAULT 'branch'` is a schema default that fails dangerous

`link_source TEXT NOT NULL DEFAULT 'branch'` exists to spare a data
migration, but it means every future INSERT that forgets the column mints
full, `confirmed`-equivalent authority — the opposite of the plan's own
fail-direction philosophy. `upsertPrState`'s insert (`pr-state.ts:254`)
doesn't set the column, which is accidentally right today and a landmine after
CRITICAL 1's routing fix. Safer: `DEFAULT 'proposed'` plus a one-time `UPDATE
pr_state SET link_source='branch'` for existing rows — a trivial migration the
plan is over-optimizing away.

## MINOR 8 — Proposals feed the deviation signals; guess-noise moves from state to human nudges

`computeDeviation` consumes `getOpenPr` (`deviation.ts:132`), so a proposed
(guessed) link now raises `open_pr_not_in_review` nudges against the guessed
issue. The plan says proposals are "harmless by construction," but this
consumer is absent from its table — the SYD-277 class of bad guess reappears
as deviation noise pinging a human. Decide explicitly whether deviation reads
accept `proposed`.

## MINOR 9 — Two wording gaps that will bite at implementation

- "When a human moves an issue out of `in_review`" — `sendBack()`
  (`Review.tsx:123-139`) also moves out of `in_review`, to `todo`. Confirming
  on send-back would mint authority for rejected work. Say "approve only."
- Trailer/free-text interplay: a PR with a valid trailer plus one other ref in
  prose contains two distinct refs in title+body. Specify that the trailer
  line is excluded from the free-text scan and that trailer presence
  suppresses free-text proposals entirely, or the "exactly one distinct ref"
  rule and the trailer rule fight over the same PR.

---

## The one fatal flaw

The plan treats `pr_state` as a *link table* it can add rows to, when it is
actually a *state machine* whose maintenance loop (webhook + poller) only
services attributed rows. Everything downstream of that mistake compounds:
rows frozen at birth (C1), a trust-axis split standing in for the
deliverability split the delivery pipeline actually needs (C2), and a safety
story resting on a decline path that was never designed (M3). The design's
core ideas — declared beats guessed, propose freely / confirm deliberately,
agents never confirm — are sound and worth keeping. But the spec must add a
lifecycle section (who updates a non-attributed row's status, and how
`link_source` survives it) and re-cut the read-split table on two axes (trust
for detection, branch-shape for delivery authorization) before an
implementation plan is written on top of it.

VERDICT: REVISE — concerns above should be addressed first
