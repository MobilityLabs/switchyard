# Human-act integrity: separating attribution from authorization (SYD-281)

Story B of the SYD-279 epic. **Revision 4** — after three rounds of a seven-seat review
panel (2026-08-27). Findings and disposition: `docs/reviews/2026-08-27-syd281-panel.md`.

## The problem

`resolveSupervisedPrincipal` (`supervised-sessions.ts:53-76`) resolves a supervised session
to a `Principal` whose `actor` is the **bound human**. Correct for attribution. Wrong for
authorization, and wrong for identity.

Three questions have been answered by one field:

1. **Who authorizes this?** — a human *acting*, not a human *accountable*.
2. **Whose credential is this?** — the agent's, in a supervised session.
3. **Whose name goes on the row?** — the assignee, lease holder, declarer.

`type === "human"` answers (1) wrongly, `type === "agent"` answers (2) wrongly, `actor.id`
answers (3) wrongly. A supervised principal is typed human and is not typed agent, so it
passes gates of both shapes.

**The fail-open default.** Fourteen carriers declare `attr: Attribution = {}`, so "no
session" and "caller forgot the session" are the same value:

```
mcp/server.ts:75            services/issues.ts:172, :311, :730
services/comments.ts:16     services/queue.ts:76
services/dependencies.ts:30, :76   services/pr-links.ts:231, :414, :572
services/needs-input.ts:21  services/agent-sessions.ts:207
services/attachments.ts:102
```

`queue.ts:76` and `attachments.ts:102` are **carriers, not authorization sites** — neither
is human-gated (`api-routes.ts:457-459` says so for the queue) and neither calls an
accessor. They keep their defaults. Named here so the sweep is closed.

### The precedent this generalizes

`mcp/server.ts:417` already solves the identity problem by hand at one site:

```ts
recordProgressNote(db, viaAgent ?? actor, ref, note, attribution);
```

Revision 2 wrongly called `progress_note` a fail-closed bug. It works, because of this
line. The finding is that one site got it right and nothing generalized it.

### Blast radius

**Reachable from `/mcp` with a `sup_` token** (the MCP surface is 22 tools; delivery,
`confirm_pr_link`, and agent-session start/end are *not* among them):

| Site | Gate | What a supervised agent gets |
|---|---|---|
| `issues.ts:184,190,211` | `=== "agent"` | **Violates "agent-created issues land in `triage` with provenance"** (CLAUDE.md) |
| `issues.ts:402` | `=== "agent"` | **Violates "only humans move issues out of triage"** (CLAUDE.md) |
| `issues.ts:579` | `=== "agent"` | Applies `auto` — **opts its own issue into unattended dispatch** |
| `issues.ts:389` | `=== "agent"` | `isHolderMutation` false ⇒ SYD-210 lease validation skipped |
| `issues.ts:412-427` | `=== "agent"` | Transition allow-list bypassed; can reopen `done` |
| `issues.ts:530` | `=== "agent"` | The `in_progress` claim gates (SYD-99/111/124) |
| `issues.ts:610` | `=== "agent"` | Agents self-assign only; supervised reassigns anyone |
| `issues.ts:664` | `=== "human"` | **Clears `needsInput` on a no-op status patch** — violates human-clear-only (SYD-220/225) |
| `comments.ts:44` | `=== "human"` | Same, via `addComment` |
| `needs-input.ts:43` | `=== "agent"` | Holder lease check skipped |
| `pr-links.ts:241,243,248,254,289,291,305` | `=== "agent"` | See the predicate table |
| `pr-links.ts:585,593,598` | mixed | See the predicate table |
| `dependencies.ts:134` | `!== "human"` | **Violates "dependency removal is human-only"** (CLAUDE.md) |

**REST-only, where `ctx` is always empty** (`sup_` resolves only at `/mcp`, `server.ts:77`;
REST bearer auth is `authenticate()`, `api-routes.ts:153`):

| Site | Gate | Note |
|---|---|---|
| `pr-links.ts:417` → `api-routes.ts:449` | `=== "agent"` | A **`service`** actor confirms and writes `confirmedBy`. **SYD-298's actual site** |
| `delivery-events.ts:54`, `delivery-attempts.ts:209` | `=== "agent"` | Service actors **must pass** — see population B |
| `api-routes.ts:672` `/github-events` | `=== "agent"` | Same shape, same answer: service must pass |

Revision 3 listed the delivery sites as MCP-reachable. They are not.

`update_issue` → `done` holds only because the divert (`issues.ts:314-316`) fires before
`:407`. **That coupling is load-bearing and undocumented.** Verified: the divert reads no
assignee, and the executor re-drives as the human with empty attribution
(`hard-gate.ts:188-198`), so `actingAgent` returns null there and the divert is unchanged
by this work.

## The identity rule

**In a supervised session the acting agent holds the work** — assignee, lease holder,
declarer. The human remains the accountable root on events, **except `progress_note`**,
which is agent-scoped by design (see below).

```ts
// src/services/principal.ts
declare const humanBrand: unique symbol;
export type HumanActor = Actor & { readonly [humanBrand]: true };

/** (1) Who authorizes. Null in a supervised session. */
export function asHuman(actor: Actor, ctx: Attribution): HumanActor | null {
  if (ctx.sessionId != null || ctx.viaAgentId != null) return null;
  return actor.type === "human" ? (actor as HumanActor) : null;
}

/**
 * (2) Whose credential. Returns null rather than throwing on a missing or
 * retyped row — getActorById throws (actors.ts:75), which would turn "no agent
 * acting" into a 500. Re-checks type, mirroring resolveSupervisedPrincipal:69.
 */
export function actingAgent(db: DbOrTx, actor: Actor, ctx: Attribution): Actor | null {
  if (ctx.viaAgentId != null) {
    const row = db.select().from(actors).where(eq(actors.id, ctx.viaAgentId)).get();
    return row && row.type === "agent" ? toActor(row) : null;
  }
  return actor.type === "agent" ? actor : null;
}

/**
 * (3) Whose name goes on the row. FAILS CLOSED: when ctx says supervised but no
 * agent resolves, falling back to `actor` would silently restore the human-as-
 * holder state this work exists to remove — and since asHuman also returns null
 * there, the write would be neither authorized as human nor represented as agent.
 */
export function effectiveActor(db: DbOrTx, actor: Actor, ctx: Attribution): Actor {
  const agent = actingAgent(db, actor, ctx);
  if (agent) return agent;
  if (ctx.sessionId != null || ctx.viaAgentId != null) {
    throw new SwitchyardError(
      "This supervised session's agent actor no longer resolves — re-open the session.",
    );
  }
  return actor;
}
```

`ctx.viaAgentId` is **server-minted and closure-baked** (`server.ts:99-100`; `mcp/server.ts:68-78`
states why it is never a tool argument). `actingAgent` turns it into an identity selector,
which raises the cost of ever making it caller-supplied — record that as an invariant in
the PR.

### `ctx` threading and the `NO_SESSION` sentinel

`ctx` is required, no default. That forces ~20 REST/CLI/worker sites to pass an empty
attribution, so a lint rule banning a bare `{}` with a two-line allowlist would be
abandoned on contact.

```ts
// src/services/attribution.ts
export const NO_SESSION: Attribution = {};
```

The rule bans the bare literal and permits the sentinel. `hard-gate.ts:197` uses it with
its existing comment (note `:196` is the **lease channel** `{}`, not `ctx`). Be honest in
the PR: **the sentinel is a legibility control, not a security one.** A caller that wrongly
reaches for `NO_SESSION` in a supervised path fails open exactly as `{}` does. What it buys
is that the wrong choice is a named, greppable token instead of two invisible braces.

## Predicate tables

### `pr-links.ts`

| line | today | becomes |
|---|---|---|
| `:243` assignee check | `isAgent` | `actingAgent(...) !== null`, compared to `effectiveActor().id` |
| `:248` `validateLease` | keyed `actor.id` | keyed `effectiveActor().id` |
| `:254` role forcing | `isAgent` | `actingAgent(...) !== null` |
| `:289` `declaredBy` | `actor.id` | `effectiveActor(...).id` |
| `:291-292` `confirmedBy/At` | `isAgent` | `asHuman(...) !== null` |
| `:305` `confirmed:` payload | `isAgent` | `asHuman(...) !== null` |
| `:585` outer branch | `!== "human"` | `asHuman(...) === null` |
| `:593` `declaredBy` compare | `actor.id` | `effectiveActor(...).id` |
| `:598` inner lease | `=== "agent"` | `actingAgent(...) !== null`, keyed `effectiveActor().id` |

`:289` and `:593` must move together, or a supervised agent can withdraw declarations its
supervisor made in person.

### `issues.ts` — complete, including the claim path

Revision 3's table converted the leaves and omitted the lines they depend on. **As written
it made supervised `claim_issue` throw on its first call.**

| line | today | becomes |
|---|---|---|
| `:184,190` provenance + description | `=== "agent"` | `actingAgent(...) !== null` |
| `:211` initial status | `=== "agent" ? "triage" : "backlog"` | `actingAgent(...) !== null ? …` |
| `:214` `creatorId` | `actor.id` | `effectiveActor(...).id` |
| `:281` `assertAssignee` holder | `assigneeId === actor.id` | `=== effectiveActor(...).id` |
| `:389` `isHolderMutation` | `=== "agent" && assigneeId === actor.id` | `actingAgent(...) !== null && assigneeId === effectiveActor().id` |
| **`:391` `validateLease`** | keyed `actor.id` | keyed `effectiveActor(...).id` |
| `:402` triage exit | `=== "agent"` | `asHuman(...) === null` |
| `:407` done | `=== "agent"` | `asHuman(...) === null` (defence behind the divert) |
| `:412-427` transitions | `=== "agent"` | `actingAgent(...) !== null` |
| **`:506` auto-claim assign** | `actor.id` | `effectiveActor(...).id` |
| **`:507` `assigned` payload** | `actor.name` | `effectiveActor(...).name` |
| `:530` claim gates | `=== "agent"` | `actingAgent(...) !== null` |
| `:579` `auto` label | `=== "agent"` | `asHuman(...) === null` |
| `:610` self-assign only | `=== "agent"` | `actingAgent(...) !== null`, vs `effectiveActor().id` |
| `:664` `needsInput` clear | `=== "human"` | `asHuman(...) !== null` |
| **`:675` mint condition** | `changes.assigneeId === actor.id` | `=== effectiveActor(...).id` |
| **`:682` `mintLease`** | `actor.id` | `effectiveActor(...).id` |
| **`:721` `heartbeatClaim`** | `heartbeatLease(…, actor.id, …)` | `effectiveActor(...).id` |
| **`:746` re-claim branch** | `assigneeId === actor.id` | `=== effectiveActor(...).id` |
| `:769` takeover `mintLease` | `actor.id` | `effectiveActor(...).id` |
| `:783` `claimIssue` assignee | `actor.name` | `effectiveActor(...).name` |
| `assertClaimable:260` | `actor` | `effectiveActor(...)` |
| `needs-input.ts:43` predicate | `=== "agent"` | `actingAgent(...) !== null` |
| **`needs-input.ts:44` lease key** | `actor.id` | `effectiveActor(...).id` |

**Event `actorId` stays the human.** `:693` (`assigned`) and `:762` (`lease_taken_over`)
keep `actor.id`, paired with `viaAgentId` — the row becomes the agent, the audit line keeps
dual attribution. `effectiveActor` is for **row-identity columns only**
(`assigneeId`, `creatorId`, `declaredBy`, lease `actorId`); it must never replace
`events.actorId` or `affirmedById`. Applying it to `recordEvent` would collapse dual
attribution and silently rewrite the event log.

**`heartbeatClaim` was missing from revision 3 entirely**, and the rule breaks it: the lease
is agent-minted while `mcp/server.ts:382` passes the human, so `validateLease`
(`leases.ts:79`) throws on every heartbeat and every supervised claim expires at TTL with no
renewal path.

**`issues.ts:664` is the primary `needsInput` conversion, not `comments.ts:44`.** Revision 3
had the dependency backwards: `comments.ts:44` *delegates* to `updateIssue` (`comments.ts:57`)
and the clear happens at `:664`. `:664` is reachable directly from `update_issue`, and fires
on `patch.status !== undefined` — not on a *change* — so a supervised agent clears its own
escalation with a **no-op status patch**, never touching `comment`. Revision 3's test would
have passed while the invariant stayed broken.

## Populations

### A — human-only, take `HumanActor`

```
settings.ts          setSetting:206, resetSetting:227
actors.ts            setActorAttended:107, rotateActorToken:120, revokeActorToken:132
projects.ts          createProject:17, updateProject:34
webhooks.ts          addWebhook:18, removeWebhook:39, setWebhookActive:48
github-repos.ts      addGithubRepo:31, removeGithubRepo:57
triage-actions.ts    snoozeIssue:54, markDuplicate:88, redeliverIssue:137,
                     resolveDeviation:250, resolveDeliveryFailure:282
affirmation-keys.ts  enrollAffirmationKey:44 (human check :51 only), revokeAffirmationKey:124
hard-gate.ts         affirmPendingAction:91                 ← root of trust
pr-links.ts          confirmPrLink:409, backfillPrLinksFromPrState:505
supervised-sessions.ts openSupervisedSession:24             ← root of trust
rest/pending-actions.ts :69, :138
```

**Signature decision (revision 3 specified this two incompatible ways).** These functions
take `HumanActor` and **nothing else changes about their signatures** — no `ctx` parameter.
The adapter holds the `Principal`, so the adapter calls `asHuman(actor, ctx)`, throws when
null, and passes the branded value. The private `requireHuman` helpers
(`settings.ts:113`, `actors.ts:12`, `projects.ts:11`, `webhooks.ts:10`,
`github-repos.ts:23`, `triage-actions.ts:45`) become genuinely redundant and are **deleted**;
the ESLint ban on `as HumanActor` is the backstop that keeps the type honest.

This is "adapters mint, services demand" taken literally. It keeps ~20 service signatures
and their call sites unchanged apart from the parameter type, which is what makes the sweep
mechanical.

**Two exceptions where the adapter throw is the entire gate.** `requireHumanCaller`'s only
call sites are `api-routes.ts:204` (`createActor`) and `:235` (`createLoginLink`), and
neither service takes an actor parameter at all. There is no branded value to pass. These
are the two credential-minting routes — the highest-value REST gates in the system — and
their protection is a runtime throw at the adapter, not a type. Say so; do not imply a
type-level guarantee that cannot exist there.

**`rest/pending-actions.ts:126` is deliberately excluded.** Its actor comes from
`getSessionActor` (`auth.ts:60-69`, `kind='plain'` filter at `:65`), which returns no session
id. Threading one would make `asHuman` return null and break the cookie affirm route — the
strongest human-presence signal in the system, already correct for this exact reason
(`:119-126`). `:172` reuses `:138`'s value.

### B — mixed, take required `ctx` and the predicate tables

```
pr-links.ts       declarePrLink:225, revokePrLink:566
dependencies.ts   removeDependency:71
issues.ts         createIssue:168, updateIssue:305, claimIssue:725,
                  assertClaimable:260, assertAssignee:280, heartbeatClaim:715
comments.ts       :44   (defence in depth; :664 is the primary conversion)
needs-input.ts    :43, :44
agent-sessions.ts requireAgent:47 — three callers: :126, :142, :209
delivery-events.ts :54          → `actingAgent(...) !== null`
delivery-attempts.ts requireDeliveryInfra:208 — four callers: :228, :290, :334, :371
rest/api-routes.ts :672 /github-events → `actingAgent(...) !== null`
```

**The delivery predicate is `actingAgent(...) !== null`, NOT `asHuman(...) === null`.**
Service actors **must** pass these gates — `SWITCHYARD_DELIVER_POLLER_TOKEN` and
`SWITCHYARD_GITHUB_POLLER_TOKEN` are service actors, and
`tests/services/service-actor.test.ts:46,57,61` already assert it. Reading revision 3's
"refused" as `asHuman` would have **stopped production delivery**. `actingAgent(...) !== null`
is behaviourally identical to today and additionally refuses a supervised agent. Keeping
those three tests green is an acceptance condition.

`recordDeliveryEvent` (`delivery-events.ts:41-46`) has **no `Attribution` parameter** and
neither do its callers; `requireDeliveryInfra` has four. Both are the same unbudgeted
expansion flagged for `startAgentSession`/`endAgentSession`. Since neither is MCP-reachable,
**the cheapest correct answer is to leave both as they are with a note** — they are
REST-only and `ctx` is always empty there. Decide in the PR; do not leave it to the
implementer.

**`requireAgent`'s other two callers.** `:126`/`:142` (`startAgentSession`/`endAgentSession`)
have no `Attribution` parameter, and the owner tie at `:150` (`existing.actorId !== actor.id`)
keys on `actor.id` — the same "owner tie matches rather than saves you" shape flagged as
load-bearing for `affirmPendingAction`. Budget it, and re-key the tie to `effectiveActor`.

**`recordProgressNote` keeps its current provenance.** Today `mcp/server.ts:417` passes the
agent *as the actor*, so `events.actorId` is the agent and `lastNoteFor` finds notes by
`events.actorId === agentSessions.actorId`. The collapse to `effectiveActor` must preserve
that exactly — passing the human with `viaAgentId` would change the event and break
`lastNoteFor`. This is the one event where the agent is the `actorId` by design; the
"accountable root" invariant is stated with this exception.

### C — do not convert

```
worker-preference.ts:30,51   interactive routing
pr-links.ts:140              display: was the confirmer a person
pr-links.ts:470              humanConfirmed on pr_link_confirmed — drives the §5a recency
                             exception (:467-469). Safe once confirmPrLink is population A,
                             because only a real human reaches it. NOT "display"
affirmation-keys.ts:54       target must be human — data rule
auth.ts:15                   login links belong to humans — data rule (caller gate is
                             api-routes.ts:235)
actors.ts:38                 default `attended` at creation
actors.ts:110                target must not be human — data rule
comments.ts:31               AGENT_QUESTION_RE signalling — not authorization
nextTask (dependencies.ts:257)  MUST stay human-keyed — see below
```

**`nextTask` is the one place where *not* applying the rule is the security-relevant
choice.** `dependencies.ts:257` filters `eq(issues.assigneeId, actor.id)`, so after the rule
a supervised `next_task` stops surfacing the agent's own claimed work — a real cost. But the
actor passed to `nextTask` must stay the **human**, because `isAttendedCaller`
(`worker-preference.ts:50-52`) reads it to decide whether to apply the hard
`worker_preference <> 'interactive'` filter (`dependencies.ts:281-284`). Key it to the agent
and supervised sessions lose the interactive queue they exist to serve. Accept the narrower
result and write the reason down.

## New attack surface the identity rule creates

`openSupervisedSession` takes a **free-form agent name from argv** (`cli.ts:91`, `:104`) and
`getOrCreateActor` returns the *existing* actor for a known name (`actors.ts:61-68`). So
`mint-supervised-session sean claude/dev` binds a session to a live dispatch worker's actor
(`worker-preference.ts:22-24`).

Harmless today — a supervised claim assigns the human, so a container's `assertClaimable`
refuses with "already claimed by Sean". **After the identity rule the assignee is that same
agent actor**, so `assertClaimable:260` early-returns and `claimIssue:746` downgrades the
refusal to "pass `takeover: true`". A dispatched container could seize a live interactive
session's claim on a path that previously refused outright. Lease tokens still separate the
two sessions' writes, so this is defence-in-depth loss rather than an authorization bypass —
but `assertClaimable` is the guard SYD-93 exists because of.

**Fix: namespace supervised agents.** `openSupervisedSession` derives
`supervised/<human>/<engine>` rather than accepting a bare name. Cheaper than a registry, and
it keeps `callerClassification`'s prefix split (`worker-preference.ts:31`) meaningful.

## Migration

Existing supervised claims hold the **human** as assignee and lease holder.

**Expiring the lease is wrong** — revision 3 recommended it and it produces a stuck board.
Expiry leaves `assigneeId` = human, so the new `isHolderMutation` is permanently false and
`validateLease` at `:391` is **skipped entirely** — SYD-210's shared-token hole silently
reopened — while `assertClaimable:261-269` throws "already claimed by \<human\>" forever,
since clearing an assignee is human-only (`:610`).

**Use the `ensureClaimLeaseCutover` precedent** (`lease-cutover.ts:17-38`, already wired at
`server.ts:162-163` beside `ensureRolloutBackfill`): marker-guarded, once-only, sets
status→`todo`, `assigneeId`→`null`, records `claim_released`. Releasing the assignment resets
the control instead of removing it, and needs no event archaeology.

Ordering matters: the existing cutover already released all `in_progress` claims once, so a
new migration must be independently marker-guarded and idempotent, and must state whether it
finds anything at all on an instance that has already run the cutover. **`claim_leases` is
part of the migration surface** — revision 3 never mentioned the table.

History is not rewritten: existing `creatorId`, `declaredBy`, and `confirmedBy` rows written
under the old rule stay as they are. That asymmetry with claims is deliberate — claims are
live state, the others are history — and should be said rather than left for a reviewer to
ask about.

## The brand is not the enforcement

`HumanActor` is erased at runtime. The predicate moves to the adapters, which call `asHuman`
and throw; the brand is compile-time defence in depth. The ESLint rule bans `as HumanActor`
outside `principal.ts` and the CLI mint, and bans a bare `{}` as `ctx` in favour of
`NO_SESSION`.

## Adapters

- **MCP.** `server.ts:94-101` destructures the principal into positional args. Change
  `buildMcpServer` to take a `Principal` and mint once per connection (~20 threading sites).
  `mcp/server.ts:417`'s hand-rolled `viaAgent ?? actor` collapses into `effectiveActor`,
  preserving its current event provenance.
- **REST.** `requireHumanCaller` throws; see the two-exception note above. `ctx` is always
  empty here — pass `NO_SESSION`.
- **CLI.** One helper does the runtime check and returns `HumanActor`; `cliActor`
  (`cli.ts:22`), `requireHumanActor` (`cli.ts:27`), and `linear-import.ts:352`'s second
  synthetic human all route through it. No casts.

## The REST residual

A supervised session runs on the human's workstation, which holds `.env` with
`SWITCHYARD_HUMAN_TOKEN`; `scripts/syd.ts` defaults to it. The agent's path to every REST
gate is the human's bearer, at which point `asHuman` returns a `HumanActor`. **Nothing at
REST distinguishes a bearer presented by a person from the same bearer presented by a
process.** Mitigation is credential hygiene plus the cookie/signature routes, not `asHuman`.

## Operator step

```
supervised.hard_gate_actions: ["done"] → ["done", "dependency.remove"]
```

**Fails closed.** Once `dependencies.ts:134` asks `asHuman(...) === null`, a supervised
removal on an un-updated NAS skips the divert (`:78`, `:89` need `isHardGated`) and is
refused. The setting upgrades refusal to a proposable divert — UX, not security.

## Behaviour changes

| Action | Today | After |
|---|---|---|
| `claim_issue` (supervised) | assigns + leases the **human** | assigns + leases the **agent** |
| `file_issue` | `backlog`, no provenance | `triage`, provenance required |
| `update_issue` out of `triage` / adding `auto` | permitted | refused |
| `update_issue` no-op status clearing `needsInput` | permitted | refused |
| `comment` clearing `needsInput` | permitted | refused |
| `update_issue` reassign / transition / claim gates | skipped | agent rules apply, keyed to the agent |
| `declare_pr_link` | auto-confirmed as the human | claim + lease required, `delivers` forced, `declaredBy` = agent, unconfirmed |
| `revoke_pr_link` | full human powers | own link (agent-keyed) + unconfirmed + lease |
| `confirm_pr_link` (service, REST) | confirms; readers accept | refused |
| `remove_dependency` | executes | refused, or diverts once the setting lands |
| delivery events (supervised) | can unblock its own issue | refused; **service unchanged** |
| `next_task` (supervised) | surfaces the human's claims | surfaces unassigned only — accepted, see C |
| `progress_note` | works, agent-scoped | unchanged |
| `update_issue` → `done` | diverts | unchanged |
| `whoami` | the human | the human **and** the acting agent |

**Second-order, verified:** killing the supervised auto-confirm writes `confirmedBy: null`,
which fails `attention.ts:113-119`'s `IS NOT NULL` before the disjunction is reached, so
`done_without_merged_pr` fires. That is the flag working as designed, but it is new steady
state. Convention: confirm the link in the SYD-290 UI before affirming `done`.

**Also:** four sites synthesize an event `actorId` from `issue.assigneeId ?? issue.creatorId`
— `deviation.ts:259`, `stale-claims.ts:59`, `leases.ts:174`, `lease-cutover.ts:23`. After the
rule those carry an agent id where they carried a human's, with no paired `viaAgentId`.
Arguably more accurate; state it in the PR rather than letting a reviewer find it in an audit
log.

## Testing

TDD, driven through real entry points.

1. `asHuman` null iff `sessionId != null` or `viaAgentId != null` or not human.
   `actingAgent` null on a missing row and on a row no longer typed `agent`.
   **`effectiveActor` throws** when ctx says supervised and no agent resolves.
2. Every population-A gate refuses a supervised principal.
3. Every reachable inverse gate refuses, through the MCP tool: triage exit, `auto` label,
   reassign, transition allow-list, `file_issue` landing in `triage` with provenance.
4. **`update_issue` with a status equal to the current status does not clear `needsInput`** —
   the no-op path, not `comment`. Revision 3's test would have passed while the hole stayed.
5. `declare_pr_link` over a real `sup_` token: refused without a claim, refused without the
   **agent's** lease, `role` forced, `declaredBy` = agent, `provesLanded` false, and the
   `pr_link_declared` payload's `confirmed` false.
6. `revoke_pr_link`: the agent can revoke its own declaration, and **cannot** revoke one the
   human declared in person.
7. A `service` actor **confirming** at `POST /issues/:ref/pr-links/confirm` is refused.
8. **`tests/services/service-actor.test.ts:46,57,61` stay green** — the delivery regression
   guard.
9. `claim_issue` supervised: assigns the agent, **mints a lease**, and a subsequent
   `heartbeat` renews it. Then the **SYD-111 bare-PATCH path** — `update_issue
   {status:"in_progress"}` on an unassigned issue — assigns the same agent.
10. `assertAssignee` under supervision: an `assigneeOnly` transition (`:425`) on an
    agent-assigned issue succeeds.
11. The migration: a pre-existing human-assigned supervised claim, through startup, then
    re-claimed by the agent. Idempotent across restarts.
12. The cookie affirm route still works — a regression guard on the gate deliberately left
    alone.
13. Boundary: `dependencies.ts:89` needs `edgeExists`, so a non-existent edge never diverts
    and falls to `:134` — a silent no-op today, a refusal after.

Acceptance is the **SYD-213 pentest matrix** re-run.

## Also required

A message and comment sweep. "Only humans move issues out of triage", "only agent actors
record progress notes", `needs-input.ts`'s assignee message, and `comments.ts`'s refusal text
all describe the old model and will now fire for supervised agents in cases that previously
passed. `whoami` should report both the accountable human and the acting agent.

## Risks

- **Scope.** Roughly triple revision 1. The identity rule pulls in the whole claim path,
  `heartbeatClaim`, a migration, and the supervised-agent namespacing.
- **`buildMcpServer`'s signature** (~20 threading sites) and the `startAgentSession` /
  `endAgentSession` owner-tie work are both expansions beyond the original story.
- **Review legibility.** Commit order: accessors, then the claim path, then the live holes,
  then the sweep. Carry the blast-radius table in the PR.
- **The lint rule and `NO_SESSION` must land with the change**, not after.

## Not closed by this work

**SYD-298 stays open** until `confirmPrLink` is converted and its service-token refusal test
passes.
