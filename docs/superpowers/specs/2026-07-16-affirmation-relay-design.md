# Affirmation relay — supervised sessions phase 2

**Date:** 2026-07-16
**Status:** Approved (go/no-go answered on SYD-242)
**Topic:** Making the `done`-stamp require a hardware-verified human, not an authenticated click
**Supersedes:** the "native notification + Touch-ID keychain" sketch in
`2026-07-15-supervised-interactive-sessions-design.md` §Phase 2
**Research:** `docs/research/2026-07-15-biometric-step-up-prior-art-and-relay-design.md`

## Why we are building this — stated honestly

**This is a research spike. The motivation is the artifact, not the security yield.**
That framing is load-bearing and is recorded here so nobody later mistakes this for a
hardening project.

The security case was considered and **rejected**, on the strength of the research
doc's own §5 caveat: a supervised session runs on the human's machine with their full
git/GitHub credentials (design pillar 6). A compromised or prompt-injected session can
push code, open PRs, and reach `main`. Gating the `done`-stamp hardens a **bookkeeping
step while the code path stays ungated**. The blast radius this gate protects is small
relative to what it does not protect. As a security investment it is low-yield, and we
should not describe it as one.

The reason to build it is that **nobody has**. Research §2.1 found the ecosystem
genuinely empty — no Claude Code plugin, hook, or MCP server binds a biometric to an
agent's high-risk action — and the two upstream feature requests asking for exactly
this ([#38747](https://github.com/anthropics/claude-code/issues/38747),
[#58270](https://github.com/anthropics/claude-code/issues/58270)) are both closed as
not planned. `ssh-keygen -Y sign` makes the build cheap enough that the artifact value
clears the bar.

**Success criterion:** does this pattern work, and does the ceremony feel like a
meaningful beat rather than friction we rubber-stamp? Not "are we safer."

The research doc's own warning still binds: **cryptography cannot fix a human who
approves without reading.** The `syd affirm` renderer (§5) is what mitigates that, and
it deserves as much care as the crypto.

## Scope

**`done`-stamping. Only that.**

`dependency.remove` is explicitly **out**. SYD-246 established it is unreachable from a
supervised session — `removeDependency` is REST-only, and a `sup_` token resolves only
at `/mcp` — so gating it would be gating nothing.

This costs **zero throughput**, which is the npm test from research §7. Agents were
never permitted to stamp `done` (`src/services/issues.ts:323-327`, and CLAUDE.md states
it as a server-enforced rule). No automation needs a bypass, so no bypass gets built —
which is precisely where npm went wrong: 2FA-on-publish was real, then automation
tokens were added that skip the OTP, and the bypass became the default path for exactly
the publishes that most needed the gate.

We are not adding friction to agents. We are adding proof to humans.

## Settled questions

### (a) Threat framing — neither, and that is the point

Research §8 asks whether the threat is a *leaked human token* or a *human approving
carelessly*. Neither is the driver; the artifact is. Recorded so the spec is not read
as claiming a threat model it does not have.

### (b) Does `service` fit the step-up model? — exempt by construction

Not a decision. A fact, with two independent proofs:

1. A `service` actor **cannot open a supervised session** — `openSupervisedSession`
   requires `human.type === "human"` (`src/services/supervised-sessions.ts:24`), and
   `resolveSupervisedPrincipal` re-verifies it on every resolve (`:69`). The divert
   only fires when `attr.sessionId != null` (`src/services/issues.ts:287`), so a
   `service` actor never reaches the gate.
2. It is **fail-closed out of `updateIssue` wholesale** anyway
   (`src/services/issues.ts:328-332`).

No code, no config. SYD-213 does not block this.

### (c) Authenticator loss — redundancy, not a weaker path

**There is no break-glass.** A break-glass path weaker than the gate *is* the gate.

The recovery story is **enroll two or more keys** at setup (one on the keyring, one in
a drawer). Losing one is an inconvenience; it is not a lockout. This is what the FIDO
ecosystem actually recommends, and it is why `affirmation_keys` (§3) is a table rather
than a single column.

Lose *all* keys and you re-enroll via the admin CLI on the host. **This is not a
bypass, and the distinction matters:** anyone with write access to `switchyard.db`
could already `UPDATE issues SET status='done'` directly. Host access is below the
floor this gate ever claimed. The gate's boundary is "not the host owner" — consistent
with the design's existing non-goal of defending against a malicious human.

### (d) The web click when signatures are on — it must stop working

If the cookie-click still affirms, it **is** the break-glass rejected under (c), and
the signature is decoration on the happy path. So Phase 2 is **not purely additive**.

New setting **`supervised.affirm_requires_signature`** (boolean, default `false`):

| Setting | Web click (`POST /api/pending-actions/:id/affirm`) | Signed CLI |
|---|---|---|
| `false` (default) | works — Phase 1 untouched, zero regression | also works |
| `true` | **403 "a signed affirmation is required"** | the only path |

Default `false` means merging this changes nothing until deliberately switched on. The
spike is a flag flip.

## The model

### 1. The crypto inverts pillar 5 — the terminal becomes the best surface

The Phase 1 design ruled out the terminal, correctly at the time:

> The terminal cannot be that channel — Claude drives the terminal, so any in-terminal
> gesture (a typed command, a keystroke) is something Claude can emit too.

The cookie was the only thing Claude could not drive, which is why Phase 1 went to the
web board.

**A hardware signature dissolves that objection.** Claude may run `syd affirm SYD-42`
as often as it likes; it pops a PIN/fingerprint prompt on the key, and per research §3
an agent structurally *cannot* satisfy a user-verification ceremony — that is
WebAuthn's design, not a gap we are relying on. The presence check is no longer "Claude
cannot read a secret file"; it is "Claude does not have the human's finger."

So the terminal becomes both **lower friction** (no browser context switch) and a
**stronger boundary** than the cookie. That inversion is the spike's central finding.

### 2. Sign the canonical action document; verify by re-deriving it

Research §4.2 specifies `challenge = SHA-256(canonical(action))`. That framing is
inherited from WebAuthn, which requires a fixed-size challenge. **SSHSIG does not** —
`ssh-keygen -Y sign` accepts arbitrary bytes on stdin and hashes them itself.

**Decision: sign the canonical action document directly. The server verifies by
re-deriving those same bytes from the DB row it is about to execute.**

This is strictly better here, and it is a simplification, not a shortcut:

- **No `challenge` column** to store, drift, or forget to compare.
- **The binding is structural.** The only bytes that verify are the ones the server
  reconstructs from the row it will execute. A signature for SYD-42 cannot verify
  against SYD-43's row — replay protection falls out of the construction rather than
  being an extra check someone must remember.
- **It composes with Phase 1's dedup refresh.** If a re-proposal rewrites `payload`
  between sign and verify, `canonical(row)` changes, the signature stops verifying, and
  the human re-signs. Fail-safe, and consistent with the TOCTOU reasoning already
  documented at `src/services/issues.ts:306-310`.

The canonical document — deterministic key order, one version field for migration:

```json
{"v":1,"pendingActionId":17,"sessionId":4,"issueRef":"SYD-42","actionType":"done",
 "expectedHeadSha":"abc123…","expiresAt":1784180000}
```

Covers research §4.2's required pins: issue ref, transition, session id (which pins the
acting agent, since the session binds it), PR head SHA, expiry.

**Canonicalization rule:** `JSON.stringify` over a literal with keys written in the
order above is *not* sufficient — it is a convention a future edit can silently break.
Use an explicit sort: serialize `Object.keys(doc).sort()` with `JSON.stringify(doc, sortedKeys)`.
Absent optional fields (`expectedHeadSha`) are **omitted**, never `null` — one
representation per action, asserted by test.

**Namespace:** `-n switchyard-affirm`. Not decoration — it is what stops a signature we
solicit being replayable in another domain of use (e.g. a git commit signature).

### 3. The token enforces presence — NOT the verifier. (Corrected 2026-07-16.)

**An earlier draft of this section was wrong, and the error was load-bearing.** It
claimed `verify-required` is an ALLOWED SIGNERS option and that therefore
"the verifier can demand the UV bit, and we do not implement that check — OpenSSH does."
That is false. It came from research §4.4, which quoted the man page's **certificate
critical-option** `verify-required` and misattributed it to ALLOWED SIGNERS. The
fabricated attribution survived a 3-round `/debate:all` review and reached this spec and
its plan; it was caught only when a reviewer ran the actual binary and got
`allowed_signers:1: invalid key`.

**Ground truth (`man ssh-keygen`, OpenSSH_10.2p1, verified by reading and by running):**

- ALLOWED SIGNERS supports exactly **four** options: `cert-authority`, `namespaces=`,
  `valid-after=`, `valid-before=`. There is no `verify-required`. Options are
  **comma-separated** ("No spaces are permitted, except within double quotes").
- `verify-required` exists only as an `-O` flag in two other places: certificate signing,
  and **key generation** — "Indicate that this private key should require user
  verification for each signature."
- `ssh-keygen -Y verify` takes no user-verification flag at all. It checks: the signature
  is valid, the signer identity (`-I`) matches a principals pattern, the namespace (`-n`)
  matches, and optionally a revocation list (`-r`). **It cannot check the UV bit.**
- An `ed25519-sk` key requires a **touch** (user presence) for every signature by default;
  only `-O no-touch-required` at generation removes that.

**So the guarantee is enforced by the token at signing time, not by the server at verify
time.** Stated precisely:

| Property | Enforced by | Can the server verify it? |
|---|---|---|
| Touch / user presence | the FIDO token (default for sk keys) | **No** |
| PIN or fingerprint (UV) | the token, if the key was generated `-O verify-required` | **No** |
| Signature is valid, from a key enrolled to this human, in the `switchyard-affirm` namespace | `ssh-keygen -Y verify` | **Yes** |
| The key is hardware-backed | **enrollment** — we require an `sk-*@openssh.com` key type | **Yes** |

**What survives, and it is the part that matters.** The spike's behavioral claim is
untouched: Claude may run `syd affirm` all it likes and still cannot produce a signature,
because it cannot touch the key or enter the PIN. That is exactly what §1's inversion
rests on, and exactly what the manual run in Phase 2's plan actually tests.

**What we lost** is the ability to *prove* server-side that UV occurred. The server trusts
that an enrolled `sk-*` key was generated with `-O verify-required`. It can verify the key
is hardware-backed (the key type is in the public key itself); it cannot verify the token's
UV policy. A **malicious human** could enroll an sk key made without `-O verify-required`
and get touch-only — but defending against a malicious human is already an explicit
non-goal (§Security model, inherited from Phase 1): the human is trusted and present.

**Consequences for the build, all simplifications:**
1. `buildAllowedSigners` emits only `namespaces="switchyard-affirm"` — no options join, so
   the comma-vs-space trap disappears. It takes **no** `verifyRequired` parameter; that
   parameter existed solely to serve an option that does not exist.
2. Enrollment enforces the key type is `sk-ssh-ed25519@openssh.com` or
   `sk-ecdsa-sha2-nistp256@openssh.com` — the **real** wire spellings (`ssh -Q key`), not
   the `-t ed25519-sk` argument spelling that research §4.4's sketch used.
3. Tests get **better**, not worse: with no `verify-required` in the file, a software
   `ed25519` key verifies through the real production path. Tests insert an
   `affirmation_keys` row directly (bypassing enrollment's key-type check, which is tested
   separately) and exercise `ssh-keygen -Y verify` for real. **No production seam and no
   mocking** — which is what we wanted all along.

**Copy rule (unchanged, and now more important).** Never promise "fingerprint" or
"biometric" as guaranteed: per the man page, UV is satisfied "by PIN or on-token
biometrics" depending on hardware. Say "PIN or fingerprint, depending on your key." And
never claim the *server* verified it.

## Data model changes

All additive except the one noted.

- **New `affirmation_keys` table:** `id`, `actorId` → actors, `publicKey` (text, the
  `sk-ssh-ed25519@openssh.com AAAA…` line — the real wire spelling, see §3), `comment`
  (text, e.g. "keyring"), `createdAt`, `revokedAt` (nullable). A table because (c)'s
  recovery story is *multiple keys*, and revocation needs a column. Unique on
  `(actorId, publicKey)` among non-revoked rows.
- **`pending_actions`: add `expiresAt` (integer, not null).** Today there is **no
  expiry column**. `expiresAt` must be inside the signed bytes or it is unenforceable.
  TTL default **5 minutes** — research §4.5 says minutes, and an affirmation that
  outlives the human's attention is a bearer token with extra steps. This also gives
  SYD-245's sweep something to sweep.
  *Migration note:* not nullable, so existing rows need a backfill default. There are
  none in production (the feature is new), but the migration must still be written to
  survive a non-empty table — backfill `created_at + 300`.
  *Where it is enforced:* `affirmPendingAction` gains a row-expiry check **inside its
  transaction**, immediately after the existing session-expiry check
  (`src/services/hard-gate.ts:103-107`) and before the claiming UPDATE. It belongs in
  the executor, not the route, so **both** affirm paths (cookie and signed) are covered
  by one check — a route-level check would leave the cookie path unguarded whenever
  `affirm_requires_signature` is false. An expired row is set to `status='expired'` and
  throws; it is never executed.
- **New setting `supervised.affirm_requires_signature`** (boolean, default `false`) —
  see (d).
- **`EXECUTABLE_GATE_ACTIONS` stays `["done"]`** (`src/services/settings.ts:62`). No
  change.

## Blocker #1: "parked, here is a challenge" is not an error

`src/services/errors.ts` is, verbatim and in its entirety:

```ts
export class SwitchyardError extends Error {}
```

No code, no status, no metadata. `guard()` (`src/mcp/server.ts:39-50`) flattens it to
`{ isError: true, text: err.message }`. Phase 1 therefore ships the divert as a
`SwitchyardError` throw with the pending id **interpolated into the message string**
(`src/services/issues.ts:315-317`) — reviewed and approved for Phase 1, with the
LLM-retry failure mode mitigated by the dedup upsert.

That will not carry a canonical document. **Parked is a success, not a failure**, and
must not look like one to a caller.

**Decision: a sibling signal type, not a `SwitchyardError` subclass and not a return-type union.**

```ts
// src/services/errors.ts
export class PendingAffirmation extends Error {
  constructor(readonly pending: PendingAffirmationView) {
    super(`Awaiting human affirmation (pending action #${pending.pendingActionId}).`);
  }
}
```

Two translations, exactly as research §6 names:

- `guard()` catches `PendingAffirmation` **before** `SwitchyardError` and returns
  `ok(err.pending)` — a **success** result carrying the canonical doc and instructions.
  **This is the only live translation**, and the only one with a behavioral test.
- REST `app.onError` maps it to **202 Accepted** with the same body. Not a 4xx: nothing
  went wrong. **This arm is unreachable today, by construction, and is kept as a
  tripwire rather than as live behavior** — see below.

**Why the REST arm is unreachable (corrected during implementation).** An earlier draft
of this spec implied a supervised session could park an action over REST. It cannot, and
the same fact is what lets §Scope drop `dependency.remove`:

- `PendingAffirmation` is thrown only by `updateIssue`'s divert, which requires
  `attr.sessionId`.
- Only a supervised principal carries `attr`, and a `sup_` token resolves **only** at
  `/mcp` — `resolveSupervisedPrincipal` has exactly one caller (`src/server.ts:77`).
  REST's auth middleware only tries `authenticate()` (which reads `actors.tokenHash`,
  where a `sup_` hash never lives) or a plain session cookie (`getSessionActor` filters
  `kind='plain'`).
- Independently, `PATCH /issues/:ref` (`src/rest/api-routes.ts:262-265`) passes no `attr`
  to `updateIssue` at all.

So the arm is kept because `PendingAffirmation extends Error`: if REST ever gains
supervised attribution, its absence turns a parked action into a 500 with a stack trace
instead of a 202. One line now prevents a confusing failure later. It is deliberately
**not** tested — there is no honest way to exercise it through the real auth path, and a
test that faked reachability would be worse than no test.

**Why not the alternatives** (recorded so this is not relitigated):

- *Adding `code`/`data` to `SwitchyardError`* — smaller diff, but overloads one class to
  mean both "you did something wrong" and "this is fine, wait." The semantic collision
  is the thing worth avoiding.
- *A `IssueView | PendingAffirmation` return union* — more honest types, and the
  compiler would find every caller. Rejected as disproportionate for a spike: it ripples
  through every `updateIssue` caller, and the pending arm is **unreachable** for most of
  them (`affirmPendingAction` re-drives `updateIssue` with `attr = {}`, which cannot
  divert), producing exactly the "can't happen" branches that rot. Revisit if the gate
  ever covers more actions.

**Risk, stated:** `PendingAffirmation extends Error` propagates as a real 500 through
any `catch (e) { if (e instanceof SwitchyardError) … else throw }`. The two translations
above are therefore not optional, and a test asserts each.

## Verification

```ts
// src/services/affirmation-keys.ts
// No `verifyRequired` param — see §3. ALLOWED SIGNERS has no such option.
export function buildAllowedSigners(keys: AffirmationKeyRow[], principal: string): string;

// src/services/ssh-verify.ts
export function verifySshSig(args: {
  message: string;          // canonical(row) — the bytes we re-derived
  armoredSignature: string; // the SSHSIG blob
  allowedSigners: string;
  principal: string;        // the human actor's name
}): boolean;
```

`verifySshSig` writes `allowed_signers` and the signature to a scratch dir, spawns:

```
ssh-keygen -Y verify -f <allowed_signers> -I <principal> -n switchyard-affirm -s <sig>
```

feeding `message` on stdin; exit 0 is the only success. Scratch files are removed in a
`finally`. No custom crypto anywhere in this path — that is the entire point.

An `allowed_signers` line, production shape (corrected — see §3):

```
sean namespaces="switchyard-affirm" sk-ssh-ed25519@openssh.com AAAA...
```

Note both corrections: no `verify-required` (it is not an ALLOWED SIGNERS option), and the
key type is the real wire spelling `sk-ssh-ed25519@openssh.com` — what actually appears in
a `.pub` file — not `ssh-ed25519-sk`, which is only the `ssh-keygen -t` argument.

**Deployment prerequisite:** `Dockerfile:2` is `FROM node:24-slim` with **no**
`apt-get install` line, so `openssh-client` — and therefore `ssh-keygen` — **is not in
the deployed tracker image**. Phase 2 adds it. Without this the verifier does not exist
in production. The worker images already install their own packages and are unaffected;
this is the tracker image only.

## Surfaces

### `syd affirm` (new)

A **client** CLI, distinct in shape from the existing admin CLI (`src/cli.ts`, whose
first arg is a db path). This one talks HTTP to the server, because the human is on
their Mac and the tracker is on the NAS.

```
SWITCHYARD_URL=... SWITCHYARD_TOKEN=syd_... npx tsx src/affirm-cli.ts affirm SYD-42
```

1. `GET /api/pending-actions?status=pending`, find the row for that ref.
2. **Render the action in full** — ref, current → target status, head SHA, which agent
   proposed it, which session, time remaining. This is the mitigation for "a human who
   approves without reading," and per research §4.2 the display is trusted *at this
   renderer*, not attested by the token. It carries real weight; treat it as such.
3. Pipe `canonical(action)` to `ssh-keygen -Y sign -f <key> -n switchyard-affirm -`.
   The key prompts for PIN/touch.
4. `POST /api/pending-actions/:id/affirm-signed` with the SSHSIG blob.

**The human's `syd_` bearer is used for transport only.** Holding it is no longer
sufficient to affirm — the signature is the authorization — so the token proves "who is
asking," not "who approved." No new credential is needed, and this is a genuine
strengthening over Phase 1, where the bearer's holder could do everything.

### REST

- `POST /api/pending-actions/:id/affirm-signed` — body `{ signature }`. Resolves the
  actor from the **Bearer** (not the cookie: this is a CLI caller). Re-derives
  `canonical(row)`, verifies, then calls the **existing** `affirmPendingAction`
  executor unchanged.
- `POST /api/pending-actions/:id/affirm` (Phase 1, cookie-only) — **403** when
  `supervised.affirm_requires_signature` is true.
- `GET /api/pending-actions` — must now return enough to render and to canonicalize
  (issue ref, expiry, proposing agent). SYD-244 already asks for the ref; this
  subsumes it.
  **This forces SYD-243, so Phase 2 absorbs it.** That route is currently readable by
  *any* authed actor — including a plain agent bearer — and Phase 2 *widens* what it
  returns (session, proposing agent, expiry). Shipping the wider response without the
  fix would hand every agent token a richer cross-session view than it has today. So
  Phase 2 scopes the route to humans, and to the requesting human's own sessions. The
  `syd affirm` CLI is unaffected: it authenticates with the human's own bearer.

### Web

The approval panel's Approve button hides (or disables with an explanation) when
`supervised.affirm_requires_signature` is true. It must not offer a button that 403s.

## Data flow, end to end

```
supervised session:  update_issue(SYD-42, status=done)
  └─► updateIssue diverts (issues.ts:287-318) ─► pending_actions row (+ expiresAt)
       └─► throws PendingAffirmation ─► guard() ─► SUCCESS result w/ canonical doc

human's terminal:  syd affirm SYD-42
  └─► GET pending action, RENDER in full
  └─► ssh-keygen -Y sign -n switchyard-affirm   ◄── PIN / fingerprint. Claude cannot.
  └─► POST /api/pending-actions/17/affirm-signed

server:
  └─► re-derive canonical(row) from the DB
  └─► buildAllowedSigners(keys of this human)
  └─► ssh-keygen -Y verify   ◄── valid sig? enrolled key? right namespace?
                                 (it does NOT — cannot — check the UV bit; §3)
  └─► verified ─► affirmPendingAction(db, human, id)  [Phase 1 executor, unchanged]
       └─► recordEvent(actorId=human, viaAgentId=agent, sessionId, payload={sig ref})
```

Note the executor is reached **only** after verification, and it re-validates every
guard against current state (including the SYD-208 head pin), exactly as it does today.

## Error handling

| Case | Result |
|---|---|
| Gated action proposed | `PendingAffirmation` → MCP success / REST 202, with canonical doc |
| Signature does not verify | 400, "signature does not match this action — re-run `syd affirm`" |
| Signature valid, row expired | 400, row marked `expired`; human re-proposes |
| Signature valid, wrong human | 403 — existing owner tie (`hard-gate.ts:98-102`) unchanged |
| Signature valid, payload refreshed since signing | verify fails naturally (§2) → 400 |
| Cookie click while signatures required | 403 |
| No enrolled keys for this human | 400, "no affirmation keys enrolled" |
| `ssh-keygen` missing on the server | **500** — a real misconfiguration, must be loud, never a soft-allow |

That last row is the npm lesson applied at the code level: a verifier that fails open
is worse than no verifier.

## Testing

The hard constraint: **`ssh-keygen -Y sign` against an `ed25519-sk` key needs physical
hardware**, so CI cannot produce a signature from a real security key. Per §3's
correction this is now *less* limiting than first thought — because `allowed_signers`
carries no `verify-required`, a software `ed25519` key verifies through the **real
production path**, so CI exercises actual crypto rather than a mock.

- **Canonicalization** — determinism under key reordering; optional fields omitted not
  `null`; unicode stability; extra properties on the input must not reach the output.
  Pure function, no hardware.
- **`verifySshSig` plumbing (real crypto, no mocks)** — a **software** `ed25519` key
  generated in-test. Tests insert an `affirmation_keys` row **directly**, bypassing
  `enrollAffirmationKey`'s hardware-key-type check (which is tested separately), then
  call the production `buildAllowedSigners` and shell out to a real `ssh-keygen -Y
  verify`. Covers verify, namespace enforcement, principal mismatch, and — the important
  one — **replay rejection**: a signature over SYD-42's doc must fail against SYD-43's
  row.
- **`buildAllowedSigners`** — asserts the emitted line parses as valid OpenSSH. A
  substring assertion is not enough: the earlier draft's `toContain("verify-required")`
  test passed against a line real `ssh-keygen` rejects outright. **At least one test must
  round-trip through the actual binary.**
- **`enrollAffirmationKey` key-type check** — accepts the real wire spellings
  (`sk-ssh-ed25519@openssh.com`, `sk-ecdsa-sha2-nistp256@openssh.com`); rejects software
  keys and junk. This is the only server-side hardware guarantee, so it carries weight.
- **Not testable, and stated plainly rather than papered over:** that the token demanded a
  touch or a PIN. The server never sees it (§3). The only evidence is the manual run.
- **`PendingAffirmation` translation** — one test that `guard()` returns a **success**
  (not `isError`), one that REST returns **202**. Both are load-bearing per the risk
  noted in Blocker #1.
- **Setting behavior** — cookie click 403s when required; works when not.
- **Manual, on the spike's own terms:** a real FIDO key, end to end, on Sean's machine.
  This is the actual deliverable — the point is to learn whether the ceremony feels
  like a meaningful beat. Record the finding.

## Risks

1. **`ssh-keygen` in the container** — verified absent today. Mitigated by the
   Dockerfile change; the 500-on-missing rule ensures it fails loudly, not open.
2. **The server cannot verify that UV occurred** (§3) — the token enforces presence at
   signing time; `-Y verify` cannot check it. The server's guarantee is "a valid
   signature from a key enrolled to this human, in this namespace," plus a hardware
   key-type check at enrollment. Do not describe this as proving a fingerprint was given.
6. **A fabricated man-page citation reached an approved spec.** Research §4.4's
   `verify-required` quote was real text from the man page's *certificate* section,
   misattributed to ALLOWED SIGNERS — plausible enough to survive a 3-round review, and
   fatal because the whole "no RP to get wrong" argument rested on it. It died only when a
   reviewer ran the binary. **Lesson for the write-up: for any claim that a tool enforces
   something, run the tool.** Reading the man page was not enough; the wrong section reads
   perfectly.
3. **`PendingAffirmation` escaping as a 500** through an unconverted catch site — two
   tests pin the two translations.
4. **The renderer is trusted** (§4.2) — the authenticator UI shows only the RP; our CLI
   renders the action. Stated plainly rather than glossed. It is acceptable because the
   human's terminal is not agent-controlled *at the moment of the ceremony* — the key
   is, and the finger is not.
5. **This hardens bookkeeping, not the pipeline** (§5 caveat) — the reason this is
   scoped as a spike and not sold as security.

## Out of scope

- WebAuthn / passkeys (research §4.3) — revisit only if a phone flow justifies owning a
  relying-party implementation.
- Push notification transport (VAPID, ntfy). The human runs `syd affirm` when ready;
  Phase 1's board panel remains the queue view.
- `dependency.remove` (SYD-246) and any other gated action.
- Per-project hard-gate lists — still install-global.
- AP2 Cart Mandate shaping (research §8 rec 5) — noted as cheap future insurance; the
  canonical doc is already structurally a signed statement of what was approved.
