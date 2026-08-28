# Human-act integrity: separating attribution from authorization (SYD-281)

Story B of the SYD-279 epic. Revision 2 — rewritten after a seven-seat review panel
(2026-08-27) found the revision-1 site census materially incomplete. Findings and their
disposition are in `docs/reviews/2026-08-27-syd281-panel.md`.

## The problem

`resolveSupervisedPrincipal` (`src/services/supervised-sessions.ts:53-76`) resolves a
supervised session to a `Principal` whose `actor` is the **bound human**. That is correct
for attribution: the human is accountable for what their agent does, and events carry dual
provenance through `viaAgentId`/`sessionId`.

It is wrong for authorization. `Principal`'s own docstring documents the conflation as
intended — `actor` is "always the accountable root (a human for supervised sessions)" —
because attribution was the only consumer when it was written.

Two mechanisms let this spread:

1. **A fail-open default.** `Attribution` is `{ viaAgentId?, sessionId? }` and services
   declare `attr: Attribution = {}`. "No session" and "caller forgot to thread the
   session" are the same value. Seven service files carry that default:
   `comments.ts:16`, `dependencies.ts:30,76`, `issues.ts:172,311,730`,
   `needs-input.ts:21`, `pr-links.ts:231,414,571`, `agent-sessions.ts:207`,
   `attachments.ts:102`.
2. **Two gate shapes, only one of them obvious.** A gate can ask `type !== "human"`
   (refuse non-humans) or `type === "agent"` (refuse agents). A supervised principal
   passes *both* — it is typed human and is not typed agent. Revision 1 surveyed only the
   first shape and therefore missed the more dangerous half.

### Blast radius, re-derived over both shapes

Derived from `grep -rn 'type === "human"\|type !== "human"\|type === "agent"\|type !== "agent"\|type === "service"' src/`.

**Reachable today from `/mcp` with a `sup_` token — these are live holes:**

| Site | Gate | What a supervised agent gets |
|---|---|---|
| `issues.ts:184,190,211` | `type === "agent"` | **Violates "agent-created issues land in `triage` with required provenance"** (CLAUDE.md). `file_issue` lands in `backlog`, no provenance, no description |
| `issues.ts:402` | `type === "agent"` | **Violates "issues in `triage` can only be moved out by human actors"** (CLAUDE.md) |
| `issues.ts:579` | `type === "agent"` | Applies the `auto` label — **opts its own issue into unattended dispatch.** Privilege escalation, not bookkeeping |
| `issues.ts:389` | `type === "agent"` | `isHolderMutation` false ⇒ SYD-210 lease validation skipped entirely on a held issue |
| `issues.ts:412-427` | `type === "agent"` | `AGENT_STATUS_TRANSITIONS` allow-list bypassed; can reopen a `done` issue |
| `issues.ts:530` | `type === "agent"` | The `in_progress` claim gates (SYD-99/111/124) |
| `issues.ts:610` | `type === "agent"` | Agents may only self-assign; supervised can reassign or unassign anyone |
| `needs-input.ts:43` | `type === "agent"` | Holder lease check skipped on `request_human_input` |
| `pr-links.ts:241,242,254,291,305` | `type === "agent"` | See "the declare path" below |
| `pr-links.ts:585,598` | `!== "human"` / `=== "agent"` | See "the revoke path" below |
| `dependencies.ts:134` | `!== "human"` | **Violates "dependency removal is human-only"** (CLAUDE.md) |
| `delivery-events.ts:54` | `type === "agent"` | The comment at `:48-53` says an agent posting these "could unblock its own issue or hide a failed delivery". A supervised principal is typed human and passes |
| `delivery-attempts.ts:209` | `type === "agent"` | Same shape |

`update_issue` → `done` is the one gate that holds, and only because the divert
(`issues.ts:314-316`) fires on `attr.sessionId != null && isHardGated(...)` *before*
reaching `issues.ts:407`. That coupling is load-bearing and undocumented: remove `done`
from `supervised.hard_gate_actions` and `:407` falls open like the rest.

**Reachable at REST — see "the REST residual" below, this is not containment:**
`confirmPrLink` (`pr-links.ts:417`, exposed at `api-routes.ts:449`) gates on
`type === "agent"`, so a **`service`** actor passes and writes `confirmedBy: actor.id`
(`:458`). `SWITCHYARD_GITHUB_POLLER_TOKEN` and `SWITCHYARD_DELIVER_POLLER_TOKEN` are
`service` actors that already speak REST, so this is live today. **This is SYD-298's
actual site.** Revision 1 claimed SYD-298 was absorbed by the `declare` fix; that was
wrong, and acting on it would have retired the issue with its primary vector open.

**The conflation also fails closed.** `agent-sessions.ts:48` `requireAgent` demands
`type === "agent"`. A supervised principal is typed human, so `progress_note` is
**refused** in supervised sessions today. This is a live functional bug, and it is why
one accessor is not enough.

## Approach

Three mechanisms, and a gate must state which one it wants.

- **Divert** — the agent legitimately proposes; park a `pendingActions` row and let a
  human release it out-of-band (`rest/pending-actions.ts:118-129`, or `/affirm-signed`).
  Applies to `done` and `dependency.remove`, the two actions with executors.
- **Refusal** — the action is not something an agent proposes. The gate throws.
- **Agent-path** — the gate is not about humanity at all; it asks "is this an agent
  credential, with the claim and lease that implies?" A supervised session must answer
  **yes** here, because the agent is the one acting.

### Two accessors, not one

Revision 1 had `asHuman` only, which cannot express the agent-path question and forced
three services to reconstruct a `Principal` from a defaulted `Attribution`.

```ts
// src/services/principal.ts
declare const humanBrand: unique symbol;
export type HumanActor = Actor & { readonly [humanBrand]: true };

/**
 * The human who is ACTING, as distinct from the human who is ACCOUNTABLE
 * (`Principal.actor`). Null inside a supervised session: presence is not
 * consent for everything that follows.
 *
 * Tests `viaAgent` as well as `sessionId`. They coincide today only because
 * `src/server.ts:91-93` withholds attribution from plain sessions for an
 * FK/logout reason (`deleteSession` hard-deletes rows `events.sessionId`
 * references), not an authorization one. Keyed on both, a future principal
 * carrying one without the other cannot fail open.
 */
export function asHuman(actor: Actor, ctx: Attribution): HumanActor | null {
  if (ctx.sessionId != null || ctx.viaAgentId != null) return null;
  return actor.type === "human" ? (actor as HumanActor) : null;
}

/**
 * The identity whose claim and lease govern this write. In a supervised
 * session that is the agent, never the accountable human — the human holds
 * no lease. Null when no agent is acting.
 */
export function actingAgent(db: DbOrTx, actor: Actor, ctx: Attribution): Actor | null {
  if (ctx.viaAgentId != null) return getActorById(db, ctx.viaAgentId);
  return actor.type === "agent" ? actor : null;
}
```

`ctx` is **required**, with no default, on every function that calls either accessor.
That is the fix for cause (1): the compiler enforces the threading the authorization
depends on, instead of the fix inheriting the defect it was written to remove. An
optional parameter here would rebuild the hole.

`actingAgent` is what makes the agent-path expressible. It answers the objection that a
service holds `Attribution` (which carries `viaAgentId`, a number) and cannot resolve the
acting `Actor` — it resolves it from the db, once, at the point of use.

### The three predicates, stated per line

`declarePrLink`'s `isAgent` (`pr-links.ts:241`) currently drives four behaviours. They do
not all want the same predicate, and blanket-substituting one for `isAgent` breaks
ingestion by newly lease-gating the poller `service` actors.

| line | today | becomes | why |
|---|---|---|---|
| `:242-249` assignee check | `isAgent` | `actingAgent(...) !== null` | claim-scoped; a supervised agent must hold the claim |
| `:251` `validateLease` | `isAgent`, keyed `actor.id` | `actingAgent(...)`, keyed **that agent's id** | the human holds no lease |
| `:254` role forcing | `isAgent` | `actingAgent(...) !== null` | agents must not mint `references` (`:251-253`) |
| `:291-292` `confirmedBy` | `isAgent` | `asHuman(...) !== null` | anything not a vouching human: agent, **service**, supervised |
| `:305` `confirmed:` payload | `isAgent` | `asHuman(...) !== null` | must track the row, or the audit event asserts a confirmation the row does not carry |

`:305` was missing from revision 1's diff. Left unchanged it writes `confirmedBy: null`
to the row while emitting `pr_link_declared` with `confirmed: true` — manufacturing the
attestation in the audit stream while fixing the mutable row.

`revokePrLink` has the same split: the outer branch gate (`:585`) takes the `asHuman`
form, and the inner `validateLease` (`:598`) takes `actingAgent`. Converting only the
outer leaves "lease required" false and compares `declaredBy` against the *human's* id —
letting a supervised agent withdraw declarations its supervisor made in person, from
other sessions. Converting both to one predicate instead makes a `service` actor hit
`validateLease` with an id that can hold no lease (`issues.ts:376-380` denies services
wholesale), turning a working path into an unconditional throw.

### Correction to revision 1's prose

The declare path emits `pr_link_declared` with `confirmed: !isAgent`
(`pr-links.ts:297-312`). It does **not** emit `pr_link_confirmed` /`humanConfirmed:
true` — that is `confirmPrLink` (`pr-links.ts:463-473`), which declare never calls. The
hole is real; the mechanism revision 1 described was not.

## The conversion, by population

### Population A — human-only functions take `HumanActor`

The brand rides on the return type, so a plain `Actor` is a compile error and
`npm run typecheck` enumerates the work.

```
src/services/settings.ts        setSetting:206, resetSetting:227              helper :113
src/services/actors.ts          setActorAttended:107, rotateActorToken:120,
                                revokeActorToken:132                          helper :12
src/services/projects.ts        createProject:17, updateProject:34            helper :11
src/services/webhooks.ts        addWebhook:18, removeWebhook:39,
                                setWebhookActive:48                           helper :10
src/services/github-repos.ts    addGithubRepo:31, removeGithubRepo:57         helper :23
src/services/triage-actions.ts  snoozeIssue:54, markDuplicate:88,
                                redeliverIssue:137, resolveDeviation:250,
                                resolveDeliveryFailure:282                    helper :45
src/services/affirmation-keys.ts enrollAffirmationKey:44 (human check :51 only),
                                revokeAffirmationKey:124
src/services/hard-gate.ts       affirmPendingAction:91          ← root of trust
src/rest/pending-actions.ts     :69, :126, :138                 ← root of trust
src/services/pr-links.ts        confirmPrLink:409, backfillPrLinksFromPrState:505
src/services/supervised-sessions.ts openSupervisedSession:24    ← root of trust
src/rest/api-routes.ts          requireHumanCaller:141
```

Revision 1 used prose labels (`retryDelivery`, `resolveProcessDeviation`, `create/update/
delete`) that are not real identifiers. The names above are grep-able.

**Three additions are load-bearing rather than mechanical, and must not be reviewed as
part of the sweep:**

- **`affirmPendingAction` (`hard-gate.ts:91`)** turns a parked proposal into a real `done`
  or a real dependency removal. It is the root of trust for the divert this whole design
  rests on. Its owner tie (`hard-gate.ts:131-135`) compares `session.actorId === human.id`
  — under a supervised principal that is the bound human's id, so the owner tie
  **matches** rather than saving you. The day supervised auth reaches REST (which SYD-282
  plausibly wants), `/affirm-signed` authorizes on `c.var.actor` and a supervised agent
  affirms the action it itself parked. That is not a weakened gate; it is the gate running
  in reverse.
- **`confirmPrLink` (`pr-links.ts:409`)** is SYD-298's actual site, live today via a
  `service` token at `api-routes.ts:449`.
- **`openSupervisedSession` (`supervised-sessions.ts:24`)** decides who can mint a
  supervised session at all — reaching it yields a fresh 12h `sup_` token bound to the
  same human under an agent name of the caller's choosing.

### Population B — mixed functions take the predicates

These must keep accepting any actor (to reach a divert, or to serve agents legitimately),
so the brand cannot be their parameter type. Each takes a **required** `ctx: Attribution`
and applies the predicate table per line.

```
src/services/pr-links.ts      declarePrLink:225, revokePrLink:566
src/services/dependencies.ts  removeDependency:71
src/services/issues.ts        createIssue:172, updateIssue:305
src/services/needs-input.ts   :43
src/services/delivery-events.ts :54
src/services/delivery-attempts.ts :209
src/services/agent-sessions.ts requireAgent:47   ← the fail-closed one
```

`removeDependency` was filed in population A in revision 1. That was wrong: `hard-gate.ts:181`
and `mcp/server.ts:596` call it with mixed actors, and typing its parameter `HumanActor`
means the MCP adapter cannot call it at all — which deletes the divert this design is
trying to enable.

`requireAgent` (`agent-sessions.ts:47`) becomes `actingAgent(...) !== null`, which fixes
the live fail-closed bug: `progress_note` starts working in supervised sessions.

### Population C — do not convert

These read a type for **routing, display, or as a data rule about a target**, not to
authorize the caller. Converting them changes behaviour nobody has decided to change.

```
src/services/comments.ts:31,44        is this comment a question / clear needsInput
src/services/worker-preference.ts:30,51  interactive routing
src/services/issues.ts:664            clear needsInput on status change
src/services/pr-links.ts:140,470      display: was the confirmer a person
src/services/affirmation-keys.ts:54   target must be human — a data rule
src/services/auth.ts:15               login links belong to humans — a data rule
src/services/actors.ts:38             default `attended` at creation
```

`auth.ts:15` and `affirmation-keys.ts:54` are the same shape and are named explicitly
because a mechanical implementer will otherwise convert them.

## The brand is not the enforcement

`HumanActor` is erased at runtime. The six private `requireHuman` helpers listed in
population A currently ask `actor.type !== "human"` — the question this design proves
returns the wrong answer for a supervised principal.

**The predicate moves; the brand is additive.** Each helper takes enough to call
`asHuman` (actor + ctx) and throws when it is null, returning the branded value on
success. Deleting the runtime throw as "newly redundant" would make authorization purely
compile-time, and one `as HumanActor` cast — the CLI needs one — reduces the gate to a
no-op with no runtime trace.

Add an ESLint rule banning `as HumanActor` outside `principal.ts` and the single CLI mint.
Revision 1 predicted the cast would become the new fail-open default under Risks but did
nothing to prevent it.

## Where the accessors are called

- **MCP.** Revision 1 said `mcp/server.ts` "holds the real `Principal`". It does not —
  `src/server.ts:94-101` destructures it before the call, and `buildMcpServer` takes
  `actor`, `attribution`, `viaAgent` separately. **Change `buildMcpServer` to take a
  `Principal`** and mint once per connection. The alternative — every tool call
  reassembling a principal by hand — is the pattern this design exists to remove. This is
  ~20 threading sites that revision 1 neither listed nor budgeted.
- **REST.** `requireHumanCaller` returns `void` today (`api-routes.ts:141-145`), so it
  cannot supply the branded value downstream. It becomes a function returning
  `HumanActor`, and each human-only route passes its result rather than `c.var.actor`.
- **CLI.** One helper performs the runtime check and returns `HumanActor`; `cliActor`
  (`cli.ts:22`) and `requireHumanActor` (`cli.ts:27`) both route through it.
  **`linear-import.ts:352` constructs a second synthetic human** and passes it to
  `createProject` at `:355` — it goes through the same helper, not a cast.

## The REST residual — stated, not claimed as containment

Revision 1 proposed a test locking in "REST resolves no `sup_` token" and recorded the
REST gates as "unreachable **and** refused". The first half is true; the second is not the
boundary it sounds like.

A supervised session runs on the accountable human's workstation. That workstation has
`.env` with `SWITCHYARD_HUMAN_TOKEN`, and `scripts/syd.ts` defaults to it. The supervised
agent's path to every REST gate is not a `sup_` token — it is
`npx tsx scripts/syd.ts api POST /settings/…` with the human's bearer, at which point
`asHuman` returns a `HumanActor` and every converted gate opens.

**Nothing at the REST layer can distinguish a human's bearer presented by a person from
the same bearer presented by a process.** The codebase already knows this: the cookie-only
affirm route (`rest/pending-actions.ts:118-129`) exists for exactly this reason and says
so in its comment.

So: keep the test, but state the residual in the PR and in this spec. REST gates are
enforced against `sup_` principals; a supervised agent with filesystem access to the
human's bearer bypasses them, and the mitigation is credential hygiene plus the
cookie/signature routes — not `asHuman`.

## Operator step

```
supervised.hard_gate_actions: ["done"] → ["done", "dependency.remove"]
```

**This fails closed, not open.** Revision 1 said the code "ships with the hole still open"
without it; that is backwards. Once `dependencies.ts:134` asks `asHuman(...) === null`, a
supervised `remove_dependency` on an un-updated NAS skips the divert
(`dependencies.ts:78,89` require `isHardGated`) and lands in the converted branch —
**refused**. The setting upgrades refusal to a proposable divert. It is UX, not security,
and framing it correctly lowers the risk of a partially-applied rollout.

`setSetting` validates against `EXECUTABLE_GATE_ACTIONS` (`settings.ts:157-163`), and
settings are REST-only with no MCP surface, so the write itself is safe.

## Behaviour changes

| Action | Today | After |
|---|---|---|
| `file_issue` (supervised) | lands `backlog`, no provenance | lands `triage`, provenance required |
| `update_issue` out of `triage` | permitted | refused |
| `update_issue` adding `auto` | permitted — self-escalation | refused |
| `update_issue` reassign/claim/transition | agent gates skipped | agent gates apply, lease keyed to `viaAgent` |
| `declare_pr_link` | auto-confirmed as the human | claim + lease required, role forced `delivers`, unconfirmed |
| `revoke_pr_link` | full human powers | own link + unconfirmed + agent's lease |
| `confirm_pr_link` (service, REST) | confirms; proof readers accept | refused |
| `remove_dependency` | executes | refused, or diverts once the setting lands |
| `progress_note` (supervised) | **refused (bug)** | works |
| delivery events (supervised) | can unblock its own issue | refused |
| `update_issue` → `done` | diverts | unchanged |

**Second-order effect to state in the PR:** today's auto-confirm means supervised
deliveries never trip `done_without_merged_pr`. After the fix, an issue affirmed to `done`
whose link the human never separately confirmed fails the attention NOT-EXISTS
(`attention.ts:113-121` requires `confirmed_by IS NOT NULL`) and flags. That is the system
working as designed — the flag *is* the vouch reminder — but it is new steady-state
behaviour for the primary supervised workflow. The convention is: confirm the link in the
SYD-290 UI before affirming `done`.

## Testing

TDD. Driven through real entry points, not by constructing state — SYD-280 shipped inert
because its tests called `upsertPrState` directly while production never did.

1. `asHuman` returns null iff `sessionId != null` **or** `viaAgentId != null` or the actor
   is not human. `actingAgent` resolves `viaAgentId` in a supervised session and the actor
   itself for a plain agent.
2. Every population-A gate refuses a supervised principal.
3. Every reachable inverse gate refuses a supervised principal, driven through the MCP
   tool: triage exit (`issues.ts:402`), the `auto` label (`:579`), reassign (`:610`), the
   transition allow-list (`:412`), and supervised `file_issue` landing in `triage` with
   provenance (`:184,190,211`).
4. `declare_pr_link` over a real `sup_` token: refused without a claim, refused without
   the agent's lease, `role` forced to `delivers`, `provesLanded` false, **and the
   `pr_link_declared` payload's `confirmed` field false.** Asserting only the row would
   pass with the event still lying.
5. A `service` actor **confirming** via `POST /issues/:ref/pr-links/confirm` is refused —
   this is SYD-298's actual case. A service *declaring* (revision 1's case 5) is not.
6. `remove_dependency` supervised: refused at the registry default, diverts once
   `dependency.remove` is in `hard_gate_actions`. **Assert both**, in the same file, so the
   operator dependency is visible in the diff rather than hidden in test setup.
7. `progress_note` works in a supervised session (the fail-closed regression).
8. Boundary: `dependencies.ts:89` also requires `edgeExists`, so removing a non-existent
   edge never diverts and falls to `:134` — today a silent no-op, after the change a
   refusal.

Acceptance is the **SYD-213 pentest matrix** re-run against the new gates.

## Risks

- **Scope.** This is roughly double revision 1. The inverse-gate population in `issues.ts`
  is the reason, and it is not optional: two of those sites are invariants CLAUDE.md
  states as server-enforced, and one is a self-escalation into unattended dispatch.
- **`buildMcpServer`'s signature change** touches ~20 threading sites and was unbudgeted
  in revision 1.
- **Review legibility.** The PR must let a reviewer tell the live fixes from the
  prevention sweep without reconstructing the blast-radius table. Carry the table in the
  PR description and order the commits: accessors first, then live holes, then the sweep.
- **The cast is the new fail-open default** unless the ESLint rule lands with the change,
  not after it.

## Not closed by this work

**SYD-298 stays open** until `confirmPrLink` is converted and its service-token refusal
test passes. Revision 1's instruction to close it as absorbed would have retired the issue
with its primary vector live.
