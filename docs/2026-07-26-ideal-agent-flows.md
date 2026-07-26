# Ideal agent flows — how work should move through Switchyard

**Status:** statement of intent, written 2026-07-26 for review by a fresh agent
**Audience:** an agent with no prior context, asked to work out how to make this real

## How to use this document

This describes **what we want**, not what exists. It is deliberately written at
the level of intent and invariants, because the two designs that preceded it both
failed review by reasoning outward from existing mechanism instead of inward from
purpose.

If you are the agent picking this up: your job is to work out how to make these
flows possible. Treat every statement here as a requirement to be satisfied or a
premise to be challenged — if a flow below is incoherent, say so rather than
building it. The final section lists what today's system does that violates
these flows; that is your gap analysis, not your design constraint.

Where something is genuinely undecided, it is marked **OPEN**. Those are the
places we want your thinking most.

## What Switchyard is

A self-hosted, agent-native project tracker. Humans plan on a shared board;
Claude Code agents file, triage, claim, and work issues through MCP, gated by
human review, with provenance on everything. The API and MCP server are the
product; the web UI is a thin client over the same service layer.

The system tracks its own development (project key `SYD`), so the flows below are
lived daily rather than hypothetical.

## The cast

| actor | what it is | what it is for |
|---|---|---|
| **human** | a person, authenticated by session cookie or token | decides what gets built, what is acceptable, and what ships |
| **interactive agent** | a Claude Code session with a human present | work that needs judgment, credentials, a browser, or a conversation |
| **auto agent** | a headless container, dispatched, no human present | well-specified work that can be finished unattended |
| **delivery agent** | trusted host automation | landing authorized work on `main`, and recording what happened |
| **poller / webhook** | trusted ingestion | observing the outside world (GitHub) and reporting it |

**The organising principle: no client has private powers.** Every capability
lives in the service layer, and MCP, REST, and the UI are thin adapters over it.
A rule that exists only in a prompt is not a rule.

## Principles

1. **A state must never be able to swallow unfinished work.** If work can enter a
   state and stop being anyone's problem, that state is a bug.
2. **Authorization and completion are different facts.** "I approve this" and
   "this shipped" must never be the same record.
3. **Declared beats inferred.** Where the system needs to know a relationship, it
   should be told, not guess from a string.
4. **Gates are enforced server-side or they do not exist.** Prompts are guidance;
   the service layer is the rule.
5. **Signals must be worth reading.** A warning that fires on ordinary success
   trains people to ignore it, which is worse than no warning.
6. **Evidence over assertion.** A claim that something was verified must be
   backed by output from having actually run it.
7. **An unanswered question blocks.** Work must not proceed past a question that
   was asked and never answered.

---

# Flow: a feature from idea to shipped

This spine is shared. Where interactive and automatic work diverge is called out
inline and summarised afterwards.

## 1. Something becomes an issue

Work enters the board from: a human idea, an agent noticing something during
other work, a periodic review pass, a code-review finding, or an incident.

**Intent:** filing should be cheap and near-automatic, so that noticing a problem
and recording it are the same act. An agent that spots a bug it is not fixing
should file it rather than mention it in chat, where it evaporates.

**A good issue is decision-grade** — a human accepts or dismisses it from the
issue alone, without asking follow-up questions. It states what is wrong or
needed, why it matters and the cost of ignoring it, the suggested next action,
where it came from, and a rough size. It carries at least one topic label.

**Every agent-filed issue lands in `triage` with provenance.** Agents never place
work directly into the ready queue; that is the human's decision.

**Sizing is part of filing.** If the ask spans multiple subsystems, needs a
design decision, or exceeds roughly one working session, it is not one issue —
it is an epic with child stories, each independently completable and
independently valuable. Ordering between stories is expressed as dependencies.

## 2. Triage — the first human gate

A human reviews the triage inbox and decides: accept (it becomes ready work),
reject, defer, or send back for more detail. They set priority, confirm or
correct the labels, and decide routing (below).

**Intent:** this is the gate that makes agent-initiated work safe. Agents may
propose anything; nothing becomes work until a human says so.

**Routing is decided here.** Every issue is marked as work an auto agent may take,
or work that requires an interactive session. The litmus: *could a headless agent,
in a disposable container, with no human present and no real external credentials,
finish this and open a PR?* If it needs live credentials, a real external CLI, a
browser, an interactive spike, or a mid-task human decision, it is interactive
work and the dispatcher must skip it. Mis-routing wastes a dispatch and strands an
agent waiting for a human who is not there.

## 3. Speccing — for anything that needs a design

Not all work needs a spec. Work that does: anything touching multiple subsystems,
anything with a real design decision, anything where the obvious implementation
might be the wrong one.

**Intent:** the spec is the artifact that gets argued with, because arguing with
a document is enormously cheaper than arguing with a merged branch.

The shape: brainstorm the intent with a human → write a design doc → **review the
design before any implementation plan is written** → then write the plan → then
implement. Reviewing the spec is a distinct step from reviewing the code, and
skipping it is how a design's fatal flaw survives all the way to a PR.

**Spec approval is a gate.** An approved spec is what makes downstream work
routine. An unapproved one must be visibly marked as such, so nobody implements
from a document that failed review.

**OPEN:** whether spec approval should be a first-class board state, or remain a
human judgment recorded in the document.

## 4. Directing an agent at an issue

**Automatic:** the dispatcher selects from ready work — respecting routing,
priority, dependencies, work-in-progress limits, and whatever human opt-in signal
governs unattended dispatch. It skips anything already claimed, anything blocked,
and anything with work already in flight.

**Interactive:** a human points a session at an issue, or the session picks one up
in conversation.

**Intent — the two paths must not collide.** The single most expensive failure
mode is two agents doing the same work in parallel. Whatever the path, an agent
takes exclusive responsibility for an issue before touching code, and the system
refuses a second taker. This must hold *across* paths: a dispatched worker and an
interactive session must be able to see each other's claims, even when they
authenticate as the same actor.

## 5. Claiming

**Claim before you touch code. Always, both paths.**

A claim means: this issue is mine, I am working it now, and anyone else asking
should be refused. The system enforces the refusal — it is not a convention.

A claim must also expire. An agent that dies mid-task must not hold an issue
hostage; a stale claim is released, and the release is visible.

**Intent:** claiming is what makes the board a coordination mechanism rather than
a list. It is also what makes "who is working on what" answerable at any moment.

## 6. How an agent works the issue

1. **Read the issue and verify its premises.** Issues cite files, functions, and
   line numbers. Confirm they exist before building on them. A citation that does
   not resolve is itself a finding — report it rather than reasoning on top of it.
2. **Say what you are doing, as you do it.** Progress notes make a running session
   legible to a human who wanders past. A session that goes dark for an hour is
   indistinguishable from one that died.
3. **Write the test first** where the work admits it. The test is the artifact
   that proves the behavior; the implementation is what makes it pass.
4. **Verify by running, not by reasoning.** "This should work" is not evidence.
   The gate is: lint, typecheck, build, and the full test suite, run in-session,
   with the output visible. Claiming a verification you did not run is the single
   most damaging thing an agent can do, because every downstream decision assumes
   it was true.
5. **Push work to a branch and open a PR.** The PR is where a human reviews.
6. **Report what you did, how you verified it, and what you did not do.** Scope
   you skipped, checks you could not run, assumptions you made — those belong in
   the report. A report that only contains successes is not a report.

**On finishing:** an agent reports completion when the work is done and verified,
and says so plainly. If part of the scope was blocked, it finishes everything else
and states exactly what it left and why. Silently narrowing scope is not the
agent's call.

## 7. What an agent should ask about — and what it should not

**Ask when:**
- Two readings of the request would produce materially different work.
- The action is destructive, irreversible, or outward-facing.
- It needs a credential, an approval, or access a human controls.
- The work has revealed that the issue's premise is wrong.

**Do not ask when:**
- A conventional default exists — take it and say which one you took.
- The answer is discoverable in the code — go and look.
- You are tempted to reduce scope. Deliver the whole thing and flag the concern.

**How to ask:** ask one specific question, state the assumption you will proceed
under if unanswered, and — where possible — keep doing every part of the work
that does not depend on the answer.

**An unanswered question must block completion.** If an agent asks a human
something and the human never answers, the issue must not be able to reach a
terminal state as though the question were resolved. The question is part of the
work.

**OPEN:** how strongly to enforce this. A hard block is safest and most annoying;
a loud flag is friendlier and easier to ignore.

## 8. Review — the human gate before anything lands

A human reviews the PR and the agent's evidence, and decides.

**Intent:** this is the point where a human takes responsibility for the change.
Everything after it should be mechanical.

What the human is deciding: is this the right change, is the evidence real, and
do I authorize it to land. That authorization is a *specific* act — it applies to
a particular set of commits, not to the issue in general. If the work changes
after authorization, the authorization is void and must be re-given.

## 9. Delivery — what it means

**Delivery is the mechanical process of getting authorized work onto `main`, and
recording truthfully what happened.** It is not a decision about quality; that
decision was made at review.

What delivery does:

1. Take work a human has authorized.
2. Bring it up to date with `main` as it is *now* — `main` moves, and authorized
   work goes stale.
3. Verify the result — the thing that lands must be the thing that was checked.
4. Land it.
5. Deploy, where deployment is part of shipping.
6. Record that it landed, with proof.

**Intent — delivery must be relentless about the things that are not the work's
fault, and strict about the things that are.**

- A conflict with something that landed first is not a defect in the work. Try to
  resolve it mechanically; escalate to a human only when it genuinely needs
  judgment.
- An infrastructure failure — a timeout, a network blip, a broken tool on the
  host — is not a verdict on the work at all. Retry it, and never present it to a
  human as though the branch were at fault.
- A genuine failure — the tests are red, the change is wrong — stops and asks for
  a human. That is a real verdict and should be rare.

**Delivery must never mark work as shipped that did not ship.** This is the one
thing delivery absolutely must get right, because everything downstream trusts it.

**Delivery must be able to try again.** A failed delivery is not a terminal state.
Whatever the reason, the work must remain visible, owned, and re-attemptable —
by the system where possible, by a human where not.

**Intent — hand-merging is legitimate.** Humans merge PRs themselves, and always
will. Delivery must treat a hand-merged PR as a successful outcome to be recorded,
not an anomaly to be flagged.

## 10. Done means shipped

`done` should mean one thing: **this landed**. Not "I approve", not "I'm finished
looking at it" — it shipped, and there is proof.

Work that has no code — an operations task, a decision, a verification — reaches
`done` by a human saying so, and that act should be recorded as the deliberate,
attributed thing it is.

**Intent:** anyone glancing at the board should be able to trust `done` without
checking. The moment `done` sometimes means "probably landed", the board stops
being a source of truth and becomes a thing you have to verify.

---

# Where the two paths differ

## Automatic agent work

- The human is **not present**. Every decision the agent cannot make alone must
  either be pre-decided in the issue, or stop the work.
- It runs **disposable and isolated**: a container that clones the repo inside
  itself, works, and pushes a branch out. It never mutates the host.
- It holds **no credentials it does not need** — in particular no ability to merge
  or to publish outside a narrow path. Landing work is not its decision.
- Its network access is constrained to what the work requires.
- Its output is a branch and a PR. Everything else — landing, deploying, stamping
  — happens outside it.
- **It must be able to finish.** If a dispatched agent routinely stalls asking for
  a human, the issue was mis-routed at triage; that is a triage bug, not an agent
  failure.

## Interactive agent work

- A human is present, so the agent may ask, and the human may steer.
- It has access to real credentials, real tools, and a browser, because the human
  does.
- **It is bound by exactly the same server-side rules.** The presence of a human
  in the loop does not grant the agent privileges; if it did, "run it
  interactively" would become the way to bypass every gate.
- Where a session acts on a human's behalf with the human's identity, actions that
  genuinely require a human decision must require a *fresh* human act — presence
  is not consent for everything that follows.
- Its work is just as much board work: it claims, it reports, it opens PRs, and it
  is reviewed. An interactive session is not an exemption from process.

---

# The gates, in one view

| gate | who passes it | what it authorizes | what must be true |
|---|---|---|---|
| **Triage** | human only | an idea becomes work | agent-filed issues start here, always, with provenance |
| **Routing** | human at triage | which kind of agent may take it | headless-impossible work is marked so and skipped by the dispatcher |
| **Spec approval** | human | implementation may begin | the design was reviewed, not just written |
| **Claim** | any agent, one at a time | exclusive right to work it | enforced server-side, visible across paths, expires when stale |
| **Review / authorization** | human only | this specific work may land | binds to specific commits; void if the work changes |
| **Delivery** | delivery agent | landing and recording | acts on authorized state, not on who is assigned; cannot author or alter issues |
| **Done** | proof, or a human for no-code work | the board asserts it shipped | backed by evidence, not by an assertion |

**What no agent may do, ever:** move its own work out of triage, authorize its own
work to land, declare its own work shipped, or remove a dependency that blocks it.
These are human decisions, and each has been attempted by accident.

**What the delivery agent may not do:** author or modify issues, decide quality,
or record an outcome it cannot prove.

---

# Failure handling

**Every failure must leave the work somewhere a human or the system will find it
again.** The test for any state in the system: *if work stops here, who notices?*
If the answer is "nobody", the design is wrong.

**Distinguish the machine's problems from the work's problems.** A failure of the
poller's environment, a network timeout, a broken host tool — these say nothing
about the branch, and presenting them identically to a real failure sends a human
to inspect code that is fine. The two need different signals and different
recovery: one is retried, the other is escalated.

**Signals must stay rare.** A flag that fires often becomes invisible. Anything
that raises human attention should be near-zero-noise by construction — and if it
is firing constantly, the correct response is to fix what it is detecting or to
fix the detector, never to add a dismiss button.

---

# Evidence and provenance

- **Everything records who did it and why.** Provenance is not bookkeeping; it is
  what makes agent-initiated work reviewable.
- **Citations are checked before they are used.** Both when writing an issue and
  when acting on one.
- **Verification claims require output.** Reporting "tests pass" without having
  run them corrupts every decision downstream.
- **Duplicates are a real cost.** Before filing, look for the issue that already
  says this; before starting, look for the work already done. Two agents building
  the same thing has happened repeatedly and is expensive every time.

---

# Open questions for the fresh agent

1. **What proves that a specific issue's code landed?** This is the hardest
   unsolved problem in the system. Branch naming, PR text, and webhook records
   each answer it only partially. A trustworthy answer unblocks several other
   flows.
2. **Should interactive work be deliverable at all**, or is hand-merging the
   permanent interactive path? Both are defensible; the flows above do not assume
   either.
3. **How strongly should an unanswered question block?**
4. **Should spec approval be a board state?**
5. **What is the right cardinality between issues and PRs?** One PR per issue is
   the common case, but stacked and multi-issue PRs both occur.
6. **How should an agent hand work back** when it concludes the issue is wrong,
   already done, or a duplicate — without that becoming a way to abandon work?

---

# Known gaps: where today's system violates these flows

Provided as a gap analysis. Each was observed directly, not inferred.

- **`done` is an absorbing state.** Work that fails after being stamped leaves
  every queue, has no owner, cannot be retried, and cannot be picked up by an
  agent. An audit found 12 issues stamped `done` whose code never reached `main`;
  5 carried no warning at all.
- **Authorization and completion are the same record.** The human's stamp is both
  "I approve" and "it's finished", and everything that fails in between falls
  into the gap.
- **Delivery rarely completes.** In one 47-hour sample: 16 delivery failures
  against 2 successes, with ~35 of 37 merges performed by hand. Only 1 of the 16
  failures was a genuine verdict on the work; the rest were staleness, a
  read-after-write bug, dead-end bookkeeping, and infrastructure.
- **Interactive work is invisible to the machinery.** The authoritative
  issue↔PR link requires an `agent/<ref>` branch, while interactive work uses
  `feat/`. So interactive work gets no claim protection, is not deliverable, and
  is reported as never having landed even when its PR is open and merged.
- **Warnings have become noise.** 27 process warnings raised against 2 resolved in
  the same window; the most common one fires on ordinary interactive success.
- **Questions get lost.** An agent asked whether to split an issue, was never
  answered, and the issue was stamped `done` with the question still open.
- **Duplicates happen.** At least two pairs of issues were independently specified
  and worked in parallel.
- **Interactive sessions can absorb human identity**, so an agent acting inside
  one passes checks intended to require a human.
- **A process nudge fabricates issue references** from ordinary prose, then blocks
  repeatedly on the resulting nonexistent issue.
