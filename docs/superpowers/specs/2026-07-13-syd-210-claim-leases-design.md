# SYD-210 — Session-scoped claim leases (design)

> 2026-07-13. Implements Step 4 of `docs/2026-07-12-sync-simplification-assessment.md`
> ("Make claims session-scoped leases"). That doc is the approved policy spec; this
> is the implementation design, grounded in the current claim/auth code.

## Problem

A "claim" today is nothing but two columns on the `issues` row — `assigneeId`
(→ `actors.id`) and `status = "in_progress"`. Authorization to mutate a claimed
issue is derived **entirely from identity**: `assertClaimable` early-returns when
`current.assigneeId === actor.id` (`src/services/issues.ts:175`). Dispatched
sessions share the worker actor's single token (`scripts/agent-worker.ts` threads
one `SWITCHYARD_TOKEN` to every child), so two sessions of that one actor both
pass the identity check — the residual SYD-93/122 shared-token hole. Release is
also a guess: a healthy-but-quiet container is released to `todo` after
`claims.stale_seconds` (4h) of no events and re-dispatched while still running.

## Goal

Make a claim a **session-scoped lease**: a server-minted, hashed, single-use
credential that a specific session must present on every claim-scoped mutation.
Two sessions of the same actor can no longer both hold a claim, and container
liveness becomes an honest heartbeat instead of a 4h idle guess.

The work is two cleanly-separable layers:

- **Layer A — the security fix** (closes SYD-93/122): lease token, threading,
  opt-in takeover, the three termination paths, the hard-cutover migration.
- **Layer B — liveness** (replaces the 4h guess): host-side heartbeats +
  cancellation for containers; long fixed TTL for interactive sessions.

Layer A is the actual security close and lands first; Layer B is a fast-follow
in the same issue.

## 1. Schema — new `claim_leases` table

```
claim_leases
  id             integer pk autoincrement
  issue_id       integer  -> issues.id     (not null)
  actor_id       integer  -> actors.id      (not null)
  token_hash     text unique                (sha256 hex, hash-at-rest)
  expires_at     integer                    (epoch seconds, not null)
  last_beat_at   integer                    (heartbeat renewal; = created_at at mint)
  created_at     integer  default now()
  invalidated_at integer null               (takeover / human-answer release)
```

Index on `issue_id`. The **active lease** of an issue:

```sql
WHERE issue_id = ? AND invalidated_at IS NULL AND expires_at > <now>
```

By construction a claim is 1:1 with an issue, so there is at most one active
lease per issue; historical/invalidated rows are retained for audit. The
existing `issues` claim columns (`assigneeId`, `status`) **stay** — the lease is
the credential layer *on top of* the existing claim state, not a replacement.
This clones the `sessions`/`loginLinks` precedent (`tokenHash` unique + `actorId`
+ `expiresAt`, schema 115–134).

## 2. Service layer — new `src/services/leases.ts`

- `mintLease(tx, issueId, actorId, ttlSeconds)` → inserts a row with a fresh
  `mintToken("lease")`, stores `hashToken(token)`, returns the **plaintext token
  once**. Never returned again, never logged, never serialized.
- `validateLease(db, issueId, actorId, token)` → hash-compare against the active
  lease for that issue+actor; throws `SwitchyardError` on missing / expired /
  actor-mismatch / hash-mismatch. Pure read; no side effects.
- `invalidateLease(tx, issueId, reason)` → sets `invalidated_at` on the active
  lease (used by takeover and the human-answer release).
- `heartbeatLease(db, issueId, actorId, token)` → validates, then renews
  `last_beat_at = now` and extends `expires_at = now + ttl`.
- `expireLeases(db)` → sweep: for each issue whose active lease has
  `expires_at <= now`, atomically release the claim reusing the
  `stale-claims.ts:47-58` **re-assert-inside-UPDATE** pattern
  (`UPDATE issues SET status='todo', assigneeId=null WHERE id=? AND
  status='in_progress' AND needs_input=0`; `changes===0` ⇒ someone else won,
  skip), record `claim_released {reason:"lease_expired"}`, and mark the lease
  `invalidated_at`. This **replaces** the 4h idle-guess for leased claims;
  `releaseStaleClaims` keeps handling any lease-less claim during the deploy
  window (none after cutover).

All lease writes happen inside the same transaction as the claim/issue mutation
they accompany, so a lease and its claim can never diverge.

## 3. Threading the lease token across both adapters

Claim-scoped service functions gain a `leaseToken?: string` parameter. Which
calls require a valid lease is defined precisely by the claim lifecycle:

- **Require a valid lease** — any mutation of an *already-claimed* issue by its
  holder: `updateIssue` when it performs a status transition on, or edits a
  field of, an issue that is `in_progress` with an assignee (including the
  `in_progress → in_review`/`todo` transitions and self-assign re-PATCH), and
  `requestHumanInput`.
- **Mint (no prior lease)** — `claimIssue`, and `updateIssue`'s SYD-111
  auto-claim path (`status → in_progress` on an unassigned issue): these *create*
  the claim and therefore mint + return a lease rather than validate one.
- **Invalidate (lease-exempt)** — the release paths: `updateIssue status→todo`
  and the human-answer release (§4) invalidate the active lease; the human-answer
  path is exempt because the answering human never held it.
- **Heartbeat** — `heartbeatLease` validates then renews. The **request context carries only the
resolved `Actor`** today (`api-routes.ts` middleware sets `c.var.actor`; the MCP
server bakes the actor into the tool-closure at `src/server.ts:78`), and there
is no per-call credential channel — so each adapter supplies the token
differently:

- **MCP** — tool handlers never receive HTTP headers, so the lease token is an
  explicit `lease_token` **input field** on `update_issue`, `request_human_input`,
  the claim-release transition, and the new `heartbeat` tool. For container
  sessions the host `agent-worker`/SDK **injects** it (env → SDK → tool arg); it
  is **never** written into the LLM transcript (a secret whose custody runs
  through a transcript is neither reliably retained under compaction nor
  reliably confidential).
- **REST** — an `X-Switchyard-Lease` header, extracted once in the auth
  middleware into `c.var.leaseToken` (mirrors `Authorization` → `c.var.actor`),
  so it never sits in a request body/log and every route reads it uniformly.

`claim_issue` (both adapters) returns the freshly-minted plaintext token in its
response — the once-only handoff to the claiming session/host.

**Exempt surfaces (no lease required), per the policy spec:** `comment`,
`progress_note`, `attach_file`, `list_agent_sessions`. These are additive
collaboration signals that cannot cause double-work or corrupt claim state, and
answer-sessions (separate dispatch pool) must be able to comment on issues whose
work lease they don't hold.

## 4. Takeover + the three termination paths

- **Opt-in takeover.** A bare same-actor `claim_issue` against an issue that
  already has an active lease **fails loudly** ("this actor already holds an
  active lease — pass `takeover: true` to seize it"). `claim_issue(ref,
  {takeover: true})` atomically invalidates the old lease, mints a fresh one,
  and records a `lease_taken_over` event; the evicted holder's next
  lease-gated call is rejected immediately. Takeover is opt-in because this
  project's own workflow tells every session to `claim_issue` before touching
  code, and interactive + dispatched sessions share the worker actor — a default
  takeover would silently kill a healthy running container.
- **Three first-class termination paths:** (1) **expiry** (§2 sweep), (2)
  **takeover** (above), (3) the **human-answer release** — a human comment on a
  `needsInput` issue (`src/services/comments.ts:30-52`) clears the escalation and
  releases the claim. Under leases it also **invalidates the active lease**, and
  **preserves today's status condition** (line 34): an `in_progress` issue
  releases (status→`todo`, assignee→null, lease invalidated); a non-`in_progress`
  issue only clears `needsInput` (no release, no lease invalidation). This path
  is itself **lease-exempt** — the answering human never held the session's
  lease and cannot present it.

## 5. Liveness / heartbeats (Layer B)

- New `heartbeat(ref, lease_token)` on both adapters renews the lease
  (`heartbeatLease`).
- **Container sessions:** the host-side `agent-worker` process heartbeats on the
  container's behalf while it runs — the honest claim is "the supervising worker
  is alive and the container exists," not "the LLM called a tool on a timer." The
  worker SDK ties heartbeat failure to a cancellation signal: after **N missed**
  renewals it terminates its own workload rather than racing a re-dispatch.
  **Interval 60s, N = 10 missed (~10 min).** `N × interval` comfortably exceeds
  the worst-case tracker redeploy (~5–15s, SYD-66); additionally, **expiry is
  gated on the server having been continuously up** for the window, so a redeploy
  — a *correlated* outage across every container — cannot mass-expire every live
  lease at once.
- **Interactive sessions:** no background timer exists, so a **long fixed TTL**
  via a new `claims.lease_ttl_seconds` setting (default **8h**, ≈ today's
  4h-class behavior, chosen ≥ a long tool call). If an interactive session loses
  its token (context compaction), it re-acquires via opt-in takeover.

`claims.deviation_seconds` (the "claimed but idle" nudge chip, 1h) is unchanged —
it powers an attention chip, not release, and stays a heuristic.

## 6. Hard-cutover migration

Enforcement is a **hard cutover** (chosen over optional-first): the enforcing
deploy makes a valid lease **required** on every claim-scoped mutation. A
one-time migration handles pre-existing lease-less claims by an **honest reset**:
release every in-flight `in_progress` claim (status→`todo`, assignee→null,
record `claim_released {reason:"lease_cutover"}`). No running session holds a
lease token, so releasing for clean re-claim is cleaner than backfilling
synthetic tokens no session can present. Post-cutover, every claim flows through
the new mint path.

**Blast radius today is low:** the worker launchd services are not running, so
the only live claim at cutover is this interactive session on SYD-210 itself,
which simply re-claims. **Deploy coordination:** because the tracker and worker
host deploy separately, the enforcing tracker deploy and the worker-host upgrade
(new `agent-worker`/SDK that mints/injects/heartbeats leases) must land together
or with the worker host down — an un-upgraded worker making a lease-less
claim-scoped call would be rejected. (This is the accepted cost of the hard
cutover.)

## 7. Tests (policy-spec Step 6)

- **Lease lifecycle:** mint returns a token once; `validateLease` accepts the
  minted token and rejects a wrong/absent/expired one.
- **Expiry:** a lease past `expires_at` is swept to `todo` with
  `claim_released {reason:"lease_expired"}`; expiry needs the full window; the
  expiry-vs-legitimate-transition race resolves atomically (re-assert-in-UPDATE).
- **Shared-token hole closed:** a second session presenting the *shared bearer
  token* but **no lease token** (or a stale one) cannot `update_issue`,
  transition, or `heartbeat` — the SYD-93/122 regression.
- **Takeover:** a bare same-actor `claim_issue` against an active lease fails
  loudly; `takeover:true` invalidates the old token, records `lease_taken_over`,
  and the evicted holder's next lease-gated call is rejected immediately.
- **Exempt surfaces:** `comment`/`progress_note`/`attach_file`/
  `list_agent_sessions` still work without a lease.
- **Human-answer release:** a human answer on a `needsInput` `in_progress` issue
  invalidates the lease and releases; on a non-`in_progress` issue it only
  clears the flag (no release, no invalidation).
- **No serialization:** the lease token never appears in a serialized issue, an
  event payload, `agent_sessions`, or any GET-able claim state — only its hash,
  only in `claim_leases`.
- **Cutover migration:** releases every in-flight `in_progress` claim and fires
  no spurious events for lease-less/other-status issues.
- **Heartbeat (Layer B):** a renewal extends `expires_at`; expiry needs N missed
  beats; a redeploy (server-uptime gate) does not mass-expire live leases.

## Sequencing

1. **Layer A** — schema + `leases.ts` (mint/validate/invalidate/expire) +
   thread `leaseToken` through the claim-scoped service functions + both
   adapters (`lease_token` MCP field, `X-Switchyard-Lease` REST header) +
   takeover + human-answer release + the hard-cutover migration + the Layer-A
   tests. This is the SYD-93/122 close and is independently shippable.
2. **Layer B** — `heartbeat` surface + `heartbeatLease` + the host-side
   `agent-worker`/worker-SDK heartbeat loop and cancellation + server-uptime
   expiry gate + the heartbeat tests.

Independent of the pr_state/delivery track (SYD-205–209); can proceed in
parallel.
