# Skeptic review — "Declared PR↔issue links" (r1, Opus)

Scope: the plan at `.tmp/ai-review-773300c7/plan.md`, checked against the repo at
`/Users/sean/sites/switchyard/.claude/worktrees/syd-253-install-guard`.

## Citation grounding (done first)

Every identifier and line the plan cites, verified by reading the file this session:

| plan cites | verdict |
|---|---|
| `src/services/github-webhook.ts:216-223` attributed path | ✅ exact — `:222` `const attributed = resolvedRepo !== null && attributedRef(...) === ref` |
| `github-webhook.ts:194` free-text resolve | ✅ `const ref = resolveRef([pr.head?.ref], [pr.title, pr.body]);` |
| `REF_RE` at `github-webhook.ts:82` | ✅ `/\b([A-Z]{2,10}-\d+)\b/` |
| `attributedRef` in `src/services/pr-state.ts` | ✅ `pr-state.ts:105` |
| `src/services/pr-status.ts:9-12` display-only rule | ✅ verbatim |
| `pr-status.ts:28-42` `openRows` | ✅ |
| `getOpenPr` `pr-status.ts:44` | ✅ |
| `deliveryPinFor` `pr-status.ts:72-84` | ✅ |
| `getMergedPr` `pr-status.ts:101`,`:108` | ✅ (`:101` = `export type MergedPr`, `:108` = fn) |
| `src/rest/api-routes.ts:602` GET `/pr-state` | ✅ `app.get("/pr-state", ...)` |
| `ui/src/views/Review.tsx:110-113` `approve()` sends `expectedHeadSha` | ✅ |
| `src/services/triage-actions.ts:11-15` `requireHuman` | ✅ |
| `scripts/delivery-lib.ts:180-181` `buildPushArgs` | ✅ |
| `buildPrBody` via `buildPrCreateArgs`, `delivery-lib.ts:220-241` | ✅ (`buildPrCreateArgs` at `:220`; `buildPrBody` itself is `:149`) |
| `src/services/delivery-attempts.ts:105` pin requirement | ✅ `AND json_extract(e.payload, '$.pin.prNumber') IS NOT NULL` |
| `pr_state` PK `(repo, prNumber)`, nullable `issue_ref` | ✅ `src/db/schema.ts:256-274` |

No fabricated identifiers. The plan's citation hygiene is good. Everything below
is about what the citations *mean*.

---

## CRITICAL 1 — "This is additive" is false: nothing creates a `pr_state` row for a non-agent PR, and nothing would keep its status fresh

§1 asserts `pr_state` "is already the link table … This is additive." For the
entire target population — interactive `feat/`/`fix/` PRs — **there is no row to
add a column to.**

`upsertPrState` is the only writer (`src/services/pr-state.ts:184`, asserted at
`:2`). I enumerated its call sites (`grep -rn upsertPrState src scripts ui`):

- `src/services/github-webhook.ts:234` and `:253` — both inside
  `if (attributed) {` (`:222-223`). A `feat/` branch falls through to `:259-304`,
  the display-only `record()` path, which writes an **event** and never touches
  `pr_state`.
- `src/services/delivery-events.ts:90` — guarded by
  `` const branch = `agent/${issue.ref}`; if (attributedRef(db, repo, branch) === issue.ref) `` (`:88-89`) — synthesizes the agent branch, so also agent-only.
- `scripts/backfill-pr-state.ts` — the one-time SYD-207 load.

So today, a `feat/` PR has **zero** `pr_state` rows. Adding `link_source` to a
table with no rows for the population you're fixing accomplishes nothing on its
own. The plan never says who creates the row.

Worse, the second half is unspecified and load-bearing: **who keeps the row's
`status` correct afterwards.** Suppose `link_pr` creates a row (it must invent a
`status`, `headSha`, `url` — `PrObservation` requires `status: PrStatus`,
`pr-state.ts:50-64`). The PR later merges. The merge webhook arrives, `attributed`
is still false at `github-webhook.ts:222`, so `upsertPrState` is never called and
the row stays `status='open'` **forever**. Then:

- `getMergedPr` (`pr-status.ts:116` `AND ps.status = 'merged'`) returns null →
  the plan's own headline regression test (plan L213-214, "`done_without_merged_pr`
  does not fire for an issue with a confirmed link and a merged PR") **cannot
  pass**, because `doneWithoutMergedPr` (`src/services/deviation.ts:119`) only
  suppresses on `openPr !== null || merged !== null`.
- `getOpenPr` returns a permanently-open PR → the claim gate
  (`src/services/issues.ts:271-274`) blocks that issue forever, with no event that
  ever clears it.

**Required:** state explicitly that a declared link makes a PR eligible for
`upsertPrState` — i.e. widen the gate at `github-webhook.ts:222` from
`attributedRef(...) === ref` to `attributedRef(...) === ref || declaredRef(...) === ref` —
and say what happens to the parallel display-only `record()` write at `:259-304`
for the same PR (today it is the only writer of those events; if both fire you get
two `gh_pr_merged` events for one merge, the exact drift class SYD-206/207 deleted).

---

## CRITICAL 2 — `proposed` **and** `confirmed` links both reach delivery authorization, and the delivery worker *closes* the PR. §4's scope line is not enforced by anything.

§4 claims a link "does not make it deliverable" and characterises the failure as
"push a branch that does not exist, manufacturing the 'no branch to rebase'
failure." Both halves are wrong.

**Route A — via `getOpenPr` (the `proposed` tier).** The plan's §1 table assigns
"delivery authorization" to `deliveryPinFor`. It isn't. The done-stamp pin is
minted from **`getOpenPr`**:

- `src/services/issues.ts:436` `const open = getOpenPr(tx, current.id);`
- `:453` `donePin = { repo: open.repo, prNumber: open.prNumber, headSha: open.headSha };`
- `:471` `payload: { from, to, ...(donePin ? { pin: donePin } : {}) }`
- `src/services/delivery-attempts.ts:105` selects on
  `json_extract(e.payload, '$.pin.prNumber') IS NOT NULL`.

`getOpenPr` is the tier the plan deliberately opens to **agent-declarable
proposals**. So: agent calls `link_pr` → `proposed` row → human stamps done →
pin → delivery worker picks it up.

The existing code says this in its own words at `scripts/deliver.ts:568-579`:

> "pin-less done-stamps are interactive work (no agent PR), not delivery
> authorizations, and are skipped silently."

*That* is the only mechanism keeping interactive work out of delivery today, and
this design removes it without replacing it.

**Route B — via `deliveryPinFor` (the `confirmed` tier), which the plan's own
table blesses.** `redeliverIssue` (`src/services/triage-actions.ts:112`) reads
`deliveryPinFor`, and `:119` `const restampable = current.status === "done" && pin?.status === "open";`.
The UI renders that as a one-click button: `ui/src/views/IssueDetail.tsx:287-303`
(`RestampBanner`, shown when `status === "done" && openPr`) wired at `:490`
`onRestamp={() => act(() => redeliverIssue(refId, data.openPr?.headSha ?? undefined))}`.
So a *confirmed* interactive link produces a "📦 PR #N is open but hasn't been
delivered yet" banner with a working button that authorizes delivery. No
`proposed`-tier subtlety needed.

**What delivery then does — `scripts/deliver.ts:382-400`:**

```
if (rebase.status === "no-branch") {
  ... await postComment(... noBranchBounceComment ...)
  ... await postDeliveryEvent(... delivery_failed ...)
  await closeDeadAgentPr(project.repo, prNumber, { deleteBranch: false })
```

It **closes the human's PR** (`:397`), posts a public "Delivery FAILED" comment,
and stamps `delivery_failed` on the issue. §4 describes this as a benign statistic
("already 3 of 16 sampled delivery failures"). It is a destructive action against a
human-authored PR, reachable by an agent-created proposal plus one ordinary
Approve click.

**Required:** the scope line needs a *mechanism*, not a paragraph. Concretely one
of: (a) exclude non-`branch` links from the done-stamp pin at `issues.ts:436` (use
a branch-only read there, distinct from the claim-gate read), and from
`redeliverIssue`'s `restampable`; or (b) gate `deliverPending` on the pin's branch
shape. The plan's test "An interactive issue with a confirmed link is **not**
selected by `listPendingDeliveryAuthorizations`" (L219-220) is unimplementable as
written, since that query's only criterion is pin presence.

---

## CRITICAL 3 — the §1 consumer table lists 3 readers; there are at least 9, and two of them read `pr_state` in raw SQL that a `pr-status.ts` filter would never touch

The whole design rests on "reads split by which direction the failure hurts."
That split is only safe if the split is exhaustive. It isn't. Full enumeration
(`grep -rn "deliveryPinFor\|getOpenPr\|getMergedPr" src scripts ui/src` plus
`grep -n "pr_state" src/services/attention.ts`):

| reader | site | in plan's table? | effect of admitting `proposed` |
|---|---|---|---|
| claim gate | `issues.ts:271` | yes | intended |
| **done-stamp pin** | `issues.ts:436` | **no** — mis-assigned to `deliveryPinFor` | CRITICAL 2 |
| `doneWithoutMergedPr` | `issues.ts:458`, `deviation.ts:119` | partly | ok |
| `open_pr_not_in_review` deviation | `deviation.ts:80-87`, live-recomputed at `:132`, fanned out by `emitProcessDeviations` `:175-198` | **no** | a stale/wrong proposal on a `todo` issue emits a webhook notification "PR #N is open but issue is todo" |
| `merged_pr_not_done` | `deviation.ts:69-78` | yes | ok |
| REST issue view / list | `api-routes.ts:244`, `:261` | **no** | UI shows a proposed PR as *the* PR |
| `open_pr` search filter | `api-routes.ts:229-232`, `src/services/search.ts:22` | **no** | filter semantics change |
| **auto-dispatch suppression** | `scripts/worker-select.ts:19-26`, `:373-383` (consumes the feed's `openPr`) | **no** | an agent-created proposal silently suppresses dispatch of any `todo` issue |
| **`delivery_failed` auto-clear** | `src/services/attention.ts:61-68` — raw SQL: `SELECT 1 FROM pr_state ps ... AND ps.status='merged' AND ps.last_transition_event_id > latest.eventId` | **no** | see below |
| `done_without_merged_pr` auto-clear | `attention.ts:85-91` — raw SQL, same shape | **no** | ditto |

The `attention.ts` pair is the sharpest: they do **not** call `pr-status.ts` at
all, so a `link_source` filter added to `openRows`/`deliveryPinFor`/`getMergedPr`
leaves them wide open. And `attention.ts:16-21` states exactly why that matters:

> "Clearing a delivery failure re-authorizes an actual merge+deploy, so the
> evidence has to be the authoritative kind."

Under this design a `proposed` merged row would auto-clear the single
highest-authority flag in the system. Whatever tier split you land on, the plan
must name `attention.ts:61-68` and `:85-91` as surfaces to change, or the
implementation will miss them.

---

## MAJOR 4 — the motivating statistic is off by roughly 3×, in the direction that inflates the problem

Plan L27-28: "interactive work — **35 of the last 37 merges on this board** — can
never produce an authoritative link."

Measured on this repo:

```
$ git log --merges -400 --pretty=format:'%s' | grep '^Merge pull request' \
    | head -37 | sed 's/.*from MobilityLabs\///' | awk -F/ '{print $1}' | sort | uniq -c
  26 agent
   9 feat
   2 fix
```

26 of the last 37 PR merges are on `agent/` branches — the path that *does*
produce an authoritative link. The non-agent share is 11/37 ≈ 30%, not 35/37 ≈ 95%.
(Squash merges don't hide the rest: only 3 of the last 60 non-merge first-parent
commits match the `(#N)` squash pattern.)

The design is still motivated — 11 blind merges in 37 is real, and SYD-253 is a
concrete false positive — but the number as written would lead a reader to
conclude the authoritative path covers 5% of merges when it covers ~70%. If
"merges on this board" means something else (issues stamped done without a
`pr_state` row?), say so and show the query; as written it reads as branch shares
and is contradicted by the git history.

---

## MAJOR 5 — the backfill's stated data source does not contain the data its rule requires

Migration step 3: "re-scan into *proposals* from the `gh_pr_opened` events already
recorded, **only where the PR's title and body contain exactly one distinct ref**."

The recorded `gh_pr_opened` payload is written at `github-webhook.ts:261-268`:

```
record(db, ref, "gh_pr_opened", { prNumber, url, branch, headSha, ghUpdatedAt }, resolvedRepo, byPrNumber)
```

**No `title`, no `body`.** The one-ref rule cannot be evaluated from those events.
Compounding it, each such event is already attached to the issue chosen by
first-regex-match (`resolveRef`, `:194`), so the event set is *pre-contaminated by
exactly the bug the backfill is meant to avoid* — a #221-shaped PR is already
filed under whichever ref appeared first, and a backfill "from the events" would
faithfully reproduce that wrong binding.

**Required:** the backfill must read titles/bodies from GitHub (`gh pr list --json
number,title,body,headRefName,state`), not from the event log; or the plan must
add title/body to the recorded payload first and accept that only PRs opened after
that change are backfillable.

---

## MAJOR 6 — trailer parsing: fenced/quoted matches, and four unspecified boundaries

I probed the natural reading of "anchored line, exact key" (`/^Switchyard-Issue: ([A-Z]{2,10}-\d+)$/m`) with node:

| input | matches? |
|---|---|
| inside a ```` ``` ```` code fence | **true** |
| inside a `> ` quoted reply | false |
| `switchyard-issue: SYD-253` (lowercase key) | false |
| `Switchyard-Issue: SYD-253 ` (one trailing space) | false |
| `  Switchyard-Issue: SYD-253` (indented) | false |
| CRLF body, regex form | true |
| CRLF body, `split("\n")` + string equality | **false** |
| two trailer lines with different refs | yields both |

Consequences to spec:

1. **Code fences match.** The PR that *implements this feature* will contain
   `Switchyard-Issue: SYD-NNN` in its own description/docs examples and will
   declare that link. This is the PR #221 failure mode reproduced on the
   *declared* channel, which the plan exempts from the one-ref rule.
2. **Trailing space / lowercase key / indentation silently produce no link.** The
   plan names "a human can type it in the GitHub UI" as a first-class channel;
   strict-by-default means that channel fails silently and invisibly. Decide and
   state: trim trailing whitespace? case-insensitive key (git's own trailer
   convention is)? The current text ("exact key") implies no on both.
3. **Two trailer lines with different refs** is not covered. The plan's malformed
   list is "not anchored, wrong key, two refs" — that reads as two refs on *one*
   line. Two lines is a distinct case and must be specified (I'd say: refuse, same
   as multi-ref free text).
4. **Precedence** between a valid trailer and a multi-ref body is stated nowhere.
   A PR with `Switchyard-Issue: SYD-253` in a trailer and `SYD-100` in prose: does
   the trailer win, or does multi-ref suppression apply? The §2 table lists them
   as independent rows with no ordering.
5. `split("\n")` + equality is a natural implementation of "exact" and is broken by
   CRLF, which GitHub bodies carry. Worth a line in the plan since the trap is
   invisible in tests written with `\n` literals.

---

## MAJOR 7 — "confirmation rides the review action" names one of three done-stamp surfaces, and the confirm is blind

§3 builds on `Review.tsx`'s `approve()`. There are three human paths that send
`expectedHeadSha` on a move to done:

- `ui/src/views/Review.tsx:113` — `expectedHeadSha: current.openPr?.headSha ?? undefined`
- `ui/src/views/Board.tsx:59` — `expectedHeadSha: status === "done" ? (issue?.openPr?.headSha ?? undefined) : undefined` (drag-to-done)
- `ui/src/views/IssueDetail.tsx:433` — the status `<select>`, same expression

If only `Review.tsx` carries the confirm payload, a human who drags a card to done
confirms nothing — the link stays `proposed` — while (per CRITICAL 2) still
minting a delivery pin. Two of three doors give you the dangerous half without the
deliberate half.

Second problem, in all three: `expectedHeadSha` is **auto-filled from the API's
`openPr`**, which under this design may be an agent-authored proposal. So "the
human affirms *which PR* and *which head* in a single act" (§3, and the argument
for unblocking the `approved`-state design) is a click on a value the human never
saw or chose. §3 requires a human choice when there are 2+ proposals but is silent
on displaying the single proposal. Whatever "confirmation" means for the
`approved`-state proof, it has to be a UI element that *shows the PR being
confirmed* — otherwise the confirmed tier inherits the proposed tier's
trustworthiness.

---

## MAJOR 8 — multi-ref PRs: does the *event* still get recorded, and where?

§2's table says free-text with "zero or multiple distinct refs" yields "nothing".
Ambiguous between "no proposal" and "no record at all", and both readings have
costs the plan doesn't price:

- **"No proposal, events unchanged"**: the display `gh_pr_opened`/`gh_pr_merged`
  event still lands on the first-match issue (`resolveRef`, `:194` →
  `record()` at `:261`). SYD-277's class of bug is *not* made "harmless by
  construction" (§1) — the wrong-issue timeline entry remains, and
  `attention.ts:85-91`'s SYD-267 arm clears `done_without_merged_pr` on **any**
  `gh_pr_merged` event on the issue, so a misattributed display event still
  silences a real flag.
- **"No record at all"**: multi-ref PRs vanish from issue timelines entirely — a
  visible regression, and it removes the very events migration step 3 wants to
  scan.

Pick one and say so, and reconcile it with the SYD-267 arm at `attention.ts:92-104`.

---

## MINOR 9 — test-coverage gaps beyond the listed suite

The listed tests are good on the parser and the tier split. Missing, in
descending value:

1. **No end-to-end delivery-exclusion test.** L219-220 tests
   `listPendingDeliveryAuthorizations` for a *confirmed* link but nothing for the
   `proposed` → done-stamp → pin chain (CRITICAL 2's actual route). Test the pin
   payload of the `status_changed` event, not just the selection query.
2. **No round-trip test of the emitted trailer.** The plan asserts the worker
   "already composes the body" (`buildPrBody`, `scripts/delivery-lib.ts:149-169`) —
   which today emits `Agent work for Switchyard issue **SYD-253**.` and an
   `Issue: <url>/issue/SYD-253` line, and **no trailer at all**. Assert
   `parseTrailer(buildPrBody(ref, url)) === ref` rather than trusting the prose.
3. **No `attention.ts` test** for either auto-clear arm under `proposed`/`confirmed`.
4. **No `selectDispatchable` test** that a proposal on a `todo` issue does/doesn't
   suppress auto-dispatch (`scripts/worker-select.ts:394+`).
5. **No test that a linked non-agent PR's `pr_state` row transitions open→merged**
   (CRITICAL 1's second half). Without it, the "confirmed link + merged PR" test
   can be made to pass by hand-writing a `merged` row in the fixture, and the
   production path stays broken.

## MINOR 10 — doc-string and message sweep (the plan lists none; here is the full set)

Every string below asserts agent-branch-only attribution and becomes false. I
checked each by reading the line:

- `src/db/schema.ts:261-262` — "Set only from the strict `agent/<ref>` branch match … display-only PRs keep it null."
- `src/services/pr-state.ts:25-28` — "Free-text ref scans never reach this function."; `:103-104` `attributedRef` docstring
- `src/services/pr-status.ts:9-12` — the display-only/claim-gating rule the plan quotes
- `src/services/github-webhook.ts:216-221` — "Everything else … never touches pr_state"
- `src/services/attention.ts:11-21` — "strict `agent/<ref>` attribution is deliberate … only an explicit human resolve does"
- `src/services/triage-actions.ts:123` and `:127` — user-facing: "no open agent PR on a done issue to re-stamp", "has no agent PR on record"; plus `:93`, `:115`, `:155-158`, `:171-174`
- `src/services/issues.ts:245`, `:253`, `:428`, and user-facing `:440` "open agent PR #N has no recorded head SHA yet"
- `src/mcp/server.ts:264` — "Stamping status: done over an issue with an open agent PR authorizes delivery"
- `src/services/search.ts:22` — "still-open agent PR"
- `ui/src/views/IssueDetail.tsx:264` — "a merged pr_state row, which strict `agent/<ref>` attribution never produces"
- `scripts/github-poll-lib.ts:154-156` — "must stay in lockstep with the server's `refFromBranch` … `upsertPrState` only ever attributes rows whose branch matches this" (this one is a *correctness* coupling, not just prose: if the server widens attribution, the poller's `AGENT_BRANCH_RE` comment and any logic keyed to it need review)
- `scripts/github-poll.ts:248`, `scripts/github-poll-lib.ts:164`, `:189` — the broken-binding warnings
- `CLAUDE.md` — the `claim_issue` invariant bullet ("sitting behind an open agent PR from a prior claim")

## MINOR 11 — smaller precision points

- §1 "`openRows` … gates **purely** on `ps.issue_ref = <ref>`" — it also requires
  `ps.status = 'open'` (`pr-status.ts:38`). Small, but "purely" is what makes the
  additive claim sound free.
- `link_source TEXT NOT NULL DEFAULT 'branch'` on a row whose `issue_ref` is NULL
  claims `branch` authority for a nonexistent link. Harmless today (all reads join
  through `issue_ref`), but state that `link_source` is meaningless when
  `issue_ref IS NULL`, and define the NULL→`proposed` transition — §2's conflict
  rule covers only overwriting an existing `branch`/`confirmed` link.
- Migration note 1 is right that drizzle enums are compile-time only:
  `schema.ts:263` declares `status` with `{ enum: [...] }` and no CHECK, so
  `link_source` will accept any string at the SQL layer. Given that, the plan
  should say which layer rejects an unknown `link_source` — `listPrState`
  (`pr-state.ts:89-94`) is the precedent for throwing on an invalid status.
- The 2026-07-26 timeline (plan L40-50) I could not verify — it depends on the
  live board DB, which isn't in the worktree. Not disputed, just unchecked.
- HYPOTHESIS (unverified, flagged per instructions): the poller re-emits every
  windowed PR each tick (`scripts/github-poll-lib.ts:113-118`, verified) — so *if*
  CRITICAL 1 is fixed by widening the `attributed` gate, linked `feat/` PRs would
  get status upkeep for free while inside the poll window, and `selectRefreshCandidates`
  (`:140-152`) would extend that to open rows outside it. I read the emit logic but
  did not run the poller; treat the "for free" part as a hypothesis to confirm
  during implementation.

---

## What I'd want changed before implementation

1. Specify the `pr_state` **row lifecycle** for non-agent PRs — creation *and*
   status upkeep — not just the new column (CRITICAL 1).
2. Give §4's scope line a mechanism at `issues.ts:436` and
   `triage-actions.ts:112/119`, and state plainly that today's failure mode
   includes `closeDeadAgentPr` closing the human's PR (CRITICAL 2).
3. Replace the 3-row consumer table with the full 10-row surface list, explicitly
   including the two raw-SQL readers in `attention.ts` (CRITICAL 3).
4. Fix or source the 35-of-37 figure (MAJOR 4).
5. Re-source the backfill off GitHub rather than `gh_pr_opened` events (MAJOR 5).
6. Nail the trailer grammar: fences, case, whitespace, multi-line, and
   trailer-vs-prose precedence (MAJOR 6).
7. Cover all three done-stamp UI surfaces and make the confirm show what it
   confirms (MAJOR 7).

The core idea — declared beats guessed, propose freely / confirm deliberately,
tier the reads by failure direction — is sound and is the right root-cause fix. The
tiering just has to be applied to the readers that actually exist.

VERDICT: REVISE — concerns above should be addressed first
