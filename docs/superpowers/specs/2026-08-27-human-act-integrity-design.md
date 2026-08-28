# Human-act integrity: separating attribution from authorization (SYD-281)

Story B of the SYD-279 epic. Design approved 2026-08-27.

## The problem

`resolveSupervisedPrincipal` (`src/services/supervised-sessions.ts:53-79`) resolves a
supervised session to a `Principal` whose `actor` is the **bound human**. That is
correct for attribution: the human is accountable for what their agent does, and
events carry dual provenance through `viaAgentId`/`sessionId`.

It is wrong for authorization. Every gate in the codebase asks `actor.type === "human"`,
and in a supervised session that question returns `true` for an agent. `Principal`'s own
docstring documents the conflation as intended — `actor` is "always the accountable root
(a human for supervised sessions)" — because attribution was the only consumer when it
was written.

The mechanism that let this spread is a fail-open default. `Attribution` is
`{ viaAgentId?, sessionId? }` and every service that takes it declares
`attr: Attribution = {}`. "This caller has no session" and "this caller forgot to thread
the session" are the same value, and only three services take it at all.

### Verified blast radius

A `sup_` token resolves **only at `/mcp`** (`src/server.ts:77`). REST never calls
`resolveSupervisedPrincipal`; `src/rest/api-routes.ts:173-180` says so explicitly and
keeps a `PendingAffirmation` arm as a tripwire against the day that changes. So the
reachable surface today is the MCP tool surface alone:

| MCP tool | site | today |
|---|---|---|
| `update_issue` → `done` | `issues.ts:317-366` | **gated** — the divert works |
| `declare_pr_link` | `pr-links.ts:291` | fails open |
| `remove_dependency` | `dependencies.ts:134` | fails open |
| `revoke_pr_link` | `pr-links.ts:585` | fails open |

`declare_pr_link` is the severe one, and it does something worse than bypass a gate.
The write is `confirmedBy: isAgent ? null : actor.id`, with
`isAgent = actor.type === "agent"`. A supervised principal resolves to the human, so an
agent's declaration is **auto-confirmed and stamped with the human's actor id**. It does
not evade the attestation; it manufactures one. `provesLanded` (`pr-links.ts:88-90`) then
accepts it as proof and the `pr_link_confirmed` event records `humanConfirmed: true`.
Nothing on the record distinguishes it from a confirm a person actually performed. That
is the whole of SYD-280's guarantee, voided silently.

`remove_dependency` violates a stated invariant in CLAUDE.md ("Dependency removal is
human-only") and needs no code to fix: `dependency.remove` already has an executor
(`hard-gate.ts:170-182`) and is already in `EXECUTABLE_GATE_ACTIONS`
(`settings.ts:99`). It is simply absent from the **live** `supervised.hard_gate_actions`,
which reads `["done"]` on the NAS — the registry default.

The remaining ~20 `requireHuman` sites are unreachable, but only because of the REST
containment above. That containment is incidental, not designed, and SYD-282's authorize
stamp plausibly wants supervised auth at REST.

## Approach

Two mechanisms, with the boundary drawn explicitly:

- **Divert** — the supervised agent legitimately proposes the action, so it parks a
  `pendingActions` row and a human releases it out-of-band by cookie click
  (`rest/pending-actions.ts:118-129`) or signature (`/affirm-signed`). Applies to `done`
  and `dependency.remove`, the two actions with executors. Already built, already proven.
- **Refusal** — the action is not something an agent proposes. The gate throws.

The design does not invent a model. Model (a) from the issue — a fresh out-of-band human
act — is the divert, and it already ships. What was missing is a way to ask "is a human
acting right now?" that a gate cannot get wrong by accident.

### The accessor

```ts
// src/services/principal.ts
declare const humanBrand: unique symbol;
export type HumanActor = Actor & { readonly [humanBrand]: true };

/**
 * The human who is ACTING, as distinct from the human who is ACCOUNTABLE
 * (`Principal.actor`). Null inside a supervised session: presence is not
 * consent for everything that follows.
 */
export function asHuman(p: Principal): HumanActor | null {
  if (p.sessionId != null) return null;
  return p.actor.type === "human" ? (p.actor as HumanActor) : null;
}
```

`Principal.actor` keeps its current meaning and its docstring. Attribution, events, and
provenance are untouched.

### Two shapes of call site

The brand only works where a function is human-*only*. Both populations derive from the
same predicate; they differ in how the call site consumes it.

**Human-only functions (~20) take `HumanActor` instead of `Actor`.** Passing a plain
`Actor` becomes a compile error, so `npm run typecheck` enumerates the work and a future
gate cannot be written wrong:

```
src/services/settings.ts          ×2   setSetting, resetSetting
src/services/actors.ts            ×3   setActorAttended, rotateActorToken, revokeActorToken
src/services/projects.ts          ×2   createProject, updateProject
src/services/webhooks.ts          ×3   create, update, delete
src/services/github-repos.ts      ×2   addGithubRepo, removeGithubRepo
src/services/triage-actions.ts    ×5   snooze, duplicate, retryDelivery,
                                       resolveProcessDeviation, resolveDeliveryFailure
src/services/affirmation-keys.ts  ×2   enrollAffirmationKey, revokeAffirmationKey
src/services/dependencies.ts      ×1   removeDependency's human branch
src/rest/api-routes.ts            ×2   requireHumanCaller: create actor, mint login link
```

`enrollAffirmationKey` carries **two** `type !== "human"` checks and only one of them
converts. Its `human` parameter is the authorizing caller and becomes `HumanActor`. Its
`target` parameter is the actor the key will belong to, and `target.type !== "human"`
(`affirmation-keys.ts:54`) is validating that keys belong to people — a data rule, not an
authorization check. It stays as it is. `listAffirmationKeys` has no human check at all.

**Mixed functions (3) accept any actor and branch on type**, so the brand cannot be their
parameter. They compute one predicate from the same source of truth:

```ts
const vouching = asHuman({ actor, sessionId: attr.sessionId }) !== null;
```

At `pr-links.ts:291` this replaces `isAgent`, which is the fix:

```ts
- confirmedBy: isAgent ? null : actor.id,
- confirmedAt: isAgent ? null : now,
+ confirmedBy: vouching ? actor.id : null,
+ confirmedAt: vouching ? now : null,
```

This also closes **SYD-298** (a `service` token can confirm a PR link and the proof
readers accept it). `isAgent`'s `!== "agent"` caught neither a service actor nor a
supervised agent; `vouching` catches both. SYD-298 should be closed as absorbed rather
than worked separately.

### Where `asHuman` is called

Adapters mint, services demand — the repo's existing "thin adapters over services" rule.

- **MCP** (`src/mcp/server.ts`) — holds the real `Principal`. The only place `sessionId`
  is ever non-null.
- **REST** (`src/rest/api-routes.ts`) — `asHuman({ actor: c.var.actor })`. No supervised
  principal exists here; a test locks that in so the containment is enforced rather than
  incidental.
- **CLI** (`src/cli.ts`) — the synthetic local human is minted once at the top.

## Behaviour changes

| Action | Today | After |
|---|---|---|
| `declare_pr_link` in a supervised session | auto-confirmed as the human | declared, `confirmedBy` null, `provesLanded` false |
| `revoke_pr_link` in a supervised session | full human powers | own link + unconfirmed + lease required |
| `remove_dependency` in a supervised session | executes | diverts to affirmation |
| `update_issue` → `done` | diverts | unchanged |
| the other ~20 gates | unreachable | unreachable **and** refused |

A declaration from a supervised session still lands, so the board still sees the work,
the link still blocks a second claim, and dispatch is unaffected. It is a claim awaiting
a vouch — "agents propose, humans confirm", as SYD-280 specified. The human confirms in
the SYD-290 UI at review time.

`remove_dependency` requires one settings write on the NAS alongside the code:

```
supervised.hard_gate_actions: ["done"] → ["done", "dependency.remove"]
```

Per CLAUDE.md's migration rule this is an operator step, not a startup migration — it
changes instance policy rather than deriving a value from existing data. **It must be
called out in the PR description**, or the code ships with the hole still open.

## Out of scope

`comments.ts:31,44`, `worker-preference.ts:30,51`, `issues.ts:664`, and
`pr-links.ts:140,470` read `actor.type === "human"` for **routing and display**, not
authorization — is this comment a question, does this actor prefer interactive work, does
this status change clear `needsInput`, was the confirmer a person. They are correct as
they stand and must not be converted. Converting them would change routing behaviour for
supervised sessions, which is a separate decision nobody has made.

No new executors. No changes to the divert. No changes to `Principal`'s attribution
semantics.

## Testing

TDD, per the repo's normal workflow. The load-bearing cases:

1. `asHuman` returns null iff `sessionId != null` or `actor.type !== "human"`.
2. A supervised principal is refused by every human-only gate.
3. REST resolves no `sup_` token — the containment made explicit.
4. `declare_pr_link` driven **through the MCP tool with a real `sup_` token** leaves
   `provesLanded` false and the link unconfirmed.
5. A `service` actor declaring a link leaves it unconfirmed (SYD-298).
6. `remove_dependency` in a supervised session parks a pending action instead of removing.

Case 4 is deliberately driven through the real entry point rather than by calling
`declarePrLink` directly. SYD-280 shipped inert because its tests called `upsertPrState`
directly while production never did; constructing the state under test masks the producer.

Acceptance is the **SYD-213 pentest matrix** re-run against the new gates. Every
human-only gate changes behaviour, so the matrix is the check that matters, not the unit
tests.

## Risks

- **Wide mechanical diff.** ~20 signature changes plus their call sites and tests. The
  compiler finds every one, so the risk is review fatigue rather than missed sites — the
  three reachable fixes should be legible in the diff and not buried.
- **The CLI's synthetic human.** `cli.ts:22` constructs `{ id: 0, name: "cli", type:
  "human", attended: true }`. It must mint a `HumanActor` at the top rather than casting
  at each of its four call sites, or the cast becomes the new fail-open default.
- **`affirmation-keys.ts` is the gate's own root of trust.** Enrolling a key is what
  makes a signed affirmation possible, so it must be converted, and its tests should
  assert a supervised session cannot enroll.
