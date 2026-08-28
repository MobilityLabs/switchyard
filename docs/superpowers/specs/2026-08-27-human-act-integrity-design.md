# Human-act integrity: separating attribution from authorization (SYD-281)

Story B of the SYD-279 epic. **Revision 3** — after two rounds of a seven-seat review
panel (2026-08-27). Findings and disposition: `docs/reviews/2026-08-27-syd281-panel.md`.

## The problem

`resolveSupervisedPrincipal` (`src/services/supervised-sessions.ts:53-76`) resolves a
supervised session to a `Principal` whose `actor` is the **bound human**. Correct for
attribution — the human is accountable, and events carry dual provenance via
`viaAgentId`/`sessionId`. Wrong for authorization, and wrong for identity.

Three distinct questions have been answered by one field:

1. **Who authorizes this?** — must be a human *acting*, not a human *accountable*.
2. **Whose credential is this?** — the agent's, in a supervised session.
3. **Whose name goes on the row?** — the assignee, the lease holder, the declarer.

`actor.type === "human"` answers (1) wrongly. `actor.type === "agent"` answers (2)
wrongly. `actor.id` answers (3) wrongly. A supervised principal is typed human and is not
typed agent, so it passes gates of *both* shapes.

Two mechanisms let it spread:

- **A fail-open default.** Services declare `attr: Attribution = {}`, so "no session" and
  "caller forgot to thread the session" are the same value. **Fourteen** carriers:
  `comments.ts:16`, `dependencies.ts:30,76`, `issues.ts:172,311,730` and `claimIssue:730`,
  `needs-input.ts:21`, `pr-links.ts:231,414,571`, `agent-sessions.ts:207`,
  `attachments.ts:102`, `queue.ts:76`, `mcp/server.ts:75`.
- **Two gate shapes.** Revision 1 surveyed only `!== "human"` and therefore missed the
  more dangerous half.

### The precedent this design generalizes

`mcp/server.ts:417` already solves the identity problem, by hand, at exactly one site:

```ts
// The one agent-scoped write: recordProgressNote's requireAgent rejects a
// human, and in a supervised session `actor` IS the human root — so act as
// the bound agent instead of relaxing the guard.
recordProgressNote(db, viaAgent ?? actor, ref, note, attribution);
```

That is `effectiveActor`, hand-rolled. Revision 2 wrongly called `progress_note` a live
fail-closed bug; it works, because of this line. The finding is not that it is broken —
it is that one site got it right and nothing generalized it.

### Blast radius, both gate shapes

From `grep -rn 'type === "human"\|type !== "human"\|type === "agent"\|type !== "agent"\|type === "service"' src/`.

**Reachable today from `/mcp` with a `sup_` token:**

| Site | Gate | What a supervised agent gets |
|---|---|---|
| `issues.ts:184,190,211` | `=== "agent"` | **Violates "agent-created issues land in `triage` with required provenance"** (CLAUDE.md) |
| `issues.ts:402` | `=== "agent"` | **Violates "issues in `triage` can only be moved out by human actors"** (CLAUDE.md) |
| `issues.ts:579` | `=== "agent"` | Applies `auto` — **opts its own issue into unattended dispatch.** Escalation |
| `issues.ts:389` | `=== "agent"` | `isHolderMutation` false ⇒ SYD-210 lease validation skipped on a held issue |
| `issues.ts:412-427` | `=== "agent"` | `AGENT_STATUS_TRANSITIONS` bypassed; can reopen a `done` issue |
| `issues.ts:530` | `=== "agent"` | The `in_progress` claim gates (SYD-99/111/124) |
| `issues.ts:610` | `=== "agent"` | Agents self-assign only; supervised can reassign anyone |
| `comments.ts:44` | `=== "human"` | **Clears `needsInput` and releases the claim** — an agent answers its own escalation. Contradicts human-clear-only (SYD-220/225) |
| `needs-input.ts:43` | `=== "agent"` | Holder lease check skipped on `request_human_input` |
| `pr-links.ts:241,242,248,254,289,291,305` | `=== "agent"` | See the predicate table |
| `pr-links.ts:585,593,598` | mixed | See the predicate table |
| `dependencies.ts:134` | `!== "human"` | **Violates "dependency removal is human-only"** (CLAUDE.md) |
| `delivery-events.ts:54` | `=== "agent"` | Its own comment: an agent posting these "could unblock its own issue or hide a failed delivery" |
| `delivery-attempts.ts:209` | `=== "agent"` | Same shape |

`update_issue` → `done` holds, but only because the divert (`issues.ts:314-316`) fires
before `:407`. **That coupling is load-bearing and undocumented** — drop `done` from
`supervised.hard_gate_actions` and `:407` falls open with the rest.

**Reachable at REST:** `confirmPrLink` (`pr-links.ts:417`, route `api-routes.ts:449`)
gates on `=== "agent"`, so a **`service`** actor passes and writes `confirmedBy: actor.id`
(`:458`). `SWITCHYARD_GITHUB_POLLER_TOKEN` and `SWITCHYARD_DELIVER_POLLER_TOKEN` are
service actors that already speak REST. **This is SYD-298's actual site**, and it is not
absorbed by any declare-path fix.

## The identity rule (new in revision 3)

**In a supervised session the acting agent holds the work.** It is the assignee, the lease
holder, and the declarer. The human remains the accountable root on every event.

This is the decision revision 2 left open, and everything else depends on it. Without it
`actingAgent` cannot be applied to any claim-scoped check: keyed to the agent it compares
against a human assignee and ships inert; keyed to the human it leaves the hole open.

```ts
// src/services/principal.ts
declare const humanBrand: unique symbol;
export type HumanActor = Actor & { readonly [humanBrand]: true };

/** (1) Who authorizes. Null in a supervised session: presence is not consent. */
export function asHuman(actor: Actor, ctx: Attribution): HumanActor | null {
  if (ctx.sessionId != null || ctx.viaAgentId != null) return null;
  return actor.type === "human" ? (actor as HumanActor) : null;
}

/**
 * (2) Whose credential. Null when no agent is acting.
 * Takes DbOrTx: every call site is inside a transaction. Returns null rather
 * than throwing on a missing or retyped row — `getActorById` throws
 * (actors.ts:75), which would turn "no agent acting" into a 500.
 * Re-checks `type` at use, mirroring resolveSupervisedPrincipal:69, so a role
 * change after the session was minted cannot launder an agent path.
 */
export function actingAgent(db: DbOrTx, actor: Actor, ctx: Attribution): Actor | null {
  if (ctx.viaAgentId != null) {
    const row = db.select().from(actors).where(eq(actors.id, ctx.viaAgentId)).get();
    return row && row.type === "agent" ? toActor(row) : null;
  }
  return actor.type === "agent" ? actor : null;
}

/** (3) Whose name goes on the row. Generalizes mcp/server.ts:417. */
export function effectiveActor(db: DbOrTx, actor: Actor, ctx: Attribution): Actor {
  return actingAgent(db, actor, ctx) ?? actor;
}
```

`ctx` is **required**, no default, on every function calling an accessor.

### `{}` is the next fail-open, at the value level

Requiring `ctx` stops omission, not a literal. `hard-gate.ts:181` and `:196-197` pass `{}`
today, and they are correct there — the executor runs as the human with deliberately empty
attribution. But they are two copy-paste exemplars sitting in the file.

The ESLint rule must ban **both** `as HumanActor` outside `principal.ts`, and an
object-literal `{}` passed as `ctx` outside an allowlist naming those `hard-gate.ts` lines
with their reason. A ban on the cast alone leaves the value-level hole open.

## Predicate tables

### `declarePrLink` / `revokePrLink`

| line | today | becomes |
|---|---|---|
| `:242-249` assignee check | `isAgent` | `actingAgent(...) !== null`, compared against `effectiveActor().id` |
| `:248` `validateLease` | keyed `actor.id` | keyed `effectiveActor().id` |
| `:254` role forcing | `isAgent` | `actingAgent(...) !== null` |
| `:289` `declaredBy` | `actor.id` | `effectiveActor(...).id` |
| `:291-292` `confirmedBy` | `isAgent` | `asHuman(...) !== null` |
| `:305` `confirmed:` payload | `isAgent` | `asHuman(...) !== null` — must track the row |
| `:585` outer branch | `!== "human"` | `asHuman(...) === null` |
| `:593` `declaredBy` compare | `actor.id` | `effectiveActor(...).id` |
| `:598` `validateLease` | `=== "agent"` | `actingAgent(...) !== null`, keyed `effectiveActor().id` |

`:289` and `:593` must move together. Converting `:585` alone was revision 2's error: the
comparison stays human-keyed, so a supervised agent can withdraw declarations its
supervisor made in person.

Do **not** blanket-substitute one predicate: `service` actors must keep passing the
lease gate untouched (`issues.ts:376-380` denies them claims wholesale). Note the poller
service actors reach links through `recordIngestedPrLink`, not `declarePrLink` — revision
2's "would break ingestion" rationale named the wrong function, though the caution stands.

### `issues.ts` — the table revision 2 owed this file

| line | today | becomes |
|---|---|---|
| `:184,190` provenance + description | `=== "agent"` | `actingAgent(...) !== null` |
| `:211` initial status | `=== "agent" ? "triage" : "backlog"` | `actingAgent(...) !== null ? "triage" : "backlog"` |
| `:214` `creatorId` | `actor.id` | `effectiveActor(...).id` |
| `:389` `isHolderMutation` | `=== "agent" && assigneeId === actor.id` | `actingAgent(...) !== null && assigneeId === effectiveActor().id` |
| `:402` triage exit | `=== "agent"` | `asHuman(...) === null` |
| `:407` done | `=== "agent"` | `asHuman(...) === null` (defence in depth behind the divert) |
| `:412-427` transition allow-list | `=== "agent"` | `actingAgent(...) !== null` |
| `:530` claim gates | `=== "agent"` | `actingAgent(...) !== null` |
| `:579` `auto` label | `=== "agent"` | `asHuman(...) === null` |
| `:610` self-assign only | `=== "agent"` | `actingAgent(...) !== null`, compared to `effectiveActor().id` |
| `:783` `claimIssue` assignee | `actor.name` | `effectiveActor(...).name` |
| `:769` `mintLease` | `actor.id` | `effectiveActor(...).id` |
| `assertClaimable:260` | `actor` | `effectiveActor(...)` |

## Populations

### A — human-only, take `HumanActor`

```
settings.ts        setSetting:206, resetSetting:227                   helper :113
actors.ts          setActorAttended:107, rotateActorToken:120,
                   revokeActorToken:132                               helper :12
projects.ts        createProject:17, updateProject:34                 helper :11
webhooks.ts        addWebhook:18, removeWebhook:39, setWebhookActive:48  helper :10
github-repos.ts    addGithubRepo:31, removeGithubRepo:57              helper :23
triage-actions.ts  snoozeIssue:54, markDuplicate:88, redeliverIssue:137,
                   resolveDeviation:250, resolveDeliveryFailure:282   helper :45
affirmation-keys.ts enrollAffirmationKey:44 (human check :51 only),
                   revokeAffirmationKey:124
hard-gate.ts       affirmPendingAction:91                    ← root of trust
pr-links.ts        confirmPrLink:409, backfillPrLinksFromPrState:505
supervised-sessions.ts openSupervisedSession:24             ← root of trust
rest/api-routes.ts requireHumanCaller:141 (returns HumanActor, not void)
```

Load-bearing rather than mechanical: **`affirmPendingAction`** (its owner tie at
`hard-gate.ts:131-135` compares `session.actorId === human.id` — under a supervised
principal that *matches* rather than saving you); **`confirmPrLink`** (SYD-298's live
site); **`openSupervisedSession`** (mints fresh `sup_` tokens).

**`rest/pending-actions.ts:126` is deliberately NOT in this list.** Its actor comes from
`getSessionActor` (`auth.ts:60-69`), which returns no session id, so `asHuman` cannot be
applied as designed — and threading the real cookie session id would make it return
`null` and break the cookie affirm route, the strongest human-presence signal in the
system. That route is already correct for this exact reason (`:119-124`). Leave it.
`:69` and `:138` still convert.

### B — mixed, take required `ctx` and the predicate tables

```
pr-links.ts        declarePrLink:225, revokePrLink:566
dependencies.ts    removeDependency:71
issues.ts          createIssue:172, updateIssue:305, claimIssue:725, assertClaimable:260
comments.ts        :44                    ← moved from C; live hole
needs-input.ts     :43
delivery-events.ts :54
delivery-attempts.ts :209
agent-sessions.ts  requireAgent:47 — three call sites: :126, :142, :209
```

`removeDependency` cannot be population A: `hard-gate.ts:181` and `mcp/server.ts:596` call
it with mixed actors, and typing it `HumanActor` deletes the divert.

**`requireAgent` has three callers, not one.** `:209` is `recordProgressNote` (already
correct via `mcp/server.ts:417`); `:126` and `:142` are `startAgentSession` /
`endAgentSession`, which have **no `Attribution` parameter at all** and whose owner tie
(`:145`) keys on `actor.id`. Converting `requireAgent` without threading `ctx` into those
two and re-keying the owner tie to `effectiveActor` reproduces the
owner-tie-matches-rather-than-saves-you pattern. Budget it.

### C — do not convert

```
worker-preference.ts:30,51   interactive routing
pr-links.ts:140,470          display: was the confirmer a person
affirmation-keys.ts:54       target must be human — data rule
auth.ts:15                   login links belong to humans — data rule
                             (the caller gate is api-routes.ts:235)
actors.ts:38                 default `attended` at creation
actors.ts:110                target must not be human — data rule
```

`issues.ts:664` and `comments.ts:44` were in this list in revision 2. `:44` moves to B
(it authorizes). `:664` stays out **only** because the `:44` conversion subsumes it —
state that, rather than leaving it unexplained.

## The brand is not the enforcement

`HumanActor` is erased at runtime. The private `requireHuman` helpers currently ask
`actor.type !== "human"` — the question this design proves returns the wrong answer.

**The predicate moves; the brand is additive.** Each helper takes actor + ctx, calls
`asHuman`, throws when null, returns the branded value. Deleting the runtime throw as
"newly redundant" makes authorization purely compile-time, and one cast reduces the gate
to a no-op with no runtime trace.

## Adapters

- **MCP.** Revision 2 said `mcp/server.ts` holds a `Principal`. It does not —
  `server.ts:94-101` destructures before the call. Change `buildMcpServer` to take a
  `Principal` and mint once per connection (~20 threading sites). `mcp/server.ts:417`'s
  hand-rolled `viaAgent ?? actor` collapses into `effectiveActor`.
- **REST.** `requireHumanCaller` returns `void` (`api-routes.ts:141-145`) so it cannot
  supply the branded value. It returns `HumanActor`; routes pass its result.
  `api-routes.ts:672` is an unclassified `=== "agent"` gate — classify it.
- **CLI.** One helper does the runtime check and returns `HumanActor`. `cliActor`
  (`cli.ts:22`), `requireHumanActor` (`cli.ts:27`), **and `linear-import.ts:352`'s second
  synthetic human** all route through it. No casts.

## The REST residual — stated, not claimed as containment

A supervised session runs on the human's workstation, which holds `.env` with
`SWITCHYARD_HUMAN_TOKEN`; `scripts/syd.ts` defaults to it. The agent's path to every REST
gate is not a `sup_` token — it is the human's bearer, at which point `asHuman` returns a
`HumanActor`. **Nothing at REST distinguishes a bearer presented by a person from the same
bearer presented by a process.** The cookie-only affirm route exists for exactly this
reason.

Keep the containment test; state the residual. Mitigation is credential hygiene plus the
cookie/signature routes, not `asHuman`.

## Migration

Existing supervised claims were written with the **human** as assignee and lease holder.
After the identity rule they would be unrecognisable to `isHolderMutation`.

Per CLAUDE.md this is mechanical — the mapping is a pure function of `events.viaAgentId`
on the claim event — so it belongs at startup like `ensureRolloutBackfill`, not as an
operator step. Scope it in the PR: how many live claims, and whether re-keying them or
simply expiring them is cheaper. **Expiring is likely correct** — a lease is short-lived
by design and a re-claim costs one call.

## Operator step

```
supervised.hard_gate_actions: ["done"] → ["done", "dependency.remove"]
```

**Fails closed.** Once `dependencies.ts:134` asks `asHuman(...) === null`, a supervised
removal on an un-updated NAS skips the divert (`:78,:89` need `isHardGated`) and is
**refused**. The setting upgrades refusal to a proposable divert — UX, not security.

## Behaviour changes

| Action | Today | After |
|---|---|---|
| `claim_issue` (supervised) | assigns + leases the **human** | assigns + leases the **agent** |
| `file_issue` | `backlog`, no provenance | `triage`, provenance required |
| `update_issue` out of `triage` / adding `auto` | permitted | refused |
| `update_issue` reassign / transition / claim gates | skipped | agent rules apply |
| `comment` clearing `needsInput` | permitted | refused |
| `declare_pr_link` | auto-confirmed as the human | claim + lease required, `delivers` forced, `declaredBy` = agent, unconfirmed |
| `revoke_pr_link` | full human powers | own link (agent-keyed) + unconfirmed + lease |
| `confirm_pr_link` (service, REST) | confirms; readers accept | refused |
| `remove_dependency` | executes | refused, or diverts once the setting lands |
| delivery events | can unblock its own issue | refused |
| `progress_note` | works (`mcp/server.ts:417`) | works, via `effectiveActor` |
| `update_issue` → `done` | diverts | unchanged |

**Second-order:** today's auto-confirm means supervised deliveries never trip
`done_without_merged_pr`. After the fix an issue affirmed `done` whose link was never
separately confirmed fails `attention.ts:113-121` and flags. That is the flag working as
designed, but it is new steady state. Convention: confirm the link in the SYD-290 UI
before affirming `done`.

## Testing

TDD, driven through real entry points — SYD-280 shipped inert because its tests called
`upsertPrState` directly while production never did.

1. `asHuman` null iff `sessionId != null` or `viaAgentId != null` or not human.
   `actingAgent` null on a missing row and on a row whose type is no longer `agent`.
   `effectiveActor` returns the agent supervised, the actor otherwise.
2. Every population-A gate refuses a supervised principal.
3. Every reachable inverse gate refuses, driven through the MCP tool: triage exit,
   `auto` label, reassign, transition allow-list, `file_issue` landing in `triage` with
   provenance, and `comment` failing to clear `needsInput`.
4. `declare_pr_link` over a real `sup_` token: refused without a claim, refused without
   the **agent's** lease, `role` forced, `declaredBy` = the agent, `provesLanded` false,
   **and the `pr_link_declared` payload's `confirmed` false.**
5. `revoke_pr_link`: the supervised agent can revoke its own declaration and **cannot**
   revoke one the human declared in person.
6. A `service` actor **confirming** at `POST /issues/:ref/pr-links/confirm` is refused
   (SYD-298's actual case).
7. `claim_issue` supervised assigns the agent; a subsequent claim-scoped write validates
   against the agent's lease.
8. `remove_dependency`: refused at the registry default, diverts once the setting lands.
   **Assert both in the same file** so the operator dependency is visible in the diff.
9. The cookie affirm route still works — a regression guard on the one gate deliberately
   left alone.
10. Boundary: `dependencies.ts:89` needs `edgeExists`, so a non-existent edge never
    diverts and falls to `:134` — a silent no-op today, a refusal after.

Acceptance is the **SYD-213 pentest matrix** re-run.

## Also required

A message and comment sweep. Errors like "Only humans move issues out of triage" and
"only agent actors record progress notes" describe the old model. A supervised agent that
hits the new refusals gets text that does not explain why.

## Risks

- **Scope.** Roughly triple revision 1. The identity rule pulls in `claimIssue`, the lease
  mint, `assertClaimable`, and a data migration none of which were in the original story.
- **`buildMcpServer`'s signature** (~20 threading sites) and `startAgentSession` /
  `endAgentSession` gaining `Attribution` are both unbudgeted expansions.
- **Review legibility.** Order the commits: accessors, then live holes, then the sweep.
  Carry the blast-radius table in the PR so a reviewer can tell the fixes from the
  prevention.
- **The lint rule must land with the change**, covering the cast *and* the `{}` literal.

## Not closed by this work

**SYD-298 stays open** until `confirmPrLink` is converted and its service-token refusal
test passes.
