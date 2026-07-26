# Analysis of `2026-07-26-ideal-agent-flows.md`

**Status:** analysis, written 2026-07-26 in response to the intent document
**Scope:** verify the gap analysis, challenge the premises, answer the OPEN
questions, decompose the work. **No design is proposed here** — this document
exists to establish what is true before anything is specced.

## Method, and what "verified" means below

The intent document asked for reasoning inward from purpose. It also asked to be
challenged. Both require knowing what the code actually does, so every claim in
the gap analysis was checked against source in this session, and every `file:line`
below was read, not grepped for.

Three claims taken from the preserved reviewer transcripts
(`docs/reviews/2026-07-26-declared-pr-issue-links-*`) were re-verified
independently rather than inherited: the public-repo declaration channel, the
non-HMAC second ingress, and supervised sessions defeating `requireHuman`. All
three hold.

Where a claim in the prior design (`docs/superpowers/specs/2026-07-26-approved-
state-delivery-design.md`) is repeated here without an independent check, it is
marked **[unverified]**.

---

# 1. The gap analysis holds

| # | gap as stated | verdict | where |
|---|---|---|---|
| 1 | `done` is an absorbing state | **confirmed** | `delivery-attempts.ts:114` (`NOT EXISTS` an attempt row ⇒ once-only); `issues.ts:413-414` (agents cannot reopen) |
| 2 | authorization and completion are one record | **confirmed** | `issues.ts:435-453` — the `done` stamp both validates the CAS and writes the pin that authorizes delivery |
| 3 | delivery rarely completes | **[unverified]** — sample not reproduced | prior design's 47h window |
| 4 | interactive work is invisible | **confirmed** | `pr-state.ts:105-135`; `delivery-attempts.ts:105` |
| 5 | warnings have become noise | **partly fixed, newly broken** | see §2.4 |
| 6 | questions get lost | **confirmed** | `needs-input.ts` has no terminal-state interaction |
| 7 | duplicates happen | **[unverified]** | not checked |
| 8 | sessions absorb human identity | **confirmed** | `supervised-sessions.ts:72`, `principal.ts:1-10` |

Two corrections to the document's framing:

**Routing (§2) is already built.** `INTERACTIVE_PREFERENCE`
(`scripts/worker-select.ts:392`) and the dispatcher skip (`:461`) implement the
routing gate exactly as the flows describe. It belongs in the "already true"
column, not the aspirational one.

**Claim expiry (§5) is already built.** `expireLeases`
(`src/services/leases.ts:159-205`) releases a lapsed lease, re-asserts state
inside the `UPDATE` so a legitimate transition wins the race, and records
`claim_released{reason:"lease_expired"}`. The requirement "a stale claim is
released, and the release is visible" is satisfied today.

---

# 2. The root cause

**Five of the eight gaps are one defect.** Gaps 1, 3, 4, 5 and 8 are not
independent failures to be fixed independently. They are consequences of a single
structural choice:

> The system infers which issue a PR belongs to by parsing strings, instead of
> being told by someone entitled to say.

That is principle 3 of the intent document — *declared beats inferred* — stated
but not applied.

## 2.1 There are three inference sites, and no declaration site

**Site 1 — the branch name.** `attributedRef` (`pr-state.ts:105-135`) returns a
ref only when the branch is a strict `agent/<REF>` match *and* the repo is bound
to that ref's project. This is the only path that writes claim-gating state.
`CLAUDE.md` prescribes `feat/<topic>` for interactive work, so interactive work
is structurally incapable of producing an attributed row.

**Site 2 — free text.** Everything the branch match rejects falls to
`resolveRef([pr.head?.ref], [pr.title, pr.body])` (`github-webhook.ts:194`),
which takes the **first** `\b[A-Z]{2,10}-\d+\b` match (`REF_RE`, `:82`). These
write display-only events that, by explicit design, no gate reads
(`pr-status.ts:9-12`: *"Display-only rows … are audit history, never
claim-gating state"*).

**Site 3 — the trusted actor re-guesses.** `recordDeliveryEvent`
(`delivery-events.ts:88`) does not record the branch the worker pushed. It
reconstructs `` `agent/${issue.ref}` `` and feeds that back through
`attributedRef`. The one actor in the system that *knows* the answer with
certainty discards it and re-derives it from a convention.

There is no authenticated channel through which any actor may simply state the
link. That absence is the root cause.

## 2.2 What it costs, concretely

- **Interactive work cannot be delivered.** `listPendingDeliveryAuthorizations`
  requires `json_extract(e.payload, '$.pin.prNumber') IS NOT NULL`
  (`delivery-attempts.ts:105`). A pin only exists if `getOpenPr` found an
  attributed row (`issues.ts:436`). Interactive work never has one, so it is
  never queued — silently.
- **Interactive work gets no claim protection.** `assertClaimable`
  (`issues.ts:271-276`) refuses a second claim behind an open PR using the same
  `getOpenPr`. For `feat/` work it sees nothing, so the SYD-93 double-work gap is
  still open on exactly the path a human is most likely to use.
- **The board's own queue is full of the symptoms.** Nine open issues — SYD-261,
  SYD-262, SYD-263, SYD-265, SYD-267, SYD-273, SYD-274, SYD-275, SYD-277 — are
  each a local patch to one consequence of this one cause. SYD-277 is the same
  `REF_RE` family applied to commit subjects.

## 2.3 Why both prior designs failed

Both tried to make a guess trustworthy rather than replace it with a statement.

The declared-links design got the principle right and the *channel* wrong: it put
the declaration in a PR-body trailer on a public repo, where anyone may write one.
Its safety argument was that a wrong link only over-blocks. That is false when the
link cannot be removed — an unauthenticated, permanent denial of service on any
named issue. The channel, not the idea, was the defect.

The `approved` design's three rounds each fixed one consequence and exposed the
next, because it kept `pr_state` and free-text refs as the trust root. Its own
round-3 note records the lesson without naming the cause: *"`pr_state` is not the
system of record for 'this issue has code.'"* Correct — and there is no other
system of record, which is the actual finding.

## 2.4 A new finding: the safety net can be silenced by the same weakness

Not in either review. `unresolvedDoneWithoutMerge` (`attention.ts:107-111`)
clears the `done_without_merged_pr` flag when **any** `gh_pr_merged` event exists
on the issue, deliberately unordered. That arm was added by SYD-267 so an
interactive merge — visible only as a display event — could clear a flag it had
falsely raised. The raising side was not changed: `doneWithoutMergedPr`
(`deviation.ts:114-119`) still fires whenever `pr_state` shows neither an open nor
a merged PR, which for a `feat/` branch is always, and it is recorded at
transition time (`issues.ts:458`).

But display-path `gh_pr_merged` events are written from the **first free-text ref
match** (`github-webhook.ts:272-279`). So a PR that merely *mentions* an issue
first, in its title or body, writes a merge event on that issue and permanently
clears its warning. This repo's own history contains the shape: commit `62763cc`,
`"fix: rehabilitate SYD-245's tests against the SYD-242 expiresAt param
(SYD-265)"`, first-mentions SYD-245.

The consequence: **string inference now both raises the safety net and lowers
it.** Gap 5 in the intent document ("warnings have become noise") is half-fixed
and half-worse — the flag still fires spuriously at stamp time, and can now be
falsely cleared by an unrelated PR. This is the failure mode principle 5 warns
about, arrived at from the other direction.

## 2.5 The structural shape of a fix

Stated as a constraint on any future design, not as a design:

**Attribution and observation are different facts and must be stored
separately.**

- *Which issue a PR belongs to* is a **declaration** — an authenticated act by an
  actor entitled to make it, recorded as a first-class row with its declarer and
  its time.
- *What GitHub did to a PR* is an **observation** — `pr_state`, keyed
  `(repo, prNumber)`, carrying no ref at all.
- *Proof that an issue's code landed* is a **join** of the two, never a parse.

The entitlement question — who may declare — has an answer already in the
codebase. `claimLeases` (`leases.ts`) is a per-issue, single-holder,
expiring, non-forgeable credential, minted at claim time and validated on
claim-scoped mutations (`validateLease`, `:72-86`). "The actor holding the claim
may state which PR carries this issue's work" is precisely the authority a lease
already represents. A fork PR carries no lease, which is why this channel does not
reproduce the DoS.

Two consequences worth stating now, because they invert current assumptions:

1. **`agent/<ref>` stops being the trust root and becomes a convenience.** Trusted
   infra auto-declares at publish time; the branch name is then decoration.
2. **Free-text refs are demoted to *suggestions*.** They may populate a "did you
   mean" surface for a human to confirm. They may never gate, clear, or complete
   anything. That single rule retires SYD-277's class as well.

---

# 3. Where the intent document is wrong, or hides a decision

Six items. The first three are contradictions that will be resolved by whoever
implements them, silently and possibly wrongly, unless resolved deliberately.

## 3.1 "Done means shipped" contradicts the no-code exception

§10 requires that *"anyone glancing at the board should be able to trust `done`
without checking"*, then permits no-code work to reach `done` by a human saying
so. Those cannot both hold: the attested class is exactly the class a glance
cannot distinguish from the proven class.

The honest formulation is that `done` means **no further work is expected, and
the reason is on the record** — with *proven* and *attested* visibly different on
the board, not merely distinguishable in the event log. A design that ships one
flag for both will rot back into today's state, because the whole failure mode is
that `done` currently means two things.

## 3.2 "Authorization binds to specific commits" contradicts rebasing

§8 says authorization *"applies to a particular set of commits … If the work
changes after authorization, the authorization is void."* §9 requires delivery to
*"bring it up to date with `main` as it is now."* A rebase changes every SHA, so
delivery voids its own authorization on the literal reading.

This is not hypothetical: the prior design's "SHA-chain disarm" is this
contradiction left unresolved, and it produced 4 of 16 sampled delivery failures
(`"a commit landed … after its checks started — disarmed"`). `priorHeads`
(`delivery-attempts.ts:126-139`) is the workaround — the worker remembers heads it
force-pushed itself so it can recognise its own work.

**The decision being hidden:** does authorization bind to the *SHA* or to the
*reviewed content*? A rebase that produces the same diff preserves the human's
decision; a third-party push does not. Whoever specs this must say which, and the
`priorHeads` mechanism suggests the answer is already content-in-practice,
SHA-in-theory.

## 3.3 "Delivery may not author or alter issues" contradicts delivery writing `done`

The gates table forbids the delivery agent from authoring or modifying issues.
§9.6 requires delivery to record that work landed, and §10 makes `done` the
record of landing.

Resolvable — delivery records an *observation*, and the service layer computes
`done` as a consequence — but the resolution must be explicit, because
`issues.ts:378` denies `service` actors wholesale, deliberately and correctly
(SYD-213). A design that does not name this will discover it at implementation
time and patch around the denial, which is how that class of hole gets reopened.

## 3.4 Principle 1 has no test

*"If work stops here, who notices?"* is the correct question and the document's
best single idea. But nothing makes the answer checkable, so the next state added
will absorb work exactly as `done` does — for the same reason, and nobody will
notice until the next audit.

Make it enumerable: every state names a watcher, and a test asserts every state
has one. Otherwise principle 1 is a sentiment.

## 3.5 Gap 5 is a symptom, not a gap

"Warnings have become noise" is a consequence of gap 4 (§2.4 above). Listing it
separately invites building warning-triage machinery — a dismiss button, a
snooze, a digest — which principle 5 explicitly forbids. Fix attribution and the
noisiest flag stops firing *and* stops being falsely clearable.

## 3.6 The interactive/auto split carries less weight than the document gives it

"Where the two paths differ" is largely a *credentials and presence* difference.
Once attribution is declared, both paths produce the same artifact through the
same authenticated channel and are gated identically — which the document itself
demands ("It is bound by exactly the same server-side rules"). The genuine
differences reduce to: who holds credentials, whether asking is possible, and
whether the container is disposable. That is a smaller and more tractable list
than the section implies, and worth compressing so it does not license two
divergent implementations.

## 3.7 One premise is currently false and must be *made* true

The cast table lists "poller / webhook" as **trusted ingestion**. The real
webhook is HMAC-verified (`github-routes.ts:20-25`, `timingSafeEqual`). The second
ingress is not: `POST /api/github-events` (`api-routes.ts:611-620`) refuses
*agents only*. Any `human` or `service` token supplies the entire payload **and**
a `repo` override, and the recorded actor is always the synthetic `github` agent
(`github-webhook.ts:176`) — so nothing on the resulting event distinguishes a
GitHub-signed observation from a hand-posted one.

Any design that treats a merge record as proof must first label ingress by origin.
Today, "GitHub said so" and "someone with a token said GitHub said so" are the
same row.

---

# 4. The open questions

## Q1 — What proves that a specific issue's code landed?

**A declared link plus an observed merge.** Not a branch name, not PR text, not a
webhook record alone — each of those is a partial answer precisely because each is
an inference (§2). The join of a declaration (authenticated, attributed,
revocable by its declarer or a human) with an observation (HMAC-origin `pr_state`
transition to merged, carrying the merge SHA) is total, because both halves are
facts someone is accountable for rather than guesses.

This is the question the document calls hardest, and it is hardest only because
the declaration half does not exist yet. Once it does, the answer is a query.

## Q2 — Should interactive work be deliverable at all?

**Yes for the mechanical parts; hand-merge stays first-class.** Declared links
make interactive PRs *eligible*; that does not make delivery the default for them.

One hard constraint, from the reviewers and independently verified:
`scripts/deliver.ts:397` and `:439` call `closeDeadAgentPr`, which closes a PR
and posts a public "Delivery FAILED" comment. That is a destructive action
against a human-authored PR. **Delivery must never close a PR it did not open.**
Any design that makes interactive work deliverable without carving out that
behaviour is strictly worse than today's silent skip.

So: opt-in per PR, and a hand-merged PR is recorded as success — which the
document already demands.

## Q3 — How strongly should an unanswered question block?

**Block the terminal transition; require an explicit, cheap close.**

A hard block with no exit becomes a new absorbing state — the exact failure being
fixed. A loud flag gets ignored, per gap 5. The resolution is that a question is
*closed* by one of three attributed acts: answered, withdrawn by the asker, or
dismissed by a human as no longer relevant. `done` refuses while any question is
open.

The machinery is mostly present: `requestHumanInput` sets `needsInput` and
records `needs_input_set` (`needs-input.ts:46-66`), and a human comment clears it
(`comments.ts:44`). What is missing is the coupling to the terminal transition,
and a withdraw path for the asker.

Note the interaction with auto agents: `expireLeases`'s release `UPDATE` requires
`needsInput = false` (`leases.ts:189`), so a parked question keeps the issue
assigned and `in_progress` even after its lease lapses — the question holds the
work rather than dropping it back to `todo`. That is the correct behaviour and
should not be disturbed. (The lease row itself is still invalidated,
`leases.ts:178-181`, so the parked agent must re-claim to resume.)

## Q4 — Should spec approval be a board state?

**No — record it in the document, and make the *unapproved* case loud.**

A board state implies queue semantics, a watcher, and a transition guard, all for
a fact that is naturally per-document and sometimes per-section. Switchyard
already has the lighter mechanism: an issue may carry the spec's approval status,
and `docs/reviews/` now preserves the reviewer transcripts that make an approval
meaningful.

The requirement the document actually states — *"an unapproved one must be
visibly marked as such, so nobody implements from a document that failed
review"* — is satisfied by a convention on the spec's own `Status:` line, which
both prior designs already follow correctly and prominently. That convention
worked; it is why this analysis exists rather than an implementation of a
3-round-REVISE design.

## Q5 — What is the right cardinality between issues and PRs?

**Many-to-many, with a role on the link.** This falls out of declared links for
free and is unrepresentable without them.

- One issue, several PRs: stacked work, or a fix plus its revert.
- One PR, several issues: SYD-274 is exactly this and is currently unfixable.

Each link carries a role — *delivers* (this PR carries the issue's work) versus
*references* (this PR merely mentions it). Only *delivers* links prove landing or
gate claims. Free-text matches, if kept at all, may only ever propose a
*references* link.

## Q6 — How should an agent hand work back?

**A hand-back is a claim release plus a finding, and it returns the issue to a
human queue — never to a terminal state.**

The distinction that keeps this from becoming abandonment: an agent may state a
*conclusion* (this is a duplicate of X / the premise is wrong / this is already
done) but may not *act* on it. The conclusion is a finding with evidence attached;
a human accepts it, which is what moves the issue to `canceled` or merges it into
another. This is the triage gate applied at the other end of the flow, and it is
the same rule as "no agent may move its own work out of triage."

Mechanically this is close to `requestHumanInput` with a structured reason, and
the release path already exists (`invalidateLease`, `leases.ts:123-130`).

---

# 5. Decomposition

Four sub-projects. The dependency order is not stylistic — each edge is a case
where building the later thing first means building it twice.

```
  A. Declared attribution ──────┬──> C. Authorization ≠ completion
                                │         (`approved`, proof-of-landing)
  B. Human-act integrity ───────┘                    │
                                                     v
                                          D. Failure & retry model
```

## A. Declared attribution *(foundation)*

The issue↔PR link becomes a first-class declaration made through an authenticated,
lease-gated channel; `pr_state` becomes pure observation; free-text refs are
demoted to suggestions that gate nothing.

**Retires or subsumes:** SYD-261, SYD-262, SYD-263, SYD-267, SYD-273, SYD-274,
SYD-277 — and makes SYD-265 and SYD-275 (the 27 unlanded issues) *detectable*
rather than merely countable.

**Why first:** C's central question (Q1) has no answer without it, which is why
the `approved` design failed three rounds. Every "what proves it landed" rule
collapses to a join once this exists.

## B. Human-act integrity *(independent, and a prerequisite for new gates)*

`requireHuman` currently does not mean human: `supervised-sessions.ts:72` resolves
an agent inside a supervised session to the bound human, and `principal.ts:1-10`
documents this as intended. Every human-only gate in the gates table is presently
satisfiable by an agent.

**Why before C:** C adds new human-only gates (the authorize stamp, badge-clear,
attested completion). Adding gates to a foundation that fails open builds
security theatre, and the reviewers found precisely this — the "agents propose,
humans confirm" argument was void.

Note `EXECUTABLE_GATE_ACTIONS` is `["done", "dependency.remove"]`
(`settings.ts:94`) and the executor hard-codes `status: "done"`
(`hard-gate.ts:193`), so the affirmation mechanism is currently
single-purpose. Generalising it is part of this project, not C's.

## C. Authorization ≠ completion

The `approved` design, re-derived on top of A and B. Most of its 15 known-open
findings are artifacts of the missing foundation and should be re-examined rather
than carried forward — in particular the first-mention auto-completion hole, the
pin-vs-tautology rule, and the "`pr_state` freezes for declared rows" objection all
dissolve under A.

Its genuinely independent parts survive: the ingress-origin labelling (§3.7), the
`restampable` move, the three `'done'` selection literals, and the UI status
duplication.

## D. Failure and retry model

Infrastructure failures retried and never presented as verdicts on the work;
genuine failures escalated; every state with a named watcher (§3.4).

**Board issues already open here:** SYD-272, SYD-276 — both already framed as
"distinguish operator/environment failure from a verdict", which is D's thesis.
D depends on C only because retry semantics are defined against the
authorization record C introduces.

---

# 6. What this analysis deliberately does not decide

- **Whether authorization binds to SHA or to content** (§3.2). It names the
  contradiction; the choice belongs to the spec, and to Sean.
- **The shape of the declaration API** — tool surface, revocation, whether a
  human may declare on an agent's behalf. That is project A's design work.
- **Branch strategy** (production/staging/main), out of scope in the prior design
  and still out of scope here.
- **Whether `done` splits into two visible outcomes or one flagged one** (§3.1).
  Named as a decision; not made.
