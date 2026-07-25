# Supervised interactive sessions — design

**Date:** 2026-07-15
**Status:** Draft for review
**Topic:** A first-class interactive path alongside headless dispatch

## Problem

Switchyard's coordination machinery — claims, lease tokens, actor-scoped
reconcile, the launchd dispatch worker, `agent/<ref>` branch restrictions, the
credential-injecting egress proxy, WIP column limits as back-pressure — exists to
coordinate **multiple autonomous headless workers that can't talk to each other
and run unattended**. Every server guardrail keys off a binary question: *is the
acting principal a human or an agent?* Agents land issues in `triage`, can never
stamp `done`, can't remove dependencies; humans can do all of it.

That binary has no slot for the case where **one human drives one Claude Code
session interactively**, continuously present, on a machine with full git/GitHub
credentials. Today such a session authenticates as the human's token and must
pass `lease_token` by hand on claim-scoped writes (SYD-220/225). The consequences:

- **Provenance is lost.** The session acts *as the human*, so the event log says
  a human did work that Claude actually authored. The "an agent wrote this code"
  fact — which is load-bearing for this project — disappears.
- **Guardrails misfire both ways.** As the human, nothing lands in triage and
  `done` is stampable (fine), but there's no record an agent was involved. If we
  flipped it to act *as an agent*, every human-gated action would wrongly block a
  human who is sitting right there.
- **The dispatch race is unresolved.** Moving an issue to `todo` triggers
  auto-dispatch; an interactive session's claim doesn't protect it because
  interactive and dispatch currently share an actor identity (SYD-93 was fixed
  twice in parallel as a result).

`workerPreference = "interactive"` exists but is a *negative* — it only makes
dispatch skip an issue. There is no positive, well-modeled interactive path.

## Goal

Make "a supervised interactive session drives the work" a first-class path that
**coexists** with headless dispatch, **preserves provenance** ("an agent edited
this, under a named human"), and **relaxes the guardrails that only existed
because dispatched workers are untrusted-and-unattended** — without silently
dropping the guarantees that exist for real reasons.

Non-goal: replacing dispatch. Both paths stay; this design is about giving the
interactive path a real model and cleanly separating the two lanes.

## The model — six pillars

### 1. A supervised session is a session-kind binding two actors (not a new actor type)

`actors.type` stays `human | agent | service`. Supervision is not a new *actor* —
it's a new *session kind* that binds two existing actors together for the life of
one interactive run.

A new MCP call, `open_supervised_session`, is the handshake:

- The caller is **already authenticated as a human** (their login token — the
  root of trust).
- The call **declares the agent identity** doing the editing (a stable
  `claude-code` agent actor).
- The server mints a **supervised-session token** binding
  `{ human: Y, agent: X, opened_at, session_id }` and returns it. This is what
  every subsequent write carries — no more per-call `lease_token`; the binding is
  ambient in the session token.
- Opening writes one `supervised_session_opened` event. **This is where the
  human's accountability attaches** — "Y stood up a supervised session with X
  at T."

Schema: extend the existing `sessions` table with a nullable `via_agent_id`
(the bound agent) and a `kind` column (`"plain" | "supervised"`). A supervised
session row therefore references *two* actors — `actor_id` = the human, and
`via_agent_id` = the agent.

### 2. Dual attribution in the event log keeps provenance honest

`events` today has a single `actor_id`. Add two nullable columns:

- `via_agent_id` — the agent that did the editing (X).
- `session_id` — the supervised session, so a whole run of edits is one
  traceable unit back to `supervised_session_opened`.

Under a supervised session, `actor_id` = the human Y (accountable, "present"),
`via_agent_id` = the agent X (editor). A `done` stamp then reads as exactly what
happened — *Y, via X, stamped this done* — neither "a human did this" (which
would erase the agent) nor "an agent did this" (which the guardrails forbid).

The change is purely additive; existing single-actor events have `via_agent_id`
and `session_id` null and are unaffected. Surfaces that render provenance (issue
history, board) show e.g. "✍️ claude-code · under Sean" on supervised actions.

### 3. Guardrail posture: full absorption, with per-project hard-gate opt-outs

Every human-gated rule asks "is the actor a human?" A supervised session's
accountable actor **is** a human (Y), so by default the rules pass — not by
special-casing each one, but because the bound principal genuinely is a
supervising human.

| Rule (today) | Supervised default |
|---|---|
| Only humans move issues out of `triage` | Passes — pair moves freely |
| Agents can never transition to `done` | Passes — pair can stamp done |
| Dependency removal is human-only | Passes — pair can remove deps |
| Agent-created issues land in `triage` w/ provenance | Relaxes — supervised-created issues may land in `backlog`; provenance still recorded via `via_agent_id` |
| `claim_issue` refuses others' claims / open PRs | **Unchanged — still enforced** (the dispatch interlock, pillar 4) |

This is **option A (full absorption)**: the pair can do anything the human can,
inline. The guarantee is *accountability after the fact* via the audit log, not
*presence at the moment* — with one escape hatch:

The **hard-gate** is a per-project policy: a list of action-types (e.g. `done`,
`dependency.remove`) that, even in a supervised session, require a fresh human
affirmation before committing. Empty list = pure option A (frictionless). A
project that wants the `done`-stamp to stay a deliberate human beat adds `done`.
Set by a human project admin; the session cannot alter it mid-run.

### 4. Dispatch coexistence: flag for intent, claim for enforcement

Both mechanisms, each doing what it's good at:

- **`workerPreference` becomes positive and lane-bearing.** `interactive` means
  "a supervised session owns this," `dispatch` (or an engine name) means "headless
  worker." This is **intent / board visibility** — a human sees "this one's mine
  to drive" *before* anyone claims. (Today's `interactive` is only a
  dispatch-skip hint; this promotes it to a real lane.)
- **The claim-by-distinct-principal is the runtime interlock.** A supervised
  session claims the issue as its distinct bound agent identity; dispatch's
  existing "already claimed by someone else / open agent PR" guard now fires
  correctly and skips it. This is what finally closes the SYD-93 double-work race
  for real — the claim *means something* to dispatch because the principal is
  genuinely distinct.

`todo` keeps meaning **"queued for a headless worker."** Interactive work goes
`triage`/`backlog` → claim → `in_progress`, never touching `todo`, so
auto-dispatch never triggers. The flag alone is just a hint (insufficient — see
today); the claim alone works but gives no up-front board signal. Both together:
intent is visible, double-work is prevented.

### 5. Hard-gate affirmation: one click, backed by an OS presence prompt

A hard-gate only means something if the fresh affirmation comes through a channel
the **agent cannot forge**, and if it genuinely proves a human is *present at that
moment* (an interactive session runs for hours; the human can walk away). The
terminal cannot be that channel — Claude drives the terminal, so any in-terminal
gesture (a typed command, a keystroke) is something Claude can emit too. The
affordance and the security boundary are therefore separate concerns:

**Affordance — a click on a surface Claude can't drive.** A hard-gated action
does not commit; it lands as a **pending action** (event: `action_pending`) and
the tool call returns "awaiting human affirmation." The human approves via:

- **Primary:** a native desktop **notification / menu-bar Approve button** — a
  banner or tray item ("SYD-X → done. Approve?"), one click, minimal context
  switch, never leaves their current focus.
- **Fallback:** the **web board approval queue** — a button carrying the human's
  browser login cookie (which Claude has zero access to and cannot drive). Heavier
  context switch, but zero new infrastructure and a rock-solid boundary.

**Boundary — a Touch ID (biometric / OS presence) prompt.** The affirmation
credential is a keychain item gated by biometric unlock. Releasing a pending
action triggers a Touch ID prompt Claude cannot satisfy. Even if Claude fires the
same handler via `open syd://…` from its Bash tool, it just pops a fingerprint
prompt that sits unanswered. The presence check *is* the fingerprint — it no
longer relies on Claude being unable to read a secret file, but on Claude not
having the human's finger.

Net: for everything **not** on the hard-gate list, option A is frictionless. For
the gated few, the cost is **one click → one fingerprint touch**, no browser
switch required, and it degrades gracefully — if the human has walked away, gated
actions sit `pending` until they return; nothing irreversible commits unattended.

### 6. Credentials & branches follow the human, not the container

Unlike a dispatched worker (no GitHub creds, `agent/<ref>` branches only, egress
proxy), a supervised session runs on the human's own machine under the human's
git/GitHub credentials. It uses `feat/<topic>` branches like any interactive
work. The worker-container isolation model does **not** apply here — that
isolation exists precisely because dispatched workers are untrusted-and-unattended,
which a supervised session is not. The one credential that must stay **outside
Claude's reach even via its own tools** is the Touch-ID-gated affirmation keychain
item (pillar 5) — explicitly *not* the `.env` that holds Claude's MCP token.

## Data model changes (summary)

All additive:

- `sessions`: add `kind` (`"plain" | "supervised"`, default `"plain"`) and
  nullable `via_agent_id` → the bound agent.
- `events`: add nullable `via_agent_id` and `session_id`.
- New `pending_actions` table: `id`, `session_id`, `issue_id`, `action_type`,
  `payload`, `status` (`pending | affirmed | expired`), `created_at`,
  `affirmed_by` (human actor), `affirmed_at`. Backs pillar 5.
- Project config: a `supervised_hard_gate` list of action-types (pillar 3).
- `issues.worker_preference`: semantics widened to a positive lane
  (`interactive | dispatch | <engine>`); no column change.

## MCP / API surface changes

- `open_supervised_session(agent_identity) -> { session_token, session_id }` —
  the handshake (pillar 1).
- All claim-scoped writes accept the supervised-session token in place of a human
  token + hand-passed `lease_token`; the server dual-attributes automatically.
- Hard-gated actions return an `action_pending` result instead of success when the
  action-type is on the project's hard-gate list.
- `affirm_pending_action(pending_id)` — released **only** by a call carrying the
  human's Touch-ID-gated credential (native helper or web board), never the
  supervised-session token. Structurally un-self-releasable.

## Security model

- **Root of trust:** the human's login authenticates `open_supervised_session`.
- **Provenance:** every write is dual-attributed; the human is accountable, the
  agent is recorded as editor. The audit log can always answer "who authored this,
  under whom."
- **Presence guarantee (gated actions only):** a Touch ID prompt on a keychain
  item Claude cannot read *or* satisfy. Claude can tee up a gated action and tell
  the human exactly what to approve, but cannot approve it.
- **Dispatch isolation:** the distinct bound agent identity makes the claim a real
  interlock, closing the double-work race.
- **Non-goal:** defending against a *malicious human* — the human is trusted and
  present; the hard-gate defends against Claude running ahead and against the
  human having stepped away.

## Open questions / phasing

1. **Agent identity granularity:** one shared `claude-code` agent actor, or one
   per human? (Leaning: one shared `claude-code` actor; the human side carries the
   accountability.)
2. **Native helper scope:** the notification/tray + Touch-ID helper is real
   infrastructure. Phase 1 could ship pillars 1–4 + pillar 5's *web-board fallback*
   (already-secure, no new infra), and add the native click surface as a phase 2
   once the model is proven — "let's try it and see" how the flow feels first.
3. **Hard-gate defaults:** ship with an empty default list (pure option A), or
   pre-populate `done` for safety? (Leaning: empty; let projects opt in.)
4. **Session lifecycle:** supervised-session token expiry / renewal, and whether
   closing the Claude Code session should auto-close the supervised session.

## Suggested phasing

- **Phase 1 — the model:** pillars 1, 2, 4, 6 + pillar 3 with the hard-gate list
  and pillar 5's **web-board fallback** affirmation. This is the whole
  provenance/guardrail/dispatch-coexistence spine, shippable with no native infra.
- **Phase 2 — the smooth gate:** the native notification/tray Approve button and
  the Touch-ID-gated keychain release. This is the "try it and see if it feels
  smooth" slice — the riskiest UX assumption, deliberately isolated.
