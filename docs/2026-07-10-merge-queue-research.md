# Merge-queue research: making delivery bulletproof

Deep-research synthesis (2026-07-10, 20 sources, 25 claims adversarially verified,
0 refuted). Question: how do production systems merge a queue of concurrent PRs
into one main branch without conflict/verification cascades, and what applies to
Switchyard's delivery pipeline?

Context that prompted it: on the night of 2026-07-10, batch-stamping ~12 issues
whose agent branches were cut from week-old main produced (a) a semantic conflict
that passed per-PR CI but broke merged main (`SWITCHYARD_COOKIE_SECURE` vs the
env-example test), and (b) three consecutive LLM conflict-resolution sessions
(SYD-145, SYD-140, SYD-144, then SYD-151) — of which the last three all went
stale before their retry-merge because main kept moving. Three agent sessions,
zero merges.

## The one mechanism every production system shares

bors-ng, Zuul gating, GitLab Merge Trains, Uber SubmitQueue, and Chromium's
Commit Queue all reduce to the same core loop:

> **Never trust a PR's own CI run against its stale base. Deterministically
> re-apply the change onto the current tip, verify the exact post-merge state,
> and only then advance main.**

- bors-ng: merge the batch onto a staging branch, run CI, fast-forward main only
  on green — "the main branch contains the exact contents that were just tested,
  bit-for-bit."
- Zuul: "test each change applied to the tip of the branch exactly as it is
  going to be merged."
- SubmitQueue (EuroSys 2019, production at Uber, thousands of commits/day):
  always-green main by executing every build step at every commit point *before*
  landing.

This single mechanism eliminates both of our failure modes at once: stale-base
invalidation **and** semantic conflicts that pass per-PR CI. Verification stops
being a post-merge alarm (today's SYD-78 gate, which fires after main is already
red) and becomes a pre-merge gate — a bad PR gets rejected, main never breaks.

## Sequential is sufficient at our scale — skip the fancy machinery

Everything elaborate in these systems (speculative batching, merge trains,
speculation trees, ML-ranked serializations) exists solely to make the core
guarantee scale to hundreds-to-thousands of commits/day. SubmitQueue's motivating
arithmetic: 1000 changes/day × 30-min builds ⇒ 20+ days last-in-queue latency.
Inverted for our queue — 5–15 PRs × 2–5 min verify — a plain **sequential
rebase → verify → fast-forward loop drains the whole queue in ~15–75 minutes**
worst case. Speculation would import exponential-tree complexity (which bites
hardest exactly when queued PRs overlap, as stale agent branches do) to solve a
latency problem we don't have. (Caveat: this inversion is our extrapolation, not
a source claim; verified 2-1.)

The closest architectural template is the **Chromium Commit Queue**: their
commit-flag ≈ our human done-stamp; at enqueue the CQ freshly re-applies the
patch against current HEAD and runs new try jobs (never trusting the original CI
run); on failure it cheaply dequeues the CL back to its author. No automated
repair, ever.

## Failure policy: eject and bounce, never in-queue repair

Every surveyed system handles a failing queue entry the same way: **eject it,
requeue what's behind it, return the failure to its author.** Zuul re-tests
trailing changes without the failed one; GitLab ejects the MR and recomputes the
train; SubmitQueue "isolates the offending change and retries the rest";
Chromium clears the commit flag. **None dispatches expensive automated repair
work inside the queue** — which is exactly what our conflict-resolution sessions
are, and tonight showed why: by the time an in-queue repair finishes, the queue
itself has invalidated it.

For agent-authored PRs the empirical literature supports a **tiered escalation**:

1. **Tier 1 — deterministic:** `git rebase` onto current main + re-verify.
   Ghiotto et al. (IEEE TSE 2020; 175,805 conflict chunks, 2,731 projects) found
   87% of conflict-chunk resolutions are composed entirely of lines already
   present in the conflicting versions — an LLM is rarely generating new code.
   (Per-chunk figure; whole-merge resolvability is lower.)
2. **Tier 2 — bounce to author:** on textual conflict, dequeue and re-dispatch
   the *issue* against fresh main (regeneration), rather than repairing the
   stale branch. For agent PRs the "author" is a worker session, so the bounce
   is itself automatable — this is our analogue of Chromium returning the CL.
3. **Tier 3 — LLM conflict-resolution session:** last resort only, for changes
   too expensive to regenerate; run it *while the queue is paused for that ref*
   so the resolution can't go stale (tonight's losing race).

The 2026 LLM-vs-search merge-resolution study explicitly recommends hybrid
routing over always-LLM resolution — neither paradigm dominates.

## Cheap optimization worth stealing: file-set disjointness

SubmitQueue's conflict analyzer classifies pending changes as independent
(disjoint file/target sets) vs conflicting; independent changes land in any
order without cross-verification. For us, comparing a queued PR's changed-file
set against what landed since its base is a near-free pre-filter — but it should
gate **skipping the rebase**, not skipping verification (file-level disjointness
misses semantic coupling; the env-example incident was exactly a disjoint-file
semantic conflict).

## What this means for deliver.ts

Redesign the per-ref delivery flow from **merge → verify → deploy** to
**rebase → verify → merge → deploy**:

1. On done-stamp: clean clone, fetch `agent/<ref>`, rebase onto `origin/main`.
2. Rebase conflicts ⇒ **bounce** (comment + `delivery_failed` + optionally
   auto-requeue the issue for re-dispatch against fresh main). No resolver
   session by default.
3. Rebase clean ⇒ run typecheck + vitest **on the rebased tree**.
4. Verify fails ⇒ bounce with the tail (this is the semantic-conflict rejection;
   main stays green).
5. Verify passes ⇒ force-push-with-lease the rebased branch, poll mergeability,
   merge the now-up-to-date PR, deploy. Process the next stamped ref only after
   this one lands (already sequential today — keep it).
6. Optional fast-path: if the PR's changed files are disjoint from everything
   landed since its base commit, skip the rebase (not the verify).

Dependent/stacked work falls out for free: "B depends on unmerged A" is just "B
enters the queue behind A" — B gets rebased onto main-including-A when its turn
comes. No stacked-PR machinery needed at this scale.

What this replaces/keeps:
- Keeps: sequential loop, done-stamp trigger, clean-clone discipline, deploy
  step, reconciliation pass, delivery events/comments.
- Replaces: `attemptAutoRebase`-as-fallback becomes the *primary* path;
  post-merge verification (SYD-78) demotes to a cheap redundant check (or is
  removed); conflict-resolution dispatch (SYD-100) demotes to opt-in tier 3.
- Largely supersedes SYD-163's churn circuit-breaker: with pre-merge
  verification and bounce-on-conflict there is no resolver cascade to break.

## Open questions from the research

- Regenerate vs repair: at what change size/staleness is re-dispatching the
  issue cheaper than a tier-3 resolver session? (No source compared these.)
- Flaky-test policy: one automatic retry before ejection (GitLab/LUCI style) or
  immediate bounce? Each ejection costs a worker re-dispatch, not a human's
  minute.
- GitHub's native Merge Queue and hosted queues (Aviator/Mergify/Graphite) were
  not adequately verifiable in this pass; our human-stamp trigger and
  self-hosted deploy likely rule them out anyway, but nobody confirmed it.

## Source quality notes

bors-ng is deprecated (2023; README now points to GitHub Merge Queue) — its
design principles, not the tool, are what we're adopting. The Chromium CQ doc is
the Rietveld-era design (modern LUCI CV can reuse recent tryjob results). Uber's
open-sourced submitqueue repo is new (Jan 2026); the EuroSys 2019 paper is the
production evidence. All queue designs degrade under flaky tests; none of the
sources quantified that for small queues.
