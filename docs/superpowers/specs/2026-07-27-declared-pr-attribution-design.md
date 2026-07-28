# Declared issue↔PR attribution

**Status:** DESIGN — awaiting review. Not approved, do not implement yet.
**Issue:** SYD-280 (story A of epic SYD-279)
**Author:** interactive session with Sean, 2026-07-27
**Analysis this rests on:** `docs/2026-07-26-ideal-agent-flows-analysis.md` §2

## Relationship to the failed attempt

A prior design, `2026-07-26-declared-pr-issue-links-design.md`, returned **REVISE
4/4** and was never committed; its reviewer transcripts are preserved in
`docs/reviews/`. It had the right principle and the wrong channel. The four
findings that killed it, and how this design differs:

| what killed it | why it does not apply here |
|---|---|
| Declaration channel was a **PR-body trailer on a public repo** — anyone could open a fork PR carrying one, creating an unauthenticated, unremediable claim block | The channel is an authenticated Switchyard call. A fork PR author holds no token, so cannot declare anything (§6) |
| **No unlink path**, so over-blocking was permanent | Revocation is specified first, before anything reads a link (§7) |
| Opening `getOpenPr` to proposals would have made a guess into a **delivery authorization** | Claim-gating and proof-bearing are different predicates over different link states (§5) |
| **`pr_state` is a state machine, not a link table** — a declared row would freeze at creation and never transition | `pr_state` keeps its `(repo, prNumber)` key and its existing write path untouched. Attribution moves *out* of it, so there is nothing to freeze (§4) |

## Problem

Switchyard infers which issue a PR belongs to by parsing strings, in three
places, with no authenticated way for anyone to simply state the link:

1. `attributedRef` (`src/services/pr-state.ts:105-135`) — a strict
   `agent/<REF>` branch match, repo-bound. The only path that writes
   claim-gating state, and structurally impossible for the `feat/` branches
   `CLAUDE.md` prescribes for interactive work.
2. `resolveRef` (`src/services/github-webhook.ts:194`) — the first
   `\b[A-Z]{2,10}-\d+\b` match in a PR title or body. Writes display-only
   events that no gate reads (`src/services/pr-status.ts:9-12`).
3. `recordDeliveryEvent` (`src/services/delivery-events.ts:88`) — the trusted
   worker discards the branch it actually pushed and reconstructs
   `` `agent/${issue.ref}` `` to re-derive an answer it already had.

Consequences are enumerated in the analysis §2.2 and in SYD-280. The three that
drive this design: interactive work is never queued for delivery
(`delivery-attempts.ts:105`), interactive work gets no claim protection
(`issues.ts:271-276`), and the `done_without_merged_pr` safety net can be
falsely *cleared* by an unrelated PR that merely mentions an issue
(`attention.ts:107-111` against `github-webhook.ts:272-279`).

## Scope

**In:** the attribution model, its storage, who may write it, revocation, the
join swap under `pr-status.ts` and `attention.ts`, and the migration.

**Out, deliberately:**

- **The `approved` state and completion** — SYD-282. This design does not add,
  remove, or change any issue status.
- **Ingress origin labelling.** `POST /api/github-events` (`api-routes.ts:611-620`)
  refuses agents only, so a `human`/`service` token can mint merge observations
  indistinguishable from GitHub's. That is real and it is SYD-282's, because it
  is a property of *observation*, not attribution. This design must not be read
  as making merge observations trustworthy — it only makes them *attributable*.
- **Delivery behaviour**, including the constraint that delivery must never
  close a PR it did not open (SYD-283).
- **Retiring the child issues.** SYD-261/265/273/274/275/277 become *fixable*
  here; each is closed on its own terms.

## 1. The model

Two facts, currently conflated in one column:

- **Attribution** — which issue a PR belongs to. A **declaration**: someone
  authenticated says so, and is recorded as having said it.
- **Observation** — what GitHub did to a PR. Stays exactly as it is: `pr_state`,
  written only by `upsertPrState`, with its ordering discipline untouched.

**Proof that an issue's code landed is a join of the two, never a parse.**

## 2. Schema

```sql
CREATE TABLE pr_links (
  id            INTEGER PRIMARY KEY,
  issue_id      INTEGER NOT NULL REFERENCES issues(id),
  repo          TEXT    NOT NULL,          -- normalized (normalizeRepoFullName)
  pr_number     INTEGER NOT NULL,
  role          TEXT    NOT NULL,          -- 'delivers' | 'references'
  declared_by   INTEGER NOT NULL REFERENCES actors(id),
  declared_at   INTEGER NOT NULL,
  confirmed_by  INTEGER REFERENCES actors(id),   -- NULL = unconfirmed
  confirmed_at  INTEGER,
  revoked_at    INTEGER                          -- NULL = live
);

CREATE UNIQUE INDEX pr_links_live_idx
  ON pr_links (issue_id, repo, pr_number) WHERE revoked_at IS NULL;
CREATE INDEX pr_links_pr_idx ON pr_links (repo, pr_number) WHERE revoked_at IS NULL;
CREATE INDEX pr_links_issue_idx ON pr_links (issue_id) WHERE revoked_at IS NULL;
```

A surrogate `id` with a **partial unique index on live rows** — not a natural
primary key — so a revoked link can be re-declared later without destroying the
history of the first declaration. Revocation is a soft delete on purpose: "who
un-linked this and when" is exactly the kind of question the audit exists for.

`pr_state.issue_ref` (`src/db/schema.ts:263`) and its index (`:273`) are dropped
at the end of the migration (§10). Nothing else about `pr_state` changes.

**Repo binding is retained.** A declaration is refused unless `repo` is bound to
the issue's project (`boundRepoFullNames`, `src/services/github-repos.ts:87`) —
the same rule `attributedRef` enforces today. Without it, any repo could claim
any issue.

**New event kinds** (`src/db/schema.ts:106-152`): `pr_link_declared`,
`pr_link_confirmed`, `pr_link_revoked`. Each carries `{repo, prNumber, role}`;
revoke additionally carries a required `reason`.

## 3. Roles

| role | means | gates claims | can prove landing |
|---|---|---|---|
| `delivers` | this PR carries this issue's work | **yes** | yes, if proof-bearing (§5) |
| `references` | this PR mentions the issue | no | **no** |

Many-to-many falls out. One issue with several `delivers` links is stacked
work; one PR with `delivers` links to several issues is SYD-274, currently
unrepresentable.

## 4. Who may declare

| declarer | how | role | confirmed at declaration? |
|---|---|---|---|
| trusted infra (`human`/`service` token) | `recordDeliveryEvent` at publish, and a direct API | `delivers` | **yes** — auto-confirmed |
| a human | UI / REST on the issue | `delivers` or `references` | **yes** — auto-confirmed |
| an agent holding the issue's claim lease | MCP / REST, presenting `lease_token` | `delivers` | **no** |
| free-text ref scan (§8) | webhook ingestion | `references` only | n/a — never gates or proves |

**Rule: a declaration by a non-agent actor is auto-confirmed** (`confirmed_by =
declared_by`) at the write. That collapses "who is trusted" into one predicate
(§5) instead of scattering actor-type tests across the reads.

**Agents must present the lease.** `validateLease` (`src/services/leases.ts:72-86`)
is the existing single-holder, expiring, non-forgeable credential. An agent that
does not hold the claim cannot declare — which is what makes this channel
immune to the DoS that killed the previous design: a fork PR author holds no
token, and a token-holding agent holds at most the issues it has claimed.

### 4a. Why the auto path cannot use the lease

Verified in-session against `main` (recorded on SYD-280):

1. The container session **exits** (`scripts/agent-worker.ts:706`).
2. `stopHeartbeat()` runs and `clearPersistedLeaseToken` **discards the host's
   lease token** (`:1542-1543`).
3. *Then* `finishSessionExit` publishes the PR (`:715-716`) — host-side,
   because "gh + git auth live here, never in the container" (`:708-710`).
4. The host posts `pr_opened` with the **infra token** (`:748`).

So on the auto path the declarer is structurally a different process from the
claim holder, by deliberate credential design. It declares as trusted infra
instead. This is not a timing problem a longer lease window would fix.

## 5. Trust: two predicates, not one

```
live(L)          :=  L.revoked_at IS NULL
claim-gating(L)  :=  live(L) AND L.role = 'delivers'
proof-bearing(L) :=  claim-gating(L)
                     AND L.confirmed_by IS NOT NULL
                     AND ( confirmer_is_human(L) OR recency_ok(L) )   -- §5a
```

- **Claim-gating** blocks a second claim. Over-blocking is safe and reversible:
  the worst case is a human revokes a wrong link.
- **Proof-bearing** is required before a link may be read as evidence that an
  issue's code landed.

A human's authorization act sets `confirmed_by`, so ordinary review requires **no
new click** — the person approving the PR is already looking at it.

### 5a. Recency binding

For a **proof-bearing** link, the merge must not predate the declaration:

> `gh_pr_merged.ghUpdatedAt >= pr_links.declared_at`, comparing GitHub's own
> clock. A null `ghUpdatedAt` **fails closed** (not proof-bearing), matching
> `parseGhTimestamp`'s existing fail-closed discipline
> (`src/services/github-webhook.ts:115-118`).

GitHub's timestamp rather than event id, because poller lag makes local event
ordering an accident — the same reasoning `attention.ts:99-106` records for its
own arm.

**Recency applies only when `confirmed_by` is not a human** — i.e. to links
confirmed by a `service`/infra actor with no person in the loop. Any human in
`confirmed_by` overrides it, whether they confirmed at declaration time or
later.

That exception is not a softening; it is required for correctness. The common
interactive flow is *hand-merge first, update the board after* — the prior
design measured `done → merge` intervals that were **negative** for exactly this
reason. Under a blanket recency rule every hand-merged interactive issue would
be permanently unable to prove it landed, which is the failure this epic exists
to fix, reintroduced from the other direction. A human asserting the
relationship is the authority; recency exists only to stop an unattended actor
replaying an old merge. The override is recorded on the `pr_link_confirmed`
event.

## 6. What an agent cannot do

- Declare against an issue it does not hold the lease for.
- Confirm anything.
- Revoke a confirmed link.
- Create a `references` link (agents declare `delivers` or nothing).
- Assert PR *status*. Merge state comes only from `pr_state`, whose writer is
  unchanged. This is what makes it safe to widen declaration to agents at all:
  a declaration says "this PR is mine", never "this PR merged".

The residual hole — an agent declaring against someone else's open PR, which
later merges — is closed by §5: an agent-declared link is unconfirmed, so it is
not proof-bearing, so it cannot prove landing no matter what the PR does.

## 7. Revocation

Specified before any reader, because its absence killed the previous design.

| actor | may revoke |
|---|---|
| the declarer | their own **unconfirmed** link |
| a human | any link, confirmed or not |
| an agent | nothing else |

A `reason` is required and rides the `pr_link_revoked` event. Revocation is
soft (`revoked_at`), so history survives and the same PR may be re-declared
later as a new row.

**Revoking is not deleting evidence:** `pr_state` and the `gh_*` event history
are untouched, so a revoked link removes an *interpretation*, never an
observation.

## 8. Free-text refs are demoted to suggestions

`resolveRef`'s text arm (`github-webhook.ts:194`, `REF_RE` at `:82`) stops
producing anything that gates. It writes `role='references'`, unconfirmed —
a "did you mean?" a human may promote to `delivers`.

Display events (`gh_pr_opened`/`gh_pr_merged` via `record()`,
`github-webhook.ts:261-300`) are unchanged; they remain the activity feed's
source. What changes is that **no gate reads them any more**.

This is what closes the false-clear hole: `attention.ts:107-111` currently
clears `done_without_merged_pr` on *any* `gh_pr_merged` event, so a PR that
merely mentions an issue silences its warning permanently. That arm becomes "a
merged, proof-bearing `delivers` link". It also retires SYD-277's class — the
same loose matching, in `board-nudge-lib.ts`.

## 9. What changes, and what conspicuously does not

Attribution is read in exactly **six** SQL sites, every one the identical clause
`ps.issue_ref = p.key || '-' || i.number`:

| file:line | function |
|---|---|
| `src/services/pr-status.ts:37` | `openRows` (→ `getOpenPr`, `listOpenPrByIssueId`) |
| `src/services/pr-status.ts:78` | `deliveryPinFor` |
| `src/services/pr-status.ts:95` | `prTransitionEventId` |
| `src/services/pr-status.ts:115` | `getMergedPr` |
| `src/services/attention.ts:65` | `unresolvedDeliveryFailures` |
| `src/services/attention.ts:88` | `unresolvedDoneWithoutMerge` |

Each becomes a join through `pr_links` on `(repo, pr_number)`, filtered to
live `delivers` links — plus the proof-bearing filter on the two arms that
constitute evidence (`getMergedPr`, and `attention.ts:88`'s clear arm).

**Every exported signature in `pr-status.ts` stays identical.** Therefore:

- **No consumer changes.** All twelve call sites keep working unmodified:
  `issues.ts:271` (`assertClaimable`), `issues.ts:436` (the done pin),
  `issues.ts:458`, `deviation.ts:70/:84/:132/:139/:183`, `dependencies.ts:248`,
  `search.ts:58`, `triage-actions.ts:112`, `api-routes.ts:237/:261/:262`.
- **No UI changes.** The UI consumes `openPr` and `deliveryPin` through the API
  shape (`ui/src/types.ts:55`, `:83`), which is unchanged.
- **No `pr_state` write-path changes.** `upsertPrState` keeps its ordering
  discipline; it simply stops setting `issue_ref`.

That containment is the main argument that this is a tractable change rather
than a rewrite, and it gives a sharp test predicate: **identical observable
behaviour for `agent/<ref>` work; new behaviour only for `feat/` work.**

## 10. Migration

Four steps, each independently revertible.

1. **Create `pr_links`** and the new event kinds. Nothing reads it yet.
2. **Backfill** one `delivers` row per `pr_state` row where `issue_ref IS NOT
   NULL`, `declared_by` = the synthetic `github` actor
   (`getOrCreateActor(db, "github", "agent")`, `github-webhook.ts:176`),
   `declared_at` = the row's `updated_at`, and `confirmed_by` **set explicitly**.

   Two things here are deliberate exceptions, called out because they contradict
   §4's rules if read as ordinary declarations:

   - The `github` actor is **type `agent`** (`github-webhook.ts:176` passes
     `"agent"`), so §4's "non-agent declarations are auto-confirmed" would leave
     every backfilled row unconfirmed — silently stripping proof from all
     existing agent work. The migration therefore sets `confirmed_by` itself
     rather than deriving it. These rows were trusted under the old model and
     must stay trusted, or the migration is a regression.
   - `confirmed_by` should name a **human** (the operator running the
     migration), not the `github` actor, so §5a's recency exception applies and
     historical merges that predate their `pr_state` row do not retroactively
     lose proof. Requiring an operator identity also means the backfill cannot
     run unattended, which is correct for a one-time trust assertion over
     existing data.
3. **Swap the six joins** and start writing declarations at the two declarer
   sites. `issue_ref` is now written-but-unread — dual-write, so a revert is a
   code revert with no data loss.
4. **Drop `issue_ref`** and its index, once (3) has run in production for a
   period Sean chooses.

`ensureRolloutBackfill`'s fence (`delivery-attempts.ts:402-423`) is untouched —
this design changes no status and adds no delivery authorization, so nothing
becomes newly deliverable by migration alone.

**Correction (2026-07-27, during implementation).** An earlier revision of this
section claimed the backfill would make interactive issues visible to
`getOpenPr`, so an open `feat/` PR would start refusing new claims the moment
step 3 landed, and that this needed counting before shipping. **That is wrong,
and it overstated the deploy risk.** A display-only PR never touches `pr_state`
at all (`github-webhook.ts:221`), so the backfill — which reads `pr_state` —
creates nothing for it; and free-text ingestion yields a `references` link,
which `LIVE_DELIVERS` excludes. Interactive work starts gating claims only when
someone **declares**, which is opt-in per PR.

The claim was checked by running it, not by re-reading the code, and is now
pinned by a test (`tests/services/pr-links.test.ts`, "does not make an
undeclared interactive feat/ PR gate claims") so it cannot silently drift.

**Second correction (2026-07-28, SYD-287): step 3 shipped only its declaring
half.** The join needs two sides, and only `pr_links` gained one. `pr_state` is
written solely by `upsertPrState`, which `handlePullRequest` reached only on the
strict `agent/<ref>` path — so a declared `feat/` PR had a declaration and never
an observation, and all four readers in §9 INNER JOIN the two. Production held
**zero** non-agent `pr_state` rows, all time; SYD-280 itself was `done`, merged
as PR #226, and could not prove it landed.

The design said this and the implementation did not read it that way: §11's
sweep lists `github-webhook.ts:222` (the `attributed` test) as needing a change,
and §1 says proof is "a join of the two, never a parse" — but leaving the
observation side parsed keeps the parse load-bearing by omission.

Why the SYD-280 suite passed anyway is the more useful lesson: every test that
covered the `feat/` case called `upsertPrState` directly to stand up the
observation half. Production never does that for a `feat/` branch, so the tests
validated the reader while the producer was missing entirely. **A test that
constructs its own precondition proves nothing about whether anything constructs
it.** `tests/services/pr-observation.test.ts` therefore drives
`handleGithubWebhook` throughout and constructs no `pr_state` row by hand.

**Where the observation predicate landed.** The first cut mirrored the
declaration — observe when the branch attributes the PR *or* a live `delivers`
link exists. Review (Sean, on SYD-287) pushed back: that still lets an
attribution question decide whether to record an observation, which is the same
conflation this design removes one layer up, and it leaves attribution
**order-dependent** — declare-then-observe works, observe-then-declare needs a
later re-observation to heal, and a PR that has aged out of the poller's window
never heals at all.

Ingestion now observes **every PR in a repo bound to a project**, full stop.
Observing is not attributing: an unattributed row is inert, because every reader
in §9 joins through a live `delivers` link, `upsertPrState` co-writes its
transition event per linked issue, and the backfill reads `issue_ref IS NOT
NULL`. Bound-to-a-project is the line — the same one `declarePrLink` enforces —
so a linked-but-unbound repo stays un-observed and the SYD-207 preflight's
warning keeps meaning something. Cost measured before the change, not assumed:
the poll window bounds write volume (not the row count), and the targeted
refresh's GitHub-API burn scales with *open* rows outside that window, which is
worth narrowing `GET /api/pr-state` for on a busy repo.

Two more things SYD-287 settled that this document left open:

- **Open question §13.4 / step 4 — `pr_state.issue_ref` keeps its
  branch-derived dual-write and is never written from a link.** Deriving it from
  a link would re-couple observation to attribution, which is the coupling this
  design removes; and step 3's revertibility guarantee depends on the column
  still being populated. Dropping it stays step 4's, unchanged and now
  independent of ingestion.
- **§8's "a 'did you mean?' a human may promote" needed an actual promotion.**
  Free-text ingestion mints the `references` link the moment the poller sees a
  PR whose title carries the ref — *before* an interactive session declares —
  and `declarePrLink` rejected the collision outright. The declared path was
  therefore unreachable in the only order production produces. A
  `references` → `delivers` declaration now supersedes the suggestion (soft
  revoke + fresh row, so both statements survive); every other role collision
  still refuses. Authority is unchanged: the same actor could already reach that
  state by revoking and re-declaring.

## 11. Consistency sweep

**Server:** `src/db/schema.ts:263` and `:273` (the column and its index),
`:106-152` (`EVENT_KINDS`) · `src/services/pr-state.ts:24-28` (the module
comment's attribution contract), `:105-135` (`attributedRef` — becomes the
auto-declaration trigger, not a gate), `:196` (the `issueRef` write) ·
`src/services/pr-status.ts:9-15` (the comment stating display rows never gate —
now stale) and the four SQL sites · `src/services/attention.ts:65`, `:88`, and
the SYD-267 comment block at `:93-106` · `src/services/delivery-events.ts:88`
(stop reconstructing the branch) · `src/services/github-webhook.ts:222`
(`attributed` test) · `src/rest/schemas.ts` (new bodies) ·
`src/mcp/server.ts` (new tool + its description).

**Not affected, verified by the sweep:** all twelve `pr-status.ts` call sites ·
the entire `ui/` tree · `delivery-attempts.ts`' selection SQL (it reads the
done-stamp pin from the event payload, not `pr_state`) · `upsertPrState`'s
ordering logic.

**Docs:** `CLAUDE.md` (the `agent/<REF>` branch convention stops being
load-bearing for attribution — it stays a convention, and should say so) ·
`codemaps/backend.md`, `codemaps/data.md`.

## 12. Testing

**Declaration** — an agent declares with a valid lease and succeeds · without a
lease, refused · for an issue it does not hold, refused · a `service` token
declares and the link is auto-confirmed · a declaration naming a repo not bound
to the issue's project is refused · a second live declaration of the same
`(issue, repo, pr)` is rejected by the partial unique index, while one made
after a revoke succeeds.

**Trust** — an agent-declared link gates a second claim · the same link does
**not** satisfy the proof predicate · a human confirmation makes it proof-bearing ·
an auto-confirmed link whose merge predates `declared_at` is not proof-bearing ·
a null `ghUpdatedAt` fails closed · an explicit human confirmation overrides
recency and records the override.

**Revocation** — the declarer revokes their own unconfirmed link · an agent
cannot revoke a confirmed one · a human can · a revoked link stops gating claims
immediately · `pr_state` and `gh_*` events survive the revoke.

**The behavioural claim of §9** — an `agent/<ref>` issue's `getOpenPr`,
`deliveryPinFor`, `getMergedPr` and attention flags are **byte-identical**
before and after the swap (this is the regression fence for the whole design) ·
an interactive `feat/` issue with a declared link now returns a non-null
`getOpenPr`, blocks a second claim, and clears `done_without_merged_pr` only via
a proof-bearing link.

**The false-clear hole** — a PR that merely mentions issue X, merged, creates a
`references` link and does **not** clear X's `done_without_merged_pr`. Use the
real shape from history: `62763cc`, "fix: rehabilitate SYD-245's tests against
the SYD-242 expiresAt param (SYD-265)", which first-mentions SYD-245.

**DoS regression** — a PR whose body says `Closes SYD-1`, opened by an actor
with no Switchyard token, creates no `delivers` link and does not block claims
on SYD-1.

**Migration** — backfill produces exactly one confirmed `delivers` link per
attributed `pr_state` row · historical merges stay proof-bearing under §5a ·
step 3 is revertible with `issue_ref` still populated.

## 13. Open questions for review

1. **Does `references` earn its place in v1?** It exists to hold free-text
   matches and to make SYD-274 representable. Nothing in this design *reads* it
   except a future "did you mean" surface. Cutting it to a boolean `delivers`
   table would be smaller; keeping it avoids a migration later. Weakly held.
2. **Should a human confirmation be required to name the head SHA it saw?** That
   would fold SYD-282's CAS into the confirmation act. Deliberately not done
   here — it couples this story to the `approved` work — but it may be the
   natural home.
3. **What happens to an existing `delivers` link when its issue is re-parented
   or marked duplicate?** Unspecified. Probably nothing, but it should be
   decided rather than discovered.
4. **Step 4's timing** — how long `issue_ref` stays written-but-unread before it
   is dropped.
