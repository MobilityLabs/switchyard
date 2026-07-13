# Merge/Sync Bug Assessment & Simplification Plan (rev 4)

> 2026-07-12 — codebase review prompted by recurring merge and state-sync bugs.
> Evidence gathered from git history, the SYD board, and a read of the sync-related
> subsystems (`src/services/pr-status.ts`, `github-webhook.ts`, `stale-claims.ts`,
> `deviation.ts`, `attention.ts`, `issues.ts`; `scripts/deliver.ts`, `delivery-lib.ts`,
> `delivery-exec.ts`, `github-poll*.ts`, `worker-select.ts`, `agent-worker.ts`).
> Rev 2 incorporated a five-reviewer panel (codex/gemini/fable/opus/pentester) —
> ordering rules, delivery-attempt generations, a restructured Step 3, lease-token
> hardening, and a named regression-test suite. Rev 3 closes the panel's round-2
> findings on rev 2's own mechanisms: named freshness producers for every
> security-relevant field (`synchronize`, poller `headRefOid`), a cutover backfill,
> live-GitHub reads for irreversibility decisions, lease reclaim-as-takeover, the
> SHA-chain threat model, and CI hardening as Step-3 prerequisites. Rev 4 is the
> round-3 verification batch: the SHA chain is now a coherent end-to-end spec
> (compare-and-set stamp → persisted derived SHA → live check read → expected-head
> merge guard), the backfill is bound to the same write-path invariants as every
> other writer, lease takeover is opt-in, and the deploy-skew/enum/preflight gaps
> are closed.
>
> **Rev 3 rule (generalizes the round-2 findings):** every mechanism that reads
> `pr_state` for a security- or irreversibility-decision must name the producer
> that keeps that field fresh, and must fall back to a live GitHub read when
> deciding whether an irreversible action already happened. The replica is for
> steady-state reads; it never adjudicates "did the merge land."

## TL;DR

The constant merge/sync bugs aren't many bugs — they're **one architectural decision
failing repeatedly**: Switchyard reconstructs GitHub's state (is there an open PR? did
it merge?) from a best-effort, append-only event log fed by four different producers,
instead of treating GitHub as the source of truth and caching it. Every incident since
SYD-93 is that replica drifting, and every fix so far has *added* another guard,
dedupe, or reconcile loop instead of removing the redundancy. The codebase now has
13 anti-double-work guards, 3 hand-maintained "which events count as terminal" lists,
a poller that deliberately re-emits duplicates, and a reconcile pass that exists only
to heal the other mechanisms. That's the complexity to replace with one well-specified
state table — **and the replacement must carry an explicit ordering discipline, or it
rebuilds the same drift class in a new home.**

## Verified platform constraints (load-bearing for Step 3)

Checked live against GitHub during review:

- `MobilityLabs/switchyard` is **private** (`gh repo view` → `isPrivate: true`).
- The org is on the **Team plan** (`gh api /orgs/MobilityLabs` → `plan: team`).
- `allow_auto_merge` is currently **false** (enableable on Team, but see Step 3 —
  we deliberately do not use native auto-merge).
- **GitHub merge queue is unavailable** to private repos outside Enterprise Cloud —
  so "let the merge queue do it" is not an option here without going public or
  upgrading. Step 3 is scoped around this.
- A GitHub Actions workflow **already exists** (`.github/workflows/ci.yml`) running
  npm ci → typecheck → build:ui → test on `pull_request` — CI-as-check-authority is
  an extension of current reality, not a new surface.
- Inbound GitHub webhooks are already HMAC-SHA256 verified
  (`src/rest/github-routes.ts:11,22,80-81`) — the webhook producer is authenticated.

## The evidence

### One fact, four producers, two vocabularies

"This PR merged" can be written as `delivered` (by the delivery worker's own merge,
or by its reconcile backfill) or as `gh_pr_merged` (by the GitHub webhook, or by the
poller). "PR opened" is similarly `pr_opened` (worker self-publish,
`scripts/agent-worker.ts:448-455`) or `gh_pr_opened` (webhook/poller, both funneling
into `src/services/github-webhook.ts:164-178`).

Event kinds are free-text strings with no registry (`src/db/schema.ts:105`), so
consumers each maintain their own IN-list of what counts as terminal:

- `src/services/pr-status.ts:40` — `getOpenPr` close-set: `delivered` + `gh_pr_merged` + `gh_pr_closed`
- `src/services/pr-status.ts:68` — `getMergedPrEvent`: `delivered` + `gh_pr_merged` (no `gh_pr_closed`)
- `src/services/attention.ts:31` — attention-clear: `delivered` + `gh_pr_merged` (no `gh_pr_closed`)

Three *different* hand-synced sets over the same producers. When they drift — or when
a producer gap leaves an event unwritten — you get exactly the open bugs on the board:

- **SYD-202** — requeued delivery merges under a new PR number, so the original
  `pr_opened` never matches a close → permanent phantom "not merged" on done cards.
- **SYD-176** — closed-unmerged agent PRs (#82/#80/#76) leave the open-PR signal stuck.
- **SYD-177** — claim gate blind to PRs with no recorded `pr_opened` event
  (SYD-108 was double-worked via PR #61 vs #124).
- **SYD-178** — `delivery_failed` flag permanent when the fix merges via a
  non-agent branch.
- **SYD-179** — SYD-157 marked done but never merged to main.

The patch layers that exist to hold this together:

1. `isDuplicate` per-(issue, type, prNumber) dedupe — `github-webhook.ts:110-124`.
   *(Rev 2: this one is NOT deleted — see Step 1; it also protects `gh_pushed` and
   `gh_checks_*` audit events that `pr_state` gives no protection.)*
2. Poller re-emits `opened` **every tick**, relying on server dedupe (SYD-177 heal) —
   `github-poll-lib.ts:110-113`, `github-poll.ts:26-28`.
3. Poll-state advance-after-all-POSTs so failed POSTs re-emit next tick —
   `github-poll.ts:141-145`.
4. Per-prNumber close matching (SYD-125) — `pr-status.ts:4-7,37-42`.
5. Oldest-first Map-overwrite for "somehow more than one open PR" — `pr-status.ts:19-21,44,54-56`.
6. Reconcile pass (SYD-94): a *third* merged-detector that live-queries `gh` and
   synthesizes `delivered` — `deliver.ts:512-552`, `delivery-exec.ts:138-149`.

### Two oracles that can disagree

The claim gate reads PR-open from the event log (`getOpenPr`,
`src/services/issues.ts:182`), while the delivery worker's merge gate reads it live
from `gh pr list` (`deliver.ts:353` → `delivery-exec.ts:126-132`). When they disagree,
delivery skips with only a log line (`deliver.ts:354-356`) or the claim gate
blocks/allows wrongly.

Known producer gaps that make disagreement routine:

- The poller only emits `closed`/`merged` for PRs it previously tracked as OPEN
  (`github-poll-lib.ts:92-116`) — a repo linked after a PR merged never gets
  `gh_pr_merged`. (Note: the poller's scan is also windowed — `--limit 50`,
  sorted by `updated-desc`, via GitHub's eventually-consistent search API —
  `github-poll-exec.ts:23`.)
- A manual human merge with no done-stamp never triggers the delivery worker, so
  no `delivered`; if the webhook missed it too, merged-state never lands.
- `finishDelivery`'s `delivered` POST is `.catch`-swallowed (`deliver.ts:236-243`) —
  merged on GitHub, board never told, and only the reconcile pass (and only if the
  issue happens to carry `delivery_failed`) can repair it.

### The delivery worker is a hand-rolled GitHub merge queue

~1,850 lines (`deliver.ts` 674, `delivery-lib.ts` 786, `delivery-exec.ts` 385) that:

- rebase onto main + force-push (`delivery-exec.ts:267-295`),
- run a verify gate (npm ci → typecheck → build:ui → vitest) in a clean clone
  (`delivery-exec.ts:241-253`),
- poll GitHub's async `mergeable=UNKNOWN` recompute (`delivery-exec.ts:181-190`),
- merge with a 3-attempt race-retry loop (`deliver.ts:261-338`,
  `MAX_QUEUE_MERGE_ATTEMPTS` in `delivery-lib.ts:677`),
- strip known-noise lines so the real error survives the comment tail
  (`delivery-lib.ts:748-786`),
- and track progress with a cursor over a 500-event feed.

Its incident history is dominated by re-implementing CI *execution* client-side:

| Incident | What it patched |
|---|---|
| SYD-101 | clean-clone deps must be `npm ci`, not `npm install` |
| SYD-103 / SYD-152 | `mergeable=UNKNOWN` polling, then widened to first merge |
| SYD-164 | full redesign into rebase→verify→merge queue |
| SYD-168 | verify gate systemically red — never ran `build:ui` |
| SYD-170 | the gate's own `NO_COLOR` env made a test env-sensitive |
| SYD-173 | error tails drowned by tar/ssh noise |
| SYD-174 | post-merge comment failure misread as merge failure → re-rebased a deleted branch |
| #121/#122 | phantom-merged lockfile change red the `npm ci` gate |

The cursor design also has a *known unrecoverable* loss mode: if the cursor falls out
of the 500-event window, done-stamps are silently never delivered
(`delivery-lib.ts:96-103` warns and moves on — no recovery path).

### Claims protect actors, not sessions

`assertClaimable` early-returns when `assigneeId === actor.id`
(`src/services/issues.ts:171`), so a dispatched worker session and an interactive
session sharing the worker token can both "own" an issue — the residual SYD-93 hole
that the SYD-122 host-side pre-claim narrowed but cannot close. Thirteen distinct
guards have accumulated around this lifecycle. Meanwhile release is time-based
guesswork: a healthy container that's been quiet for `claims.stale_seconds` (4h
default) gets released to `todo` and re-dispatched while still running
(`stale-claims.ts:32-38`).

## The plan, in order

### 1. Make PR state a mutable table with one write path *(biggest win — kills the bug class)*

Add a `pr_state` table keyed by **(repo, prNumber)**: branch, issueRef, status
`open|merged|closed`, headSha, `ghUpdatedAt` (GitHub's remote timestamp, not local
insertion time), `lastTransitionEventId` (for deviation episode markers), updatedAt.

**Ingestion prerequisites (rev 3 completes the sweep):**

- **Repo identity everywhere.** The webhook handler reads `repository.full_name` for
  secret selection then discards it (`github-webhook.ts:65,147`), the poller payload
  omits repo (`github-poll-lib.ts:50`), and `/github-events` accepts only
  `{event, payload}` (`schemas.ts:84`). All gain a required `repo` field.
- **The delivery-events surface too** — two of the four `upsertPrState` callers flow
  through `POST /api/issues/:ref/delivery-events`, not `/github-events`:
  `deliveryEventBody` (`schemas.ts:48`), `DeliveryEventInput` + `recordDeliveryEvent`
  (`delivery-events.ts:15-20`), and the route (`api-routes.ts:232`) gain `repo`, and
  `pr_opened` gains **`headSha` and `ghUpdatedAt`** (the worker sources both from a
  `gh pr view --json headRefOid,updatedAt` right after `gh pr create`/merge — it
  already shells `gh`, so the stated per-writer timestamp contract has a real field
  to land in). Without `headSha` here, `pr_state.headSha` has no producer at publish
  time for agent PRs.
- **`synchronize` is handled.** Today the webhook processes only `opened`/`closed`
  (everything else falls through, `github-webhook.ts:160-180`); rev 3 handles
  `synchronize` (GitHub's action on every push to the PR branch) and `reopened`,
  updating `headSha` + `ghUpdatedAt`. Without `synchronize`, the Step-3 SHA pin
  would compare against a head recorded at PR-open and silently degrade to no
  protection (round-2 CRITICAL).
- **Poller fetches head + timestamp.** `PR_FIELDS` (`github-poll-exec.ts:19`) gains
  `headRefOid` and `updatedAt`, and the poller payload carries both, so poll-only
  repos keep `headSha`/`ghUpdatedAt` fresh too.

**One write path, several callers.** A single `upsertPrState()` service function is
the only code that writes the table. Its callers: the webhook handler, the poller,
the worker's PR-publish step (replacing the bare `pr_opened` self-publish, so the
claim gate closes at publish time even on poll-only repos — no freshness window), and
the delivery worker's own merge (synchronous, so board state never waits on
webhook/poll lag).

**Ordering discipline (new in rev 2 — this paragraph is the load-bearing one).**
GitHub webhooks are at-least-once and unordered; the poller reads GitHub's
eventually-consistent, windowed search API. Therefore `upsertPrState()` enforces:

- **Terminal states never regress:** `merged`/`closed` can only become `open` via an
  explicitly-handled `reopened` webhook action (currently ignored —
  `github-webhook.ts` falls through for actions other than opened/closed; rev 2
  handles it) — and `reopened` is itself subject to the recency rule: it reopens
  only if its `updated_at` is **newer** than the stored terminal row's
  `ghUpdatedAt` (parsed fail-closed), so an out-of-order or redelivered stale
  `reopened` cannot regress a newer close.
- **Monotonic writes:** an upsert carrying an older `ghUpdatedAt` than the stored row
  is a no-op (`WHERE gh_updated_at <= excluded.gh_updated_at` guard). Webhook
  payloads gain `pull_request.updated_at` parsing (currently not extracted —
  `github-webhook.ts:28`), parsed defensively: a malformed or absent timestamp fails
  closed to "no transition," never to "treat as newest." **The guard's input is
  specified per writer:** webhook = `pull_request.updated_at`; poller = the new
  `updatedAt` field; the worker's publish and merge writes take their timestamp from
  a `gh pr view` of the PR they just acted on — never local wall-clock, so host
  clock skew can't out-rank later genuine GitHub updates. The monotonic guard
  governs same-status refreshes; status *transitions* are governed solely by the
  terminal-state rules above.
- **Absence is not evidence:** a PR missing from a poll result never transitions
  state. The poller is rewritten from *emit-transitions* (`diffRepoState`'s current
  never-saw-open blindness, `github-poll-lib.ts:92-116`) to *upsert-observed-state*:
  every PR it does see is upserted unconditionally. The `--limit 50` window is
  supplemented by targeted lookups: any `pr_state` row still `open` but absent from
  the recent window gets an individual `gh pr view` refresh on a slower cadence —
  reusing the existing `execFile`-argv helper (`github-poll-exec.ts:8,15`), never a
  shell string. If that refresh **fails persistently** (repo renamed/unlinked, PR
  transferred), the row must not sit silently open forever blocking the claim gate:
  past a failure threshold it raises an operator-visible staleness warning, while
  still never transitioning on error. (Acknowledged residual: a *human-opened* PR
  on a poll-only repo first observed beyond the 50-window stays invisible until it
  churns into the window — agent PRs are covered by the publish-time write.)
- **Authoritative attribution is branch-only AND repo-bound:** a `pr_state` row's
  `issueRef` is set **only** from the strict `agent/<ref>` branch match
  (`refFromBranch`) **and only when the PR's repo is the one bound to that issue's
  project** — via the real binding, `github_repos.projectId → projects.id`
  (`src/db/schema.ts:164-170`; `projectKey` exists only as an input field on the
  create bodies and resolves to `projectId`). An `agent/SYD-1`
  branch PR in a *different* linked repo records display/audit events but never
  writes SYD-1's claim-gating state — otherwise anyone with push access to any
  linked repo could drive another project's authoritative state. The free-text
  title/body ref scan (`REF_RE`, `github-webhook.ts:75,82-85`) keeps feeding
  display/audit events but never writes the state table. (Non-agent fix PRs
  referenced by text — the SYD-178 case — surface via a display-level association,
  and a human clears the flag; see Step 2's attempt model.)

**Consumers migrate together; audit events remain.** The complete migration list
(every runtime reader of `getOpenPr`/`listOpenPrByIssueId`/`getAttention`): the
claim gate, attention chips, deviation signals, done-column filters, `nextTask`'s
open-PR exclusion (`dependencies.ts:167`), REST list/detail `openPr`
(`api-routes.ts:192,214`), **the search filters** (`search.ts:51,57-58` —
`?openPr=` and `?attention=`; left unmigrated they'd become a fresh disagreeing
oracle against the claim gate), the MCP server's attention reads
(`mcp/server.ts:83,119`), `redeliverIssue`'s gate (`triage-actions.ts:97` — see
Step 2), and the delivery worker. The webhook/poller **continue to record audit
events** — which is why the UI's own event fold (`ui/src/views/IssueDetail.tsx:99-119`,
`:645-715`, a fourth consumer the original plan missed) keeps working day one;
migrating the delivery strip to `pr_state` is follow-up work, not a prerequisite.
Because audit events remain, **`isDuplicate` stays** (it also dedupes `gh_pushed`
and `gh_checks_*`, which have nothing to do with PR state). To keep the fold and
deviation episodes transition-fresh, `upsertPrState()` **co-writes the
corresponding audit event whenever it performs an actual transition**, so
`lastTransitionEventId` exists at write time even for the worker's publish path.
The co-write **replaces** the callers' direct PR-transition event writes (the
webhook handler stops recording `gh_pr_opened`/`gh_pr_merged`/`gh_pr_closed`
itself), and emits one canonical kind per transition —
`gh_pr_opened`/`gh_pr_merged`/`gh_pr_closed`/`gh_pr_reopened` — regardless of
which caller triggered it, so one physical transition never appears twice (or
under two vocabularies) in the UI fold. Delivery-*attempt* lifecycle events
(`delivery_failed`, `delivered` with its deploy result) remain written by the
delivery worker and are a separate vocabulary from PR-transition events.

**Cutover backfill (required — the rollout-safety story is false without it).**
Before any consumer cuts over, a one-time backfill enumerates `agent/*` PRs per
linked repo (`gh pr list --state all` with a high limit plus per-branch lookups à
la `findMergedAgentPr`, `delivery-exec.ts:138-149`) and upserts them into
`pr_state`. Otherwise the claim gate cuts over to an empty table — every in-flight
agent PR becomes claimable with auto-dispatch live (the SYD-93/177 class,
fleet-wide, on deploy day), and pre-migration PRs beyond the poller's 50-window
(the SYD-179 shape) would never get a row at all.

**The backfill is a fifth caller of `upsertPrState()`, not an exempt data-load:**
it routes through the same function and obeys every write-path invariant — the
repo-bound attribution rule (an out-of-project `agent/SYD-1` PR is refused at
backfill exactly as in live ingestion), and GitHub-sourced freshness: `headSha`
and `ghUpdatedAt` come from `gh pr view --json headRefOid,updatedAt` per PR,
**never cutover wall-clock** — a `now()` timestamp would out-rank every later
genuine `synchronize` under the monotonic guard and freeze `headSha` at the
backfilled value, silently reintroducing the stale-SHA-pin hole through a side
door. A **cutover preflight** additionally asserts every worker-configured
project's repo is linked *and* project-bound (`github_repos.projectId` is
nullable, `schema.ts:164` — an unbound repo would silently turn real agent PRs
into display-only rows); a preflight failure is loud and blocks cutover, and the
same assertion joins the Step-3 periodic health check so a post-cutover
repo-unbinding is caught, not just a day-one one.

Deletes: `getOpenPr`'s event-log derivation and prNumber-matching, all three
terminal-event IN-lists, the poller's re-emit-every-tick hack, the SYD-94 reconcile
pass. Fixes structurally: SYD-202, SYD-176, SYD-177, SYD-178's stuck-flag half (and
prevents SYD-179's class). Deviation's episode dedup keys off
`pr_state.lastTransitionEventId` instead of raw event scans.

### 2. Trigger delivery from state + an attempt ledger, not an event cursor

The naive replacement query ("done AND PR open AND no delivery") fails four ways the
panel traced: it spin-loops on deterministic verify failures (re-attempting a
multi-minute verify every 30s forever, starving the sequential per-ref loop); it
never retries post-merge deploy/comment failures (the PR is no longer open); it
re-fires during the merge→observation lag (the SYD-174 class); and on first rollout
it would mass-deliver every historical done-with-open-PR issue (SYD-179 included).

So rev 2 adds a **`delivery_attempts` table** — the delivery-side twin of `pr_state`:
(issueRef, prNumber, headSha, derivedHeadSha, authorizationId, startedAt,
finishedAt, outcome). The **complete outcome enum**: `merged_deployed` |
`merged_deploy_failed` | `verify_failed` | `conflict_bounced` | `merge_failed` |
`checks_timeout` | `sha_chain_disarmed` | `skipped_rollout`.
`authorizationId` is the event id of the human done-stamp or `redeliver_requested`
event that authorized the attempt.

**Authorizations are compare-and-set and SHA-pinned — both kinds.** The done-stamp
*and* the Retry (`redeliver_requested`, today an empty event —
`triage-actions.ts:101`) each pin (repo, prNumber, headSha) at click time, and the
pin is what the human *saw*, not what the replica holds at write time: the client
submits the head SHA it displayed, and the server rejects the authorization if
that no longer equals the current head (the "dismiss stale approvals on push"
shape — a third-party push landing seconds before the click is not silently
authorized). After a `sha_chain_disarmed` outcome specifically, Retry must surface
the old→new head delta before minting a new authorization — otherwise one
reflexive click re-pins the very push the disarm just refused.

The per-tick trigger becomes: *issues whose **current status is `done`** with a
done-stamp or redeliver authorization that has **no attempt row for that
authorizationId*** — the status predicate means a human who stamps done and then
retracts it before the tick disarms the pending authorization instead of getting
a merge they just un-stamped. Properties:

- **Once per human trigger** — a verify failure or bounce writes its attempt row and
  the ref goes quiet until a human re-stamps or clicks Retry (`redeliver_requested`
  stays, as the explicit re-authorization). **Failed attempts still record a
  `delivery_failed` audit event** — that is what lights the attention chip and what
  `redeliverIssue` gates on (`triage-actions.ts:94-99`), so the Retry button keeps
  working by construction, not by assertion. A Step-3 SHA-chain disarm records the
  same `delivery_failed`-class outcome, giving it the same Retry affordance (a
  done→done re-stamp emits no event, so Retry is the practical re-authorization
  path).
- **Post-merge deploy failures retry independently**: a second query — attempts with
  outcome `merged_deploy_failed` — drives deploy-only retries (bounded, with
  backoff); no rebase/merge machinery touches an already-merged PR (SYD-174 fixed
  by construction, not by comment-scoping).
- **Crash-safe, adjudicated live**: an attempt row written at start with no finish
  is resumed on restart by consulting **GitHub directly** (`gh pr view` — did the
  merge land?), never `pr_state`. The dangerous crash is precisely the one between
  `gh pr merge` succeeding and the synchronous `pr_state` write — the window where
  the replica still says `open`; trusting it there re-creates SYD-174 (rebase of a
  deleted branch). Per the rev-3 rule: the replica never adjudicates whether an
  irreversible action already happened.
- **Rollout is explicit**: the migration writes synthetic attempt rows (outcome
  `skipped_rollout`) for every pre-existing authorization **of both kinds —
  done-stamps AND `redeliver_requested` events** (a historical Retry on a
  still-done issue is an authorization too; covering only stamps would leave it
  unfulfilled and fire a day-one unattended delivery), so the trigger query sees
  all historical authorizations as fulfilled on day one and fires nothing.
  **The migration and the trigger derive the authorization set from the identical
  predicate/source** — any done-stamp the migration's enumeration missed but the
  trigger's scan sees would become a day-one unattended delivery, so this parity
  is an invariant with its own test, not an implementation detail. Pre-existing
  done+open-PR issues surface in the (backfilled — see Step 1) "not merged"
  done-column filter for humans to redeliver deliberately.
- The `delivered` event is still *recorded* for the audit trail/UI, but nothing
  triggers off it — the attempt ledger is the source of truth, which keeps Step 1's
  "no state derived from events" thesis intact (the ledger is a table, not an event
  scan).

The cursor file, its atomic-rename dance, and the `feedGap` loss mode disappear.

### 3. CI is the check authority; the worker stays merge orchestrator (SHA-pinned)

**What we verified (see constraints above):** merge queue is unavailable here, and
native auto-merge both (a) drops the tested-against-current-main guarantee under
batch stamping — checks ran against pre-batch main, so N green PRs land untested
against each other (the SYD-78 incident class) — and (b) is a TOCTOU against the
"merging is a human decision" invariant: auto-merge armed at stamp time persists
across later agent pushes, so a worker push after the human stamp would merge code
no human authorized. **Therefore: no native auto-merge.** The restructured step:

- **Delete the CI-runner half of the worker.** `runVerification`'s clean-clone
  npm ci/typecheck/build:ui/vitest execution, the noise-stripping/`tailOf`
  apparatus, and the post-merge verify backstop all go. The existing
  `.github/workflows/ci.yml` (extended per-repo — which also fixes SYD-169's
  missing-scripts problem and gives agents worker-parity checks, SYD-166) is the
  sole check authority; the worker *reads* check conclusions from GitHub
  (`pr_state`/checks API) instead of recomputing them. This deletes the incident
  classes SYD-101/168/170/173 outright.
- **Keep a slimmed merge orchestrator.** The worker retains rebase-onto-main +
  force-push (`attemptAutoRebase`) and the main-moved retry loop — on this GitHub
  plan, *something* must serialize "rebase, wait for green on the rebased head,
  merge," and it's the worker. Wait-for-checks replaces `pollUntilMergeable` as the
  gate (mergeability polling survives only as a pre-merge sanity check), and is
  **bounded**: a configurable timeout (like `shouldRetryMergePoll` today,
  `delivery-exec.ts:181-190`) after which the attempt records `delivery_failed`
  and goes quiet per Step 2 — a GitHub Actions outage must not stall the
  sequential per-ref loop indefinitely.
- **SHA-pinned authorization (the TOCTOU fix) — the chain, end to end, with two
  distinct SHAs named.** Call the human-authorized head **S0** (pinned
  compare-and-set at stamp/Retry time per Step 2, kept fresh by the Step-1
  producers: `synchronize` webhook, poller `headRefOid`, publish-time write) and
  the post-rebase head **S1**. The chain of custody:
  1. **Pre-rebase anchor:** the worker asserts *fetched* branch head == S0 before
     rebasing — the live anchor; without it a third-party commit would be
     laundered into "a rebase the worker performed."
  2. **Persist the derived SHA:** the worker writes S1 into the attempt row
     (`derivedHeadSha`) immediately after the rebase/force-push. This is also what
     lets crash resumption re-anchor — a restart that finds the branch at S1 with
     a persisted S1 knows it's looking at its own rebase, not a third-party push,
     instead of disarming after every mid-attempt crash.
  3. **Live check verification:** at merge time the server reads the
     required-check conclusion for **S1 live from GitHub** (checks API / `gh pr
     view`) — never from `pr_state` or recorded `gh_checks_*` events (those are
     at-least-once webhook replicas; per the rev-3 rule, irreversible decisions
     read live). The comparison is: *the head GitHub is about to merge == the
     head whose required checks concluded green == S1, and S1 was derived from
     S0 by our own recorded rebase* — S0 is never compared to S1 directly (they
     differ by construction after any rebase).
  4. **Expected-head merge guard:** the merge call itself pins the head —
     `gh pr merge --match-head-commit S1` — so a push landing in the
     green-on-S1→merge window cannot slot in (`mergeAgentPr` today passes no such
     guard, `delivery-exec.ts:152-156`).
  Any third-party push after the stamp breaks the chain at step 1, 3, or 4 →
  disarm, `sha_chain_disarmed` outcome + `delivery_failed` event (Retry
  affordance per Step 2, with the old→new delta surfaced), fresh human
  authorization required. **Threat model, stated honestly:** this stops
  third-party pushes to the PR branch around and after the stamp — the Round-1
  TOCTOU. It does *not* defend against a compromised worker: the worker holds
  merge authority, so it remains a trust boundary; what bounds a rogue worker is
  branch protection requiring green checks on the exact merged head, plus a
  least-privilege merge credential.
- **Guard the off-box config.** A startup/periodic health check asserts each linked
  repo has the required branch protection (required status checks on `main`); a
  missing/relaxed rule is a loud `delivery_failed`-class warning, not a silent
  downgrade. Confirm the worker's `gh` credential cannot bypass required checks or
  push `main` directly.
- **CI hardening is a Step-3 prerequisite, landing in the same PR** (not
  "evaluate" — CI becomes the sole check authority, and today's `ci.yml` has no
  `permissions:` block, so internal-PR jobs get a default read-write
  `GITHUB_TOKEN` while agent-authored postinstall scripts already execute there):
  an explicit least-privilege `permissions:` block (`contents: read` plus only
  what's needed), `persist-credentials: false` on `actions/checkout` for
  PR-triggered runs, no deploy/provider secrets in PR-triggered jobs, and
  `npm ci --ignore-scripts` for PR builds — with the known caveat that
  `better-sqlite3` (native, `package.json:27`) needs a prebuilt binary or a
  single-package script allowlist, verified before cutover rather than discovered
  as a red CI after it.

**Honest deletion estimate (revised):** roughly the *CI-execution* half of the
1,850 lines (clean-clone verify, noise handling, post-merge backstop, cursor
machinery via Step 2) — not two-thirds. The rebase/retry orchestration survives by
necessity of the GitHub plan; if the repo ever moves to Enterprise Cloud or public,
the orchestrator collapses into merge-queue enrollment.

### 4. Make claims session-scoped leases (server-minted, owner-defined)

Claim = (issue, actor, **leaseToken**, expiresAt). Rev 2 specifics the panel forced:

- **The lease token is server-minted** at `claim_issue` time, unguessable, returned
  exactly once to the claiming session, and required on heartbeat and on **every
  claim-scoped mutation across both adapters** — `update_issue`,
  `request_human_input`, release/reclaim transitions, MCP (`mcp/server.ts:197`)
  and the equivalent REST routes alike. Two sessions sharing the worker bearer
  token can no longer both hold the claim — a client-supplied or replayed
  sessionId would reopen the exact hole this closes. (Auth plumbing prerequisite:
  request context today carries only `actor` — `api-routes.ts:105`, `actors.ts:35`
  — so the lease token travels as an explicit parameter on claim-scoped calls, not
  ambient identity.)
- **The lease token is a bearer credential and is handled like one** (matching the
  actor-token discipline, `actors.ts:29,39`): stored only as a hash and compared by
  hash; returned once from `claim_issue` and never serialized into issue payloads,
  event payloads, claim state, logs, or argv. For containerized sessions the token
  is injected by the host worker/SDK layer (env or session handshake), **not**
  carried in the LLM transcript — a secret whose custody chain runs through a
  transcript is neither reliably retained (context compaction) nor reliably
  confidential (transcripts are logged).
- **Reclaim is explicit takeover — and takeover is opt-in, never the default.**
  A bare same-actor `claim_issue` while an active lease exists **fails loudly**
  ("this actor already holds an active lease — pass `takeover: true` to seize
  it"); only `claim_issue(ref, { takeover: true })` mints a fresh token,
  **atomically invalidates the old one**, and records a `lease_taken_over` event,
  after which the invalidated holder's next mutation is rejected immediately and
  (for containers) its supervisor's failed heartbeat triggers the cancellation
  path. Opt-in matters because this project's own documented workflow tells every
  interactive session to `claim_issue` before touching code, and interactive and
  dispatched sessions share the worker actor — if takeover were the default, the
  mandated habit would silently kill a healthy running container mid-task. This
  converts silent dual ownership into visible, *deliberate* single ownership —
  neither naive answer works (fresh-token-without-invalidation reopens the
  shared-token hole through the front door; requiring the old token permanently
  locks out a session that lost it, and interactive sessions *will* lose it).
- **The lease-required surface is enumerated, with explicit exemptions.**
  Lease-gated: `claim_issue`/release, `update_issue` (any field), status
  transitions, `request_human_input`, heartbeat — on both adapters. Explicitly
  exempt, with rationale: `comment`, `progress_note`, and `attach_file` are
  additive collaboration signals that cannot cause double-work or corrupt issue
  state, and answer-sessions (which run concurrently with a work session by
  design, in a separate dispatch pool) must be able to comment on issues whose
  work lease they don't hold. Agent-session reporting (`list_agent_sessions`
  lifecycle) is likewise exempt — it describes sessions, not issues. **One
  comment is not additive and is named as its own path:** a human comment on a
  `needsInput` issue clears the escalation and releases the claim
  (`comments.ts:30` — status→`todo`, assignee→null). Under leases this is the
  **human-answer release**, a third first-class lease-termination alongside
  expiry and takeover: it is lease-exempt (the answering human never held the
  agent session's lease and cannot present it), it atomically invalidates the
  outstanding lease token exactly like a takeover, and it records a
  `claim_released` event as today. Its regression tests live with the Step-4
  suite: a human answer invalidates the lease; the released session's next
  lease-gated mutation is rejected; a non-`needsInput` comment releases nothing.
  (Implementation note, per the verifying reviewer: preserve today's status
  condition — a `needsInput` human comment on an `in_progress` issue
  releases/invalidates; on a non-`in_progress` issue it clears the flag without
  releasing or invalidating anything, matching existing behavior and tests.)
- **Heartbeat owners are named per claimant type.** Containerized sessions: the
  host-side `agent-worker` process heartbeats on the container's behalf while the
  container runs — the lease attests "the supervising worker is alive and the
  container exists," which is the honest claim (an LLM session can't be trusted to
  call a tool on a timer, and a long tool call is exactly the healthy-but-quiet
  state we must not release). The worker SDK ties heartbeat failure to a
  cancellation signal: after N missed renewals it terminates its own workload
  rather than racing a re-dispatch. Interactive sessions: no background timer
  exists, so interactive claims get a long TTL (the current 4h-class behavior) —
  the lease mechanism *tightens* container release without worsening the
  dispatch-vs-interactive race.
- **Expiry requires N missed heartbeats**, and N × heartbeat-interval must exceed
  the worst-case tracker redeploy/restart duration — a redeploy is a *correlated*
  outage (every container heartbeats the same server), so an undersized N would
  mass-expire every live claim simultaneously; alternatively gate expiry on the
  server having been continuously up for the window. Release keeps the
  `stale-claims.ts:47-58` re-assert-inside-UPDATE pattern so a concurrent
  legitimate transition wins atomically.
- `claims.deviation_seconds` survives as the "claimed but idle" *nudge* clock (it
  powers an attention chip, not release) — Step 4 removes the release-side
  guesswork, and honestly says the nudge heuristic remains.

### 5. Housekeeping

- Delete the legacy merge-first delivery path once the Step 3 orchestrator is
  trusted.
- Add an event-kind registry (a TS const union) so producers/consumers can't invent
  strings — for the audit trail's integrity; no orchestration control flow reads it.
- Prune the ~30 dead local branches and stale worktrees.

### 6. Regression tests that must land with steps 1–4 (new in rev 2)

The plan deletes guards that each carry tests today; these named tests replace them:

- `upsertPrState`: webhook/poller writing the same (repo, prNumber) converge to one
  row; out-of-order `opened`-after-`merged` is a no-op; redelivered duplicates are
  no-ops; `reopened` is the only open-after-terminal transition; absence-from-poll
  changes nothing.
- SYD-202 replay: merge arriving under a *new* PR number yields `merged` state and
  no phantom open row.
- Never-saw-open heal: a PR first observed already merged/closed lands correct state.
- Cutover: the backfill populates rows for all in-flight and stale `agent/*` PRs
  (including one beyond the poller's 50-window) before consumers read the table;
  the backfill **refuses** an out-of-project `agent/SYD-1` PR (repo-binding applies
  to the backfill, not just live ingestion); backfilled rows carry GitHub's real
  `updatedAt`/`headRefOid`, and a post-backfill `synchronize` still updates
  `headSha` (freshness not frozen by cutover timestamps); the preflight fails loud
  on a worker-configured project whose repo is unlinked or unbound.
- Freshness: a `synchronize` webhook updates `headSha`; a poller tick carries a real
  `ghUpdatedAt` and an older poller observation is a no-op (exercising the poller's
  field, not just the webhook's); a stale/duplicate `reopened` older than an
  already-applied later `closed` is a no-op; same-second `<=` ties are documented
  as last-write-wins (fails closed to a disarm, never an unauthorized merge).
- Consumers agree: `search.ts` `?openPr=`/`?attention=` filters resolve from
  `pr_state` and match the claim gate's answer.
- Step 2: verify-failure writes one attempt and does not re-fire without a new
  authorization; **a failed attempt still lights `delivery_failed` so
  `redeliverIssue` is clickable**; done+merged-but-unobserved does not
  re-merge/redeploy; crash resumption consults GitHub live, not `pr_state`;
  `merged_deploy_failed` retries deploy-only; rollout migration (synthetic
  `skipped_rollout` rows) fires nothing.
- Step 2 authorizations: a stamp/Retry whose client-submitted SHA no longer equals
  the current head is rejected (compare-and-set); Retry after `sha_chain_disarmed`
  requires the delta acknowledgement; an authorization on an issue that has left
  `done` before the tick does not fire; the rollout migration and the trigger
  enumerate the identical authorization set **covering both authorization kinds**
  (a done-stamp — or a `redeliver_requested` — present only in the historical set
  still gets its `skipped_rollout` row).
- Step 3: post-stamp third-party push breaks the SHA chain and blocks merge (via
  the pre-rebase fetched-head assertion); worker-performed rebase persists S1 and
  preserves the chain; crash-after-rebase resumption re-anchors on the persisted
  S1 instead of disarming; the merge verifies the required-check conclusion for S1
  via a **live** GitHub read and passes `--match-head-commit S1`; wait-for-green
  times out to `checks_timeout`/`delivery_failed`; branch-protection health check
  alarms on a relaxed rule.
- Step 4: lease expiry needs N missed heartbeats; expiry-vs-transition race resolves
  atomically; a second session presenting the shared bearer token but no lease token
  cannot heartbeat or transition; a bare same-actor `claim_issue` against an active
  lease fails loudly, and only `takeover: true` invalidates the old token and
  records `lease_taken_over`; an evicted holder's next lease-gated mutation is
  rejected immediately; exempt surfaces (comment/progress_note/attach_file) still
  work without a lease; the lease token never appears in a serialized issue, event
  payload, or GET-able claim state.
- Cross-repo: an `agent/SYD-1` PR in a linked repo *not* bound to SYD's project
  does not open SYD-1's claim gate.

## Sequencing

Steps 1–2 land first as one bundle (the attempt ledger and `pr_state` are
co-dependent: the trigger reads both), in this order: (1) ingestion prerequisites
(repo/headSha fields, `synchronize`/`reopened` handling, poller fields), (2) the
**one-time backfill + cutover preflight**, (3) the rollout migration writing
`skipped_rollout` rows, and only then (4) consumers cut over. Steps 1–2 fix the
visible board bugs without touching merge mechanics. Step 3 follows independently
— it now *shrinks* rather than replaces the orchestrator — with the CI hardening
landing in the same PR as the authority switch. Step 4 can go any time after the
lease-token plumbing; step 5 is opportunistic; the Step 6 tests land with their
respective steps, not after.

**Deploy-skew rule (the tracker and the worker host ship separately):** the new
`repo`/`headSha`/`ghUpdatedAt` ingress fields are **optional first** — the server
infers `repo` from the issue's bound repo when absent, and only when the project
has exactly one bound repo (nothing enforces uniqueness on
`github_repos.projectId`; with several bound repos, inference is ambiguous and
the request is rejected instead of guessed) — then the worker host
upgrades (its own go-live: pull, rebuild images, `launchctl kickstart`), and only
then do the fields become required. Making them required in the same deploy would
400 every POST from the not-yet-upgraded worker host: the poller would stall
(self-healing but blind), and the worker's `.catch`-swallowed `pr_opened` publish
(`agent-worker.ts:448-455`) would silently drop — which under the new
architecture *is* the claim gate's publish-time close, reopening the SYD-93
double-work window for exactly the skew period.
