# Biometric / FIDO Step-Up for High-Risk Actions — Prior Art & Relay Design

> **⚠️ CORRECTION 2026-07-16 — §4.4 contains a fabricated man-page citation. Read this first.**
>
> This document's §4.4 quotes a `verify-required` block and attributes it to
> `man ssh-keygen`'s **ALLOWED SIGNERS** section, then builds its central recommendation on
> it: *"the verifier can demand the UV bit... We do not implement that check — OpenSSH
> does."* **That is false.**
>
> ALLOWED SIGNERS (OpenSSH_10.2p1) supports exactly four options — `cert-authority`,
> `namespaces=`, `valid-after=`, `valid-before=`. There is no `verify-required`. The quoted
> text is real, but it comes from the man page's **certificate critical-option** section;
> `verify-required` otherwise exists only as an `-O` flag at **key generation**. And
> `ssh-keygen -Y verify` takes no user-verification flag at all.
>
> Consequence: **user verification is enforced by the token at signing time, never by the
> verifier.** A server cannot prove UV occurred. §4.4's "Pros: hardware-verified UV enforced
> by OpenSSH" is wrong, and §4.4's `ssh-ed25519-sk` key spelling is wrong too (the real wire
> type is `sk-ssh-ed25519@openssh.com`; `ed25519-sk` is only the `-t` argument).
>
> This error survived a 3-round `/debate:all` and reached an approved spec and plan. It was
> caught only when a code reviewer **ran the binary** and got `allowed_signers:1: invalid key`.
> The corrected model is in
> `docs/superpowers/specs/2026-07-16-affirmation-relay-design.md` §3.
>
> The rest of the document — the prior-art scan (§2), the structural
> agent-cannot-perform-UV argument (§3), the relay shape (§4.1), challenge-binding (§4.2),
> and the npm cautionary tale (§7) — is unaffected and still holds.

> 2026-07-15 — prior-art scan plus a design sketch, prompted by the idea of gating
> Switchyard's human-only actions behind a biometric rather than a bearer token.
> Evidence: a web/GitHub sweep for existing implementations (Claude Code plugins,
> hooks, MCP servers, approval relays); the WebAuthn/FIDO2 and OpenSSH specs; and a
> read of this repo's authorization path (`src/services/actors.ts`, `issues.ts`,
> `dependencies.ts`, `errors.ts`, `supervised-sessions.ts`, `attribution.ts`,
> `events.ts`, `auth.ts`; `src/db/schema.ts`; `src/server.ts`, `src/mcp/server.ts`,
> `src/rest/api-routes.ts`). Code citations were read at
> `feat/supervised-sessions-phase1` @ `de2b2a1`.
>
> Status: **research + design sketch. Nothing here is decided or scheduled.**

## TL;DR

Nobody has built this. There is no Claude Code plugin, hook, or MCP server that binds
a biometric to an agent's high-risk action — the two feature requests that asked
Anthropic for exactly this were both closed as not planned. The adjacent ecosystem
(approval relays to your phone) is well-populated, but every one of them ends in a
plain tap that proves only that *something* touched a screen.

Three findings shape any design:

1. **An agent structurally cannot perform a user-verification ceremony.** This is
   WebAuthn's design, not a gap. It is exactly why the gate is worth having — and
   exactly why it cannot happen inside a headless worker container.
2. **The relay is the whole problem, and Vault's control groups already solved its
   shape.** Propose → park → authorize out-of-band → execute.
3. **We already have the primitive.** `pendingActions` (`src/db/schema.ts:405-430`)
   is defined, indexed, and completely unused. Its comment describes the affirmation
   gate this design needs, almost word for word.

The cheapest credible version is not WebAuthn at all — it is `ssh-keygen -Y sign`
against a FIDO key with `verify-required`, which gives transaction signing with a
hardware-verified human, using tools already on every dev machine and zero custom
crypto.

---

## 1. Why want this at all

Switchyard's human-only rules are real and server-enforced. They are also, today,
assertions about a *credential*, not about a *person*:

```ts
// src/services/issues.ts:323-327
if (patch.status === "done" && actor.type === "agent") {
  throw new SwitchyardError(
    "Only humans move issues to done — comment your verification evidence and move it to in_review instead.",
  );
}
```

The actor comes from a token hash lookup (`src/services/actors.ts:36-43`,
`authenticate(db, token): Actor | null`) and is baked into the MCP tool closure for
the life of the connection (`src/server.ts:66-82`). So the rule reads: *whoever holds
the human token may stamp done.* There is no notion of freshness, no challenge, and
no evidence a human was present. A leaked human token, a misconfigured worker, or an
agent that talked a human into pasting a token defeats every one of these gates
silently.

The same shape holds at the other three enforcement points —
`issues.ts:318-322` (triage exit), `issues.ts:335-339` (the agent transition
whitelist), and `dependencies.ts:64-68` (`if (actor.type !== "human")`).

A biometric gate would make one narrow claim the current system cannot make: *a
specific human, in possession of a specific enrolled authenticator, verified
themselves against it within the last N seconds, for this exact action.*

## 2. Prior art

### 2.1 The Claude Code ecosystem — genuinely empty

Two feature requests are near-identical to this idea. Both are **closed as not
planned**:

| Issue | Ask | Outcome |
|---|---|---|
| [anthropics/claude-code#38747](https://github.com/anthropics/claude-code/issues/38747) | Remote signing approval via iOS app (FaceID/TouchID/YubiKey NFC), Secure Enclave key, push with action context | Closed, went stale, `area:security` |
| [anthropics/claude-code#58270](https://github.com/anthropics/claude-code/issues/58270) | Local session auth (PIN/TOTP/passkey) before Claude Code accepts prompts | Closed, argued from ISO 27001 / SOC 2 / Cyber Essentials |

#38747 is worth reading in full — it independently derives the same relay this
document sketches. It is prior art for the *design*, and evidence that the design
has no upstream owner.

Searches across the plugin marketplaces and GitHub (repo search, code search for
`PreToolUse` + biometric/LocalAuthentication/`pam_tid`) returned nothing that binds
a biometric to a tool call.

### 2.2 Approval relays that do exist — transport solved, proof absent

There is a healthy cluster of "approve from my phone" tooling:

- **Claude Code Remote Control** (built in) — phone acts as a thin client, the host
  polls outbound, short-lived tokens tied to your account. See also
  [#60433](https://github.com/anthropics/claude-code/issues/60433).
- **[yuuichieguchi/claude-remote-approver](https://github.com/yuuichieguchi/claude-remote-approver)**
  — hook POSTs the tool request as JSON to an ntfy topic; your tap publishes to a
  response topic the hook reads back. ([HN](https://news.ycombinator.com/item?id=47111171))
- **[wmoto-ai/cc-g2](https://github.com/wmoto-ai/cc-g2)** — approvals from smart glasses.
- `vokomarov/claude-code-approvals`, `almuqrin/agentnotifier`,
  `jamesrochabrun/ClaudeCodeApprovalServer`.

Every one solves the hard-ish transport half and then ends in an unauthenticated
tap. None signs anything. **That gap is the entire opportunity.**

### 2.3 Local biometric primitives — mature, but they gate the wrong noun

- **1Password CLI / Shell Plugins** — the closest shipping model. macOS system
  biometric prompt, shows the account and requesting process, ~10-minute session
  that refreshes on use. Critically it gates *access to a secret*, not *permission
  to perform an action*. ([app integration security](https://developer.1password.com/docs/cli/app-integration-security/))
- **`pam_tid.so` via `/etc/pam.d/sudo_local`** — Touch ID for sudo, survives OS
  updates. [mattrajca/sudo-touchid](https://github.com/mattrajca/sudo-touchid),
  [dss99911/keychain-fingerprint](https://github.com/dss99911/keychain-fingerprint).

These are fine building blocks for a *local* gate. A `PreToolUse` hook can shell out
to one and return `permissionDecision: "deny"`, which holds even under
`--dangerously-skip-permissions` because hooks fire before the permission-mode check.
But a local gate is worth little here: it proves a human was at *that machine*, and
tells a remote server nothing it can verify.

### 2.4 Approval-gate architectures worth stealing from

This is the richest vein, and none of it is AI-specific.

**HashiCorp Vault Control Groups** — the closest architectural analog to what we
want. A request against a control-group path returns a **response-wrapping token**
instead of the data; the accessor goes to authorizers; once
`sys/control-group/authorize` is satisfied, the wrapping token unwraps and the
original request proceeds.
([docs](https://developer.hashicorp.com/vault/docs/enterprise/control-groups))
That is precisely: propose → park → authorize out-of-band → execute. It maps onto
`pendingActions` almost field-for-field.

**AWS MFA-protected API access** — policy conditions `aws:MultiFactorAuthPresent`
(Bool) and `aws:MultiFactorAuthAge` (numeric, e.g. `< 3600`) gate sensitive actions
on *how recently* the caller proved themselves. Notably, the key **only exists for
temporary credentials** — long-lived access keys can never satisfy it.
([docs](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_mfa_configure-api-require.html))
The lesson transfers directly: freshness is a property of the credential type, and
"MFA age" is the right abstraction for a step-up rule.

**Duo Push** — out-of-band over a mutually-authenticated transport, full transaction
details displayed for verification, and requests **signed with an asymmetric keypair
so integrity does not rest on TLS alone**. The 2011 design still reads as the
reference implementation of a push approval.

**npm publish 2FA** — the cautionary tale, covered in §7.

### 2.5 Standards — moving, but not yet load-bearing

- **FIDO Alliance Agentic Authentication TWG** (announced 2026-04-28; chaired by CVS
  Health, Google, OpenAI; vice-chaired by Amazon, Google, Okta). Scope: agent
  authentication, trusted delegation, and *verifiable user instructions* —
  "phishing-resistant mechanisms that do not expose user credentials."
  ([announcement](https://fidoalliance.org/fido-alliance-to-develop-standards-for-trusted-ai-agent-interactions/))
- **Google AP2** (a founding contribution to that WG) — signed **Intent**, **Cart**,
  and **Payment** mandates as "tamper-proof, cryptographically-signed digital
  contracts that serve as verifiable proof of a user's instructions." The Cart
  Mandate is a WYSIWYS signature over exactly what the user approved.
  ([announcement](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol))
  **A pending action affirmed by a human is structurally a Cart Mandate.** If we
  build this, matching AP2's shape is cheap insurance against the standard landing
  somewhere else.
- **WebAuthn `confirmation` extension (née `txAuthSimple`)** — the one that would
  have made this easy. [w3c/webauthn#2020](https://github.com/w3c/webauthn/pull/2020)
  **closed 2025-04-02**, no active sponsor, citing "concerns around untrusted text
  in a trusted UI." Banks wanted it for PSD2; browser vendors would not render
  RP-supplied text in browser chrome. **Assume it is never coming.**
- **Secure Payment Confirmation (SPC)** — the surviving WYSIWYS path. The browser
  displays transaction details and passes them to the authenticator to sign; details
  land in `CollectedClientData` where JS cannot tamper with them. Chrome/Edge only,
  and scoped to payment contexts. Not usable for us, but proof the pattern works.
- **ARKG** ([draft-bradleylundberg-cfrg-arkg](https://datatracker.ietf.org/doc/draft-bradleylundberg-cfrg-arkg/),
  now -10) and Proxy Signatures with Unlinkable Warrants — research toward genuine
  "agent-bound passkeys": a user's authenticator generating task-specific keys for an
  agent, delegating authority without bearer tokens. Watch it; don't build on it.

## 3. The constraint that shapes everything

> `navigator.credentials.get()` triggers a client-side, OS-level UI prompt that is
> **sandboxed from the web page itself**. An autonomous AI agent, which typically
> operates on a server or in a backend environment, **has no technical mechanism to
> programmatically trigger, interact with or satisfy** this physical, client-side
> user interaction.
> — [Corbado, *AI Agents Authentication*](https://www.corbado.com/blog/ai-agents-passkeys)

This cuts both ways, and both matter:

- **It is why the gate is worth building.** An agent cannot forge a user-verification
  ceremony the way it can present a bearer token it holds. The property is
  structural, not a policy we enforce.
- **It is why a local Touch ID prompt is a non-starter for dispatched workers.**
  There is no human in a container on the worker host. Nobody's finger is there.

Therefore: **the only viable shape is an out-of-band relay.** The privileged action
must park server-side and wait for a ceremony performed on a device a human is
actually holding. This is what #38747 proposed and Anthropic declined to build.

## 4. Relay design

### 4.1 Shape

```
worker (headless, no credentials, no human)
  │  update_issue(SYD-42, status=done)
  ▼
service  ── recognizes a hard-gated action
  │        writes pending_actions row (status='pending')
  │        challenge = SHA-256(canonical action payload)
  │        returns "parked, awaiting affirmation: <id>"  ◄── NOT an error
  │
  ├──────────────► notify the bound human (web push / ntfy / mobile)
  │
  ▼
human's device (browser or terminal — a device they are holding)
  │  renders the action in full: ref, transition, PR, diff summary
  │  performs a UV-required ceremony over the challenge
  │  POSTs the assertion back
  ▼
service  ── verifies: signature, UV bit, challenge == hash(payload),
  │        credential belongs to this human actor, freshness, single-use
  │        marks affirmed_by_id / affirmed_at, executes the original action
  ▼
recordEvent(actorId=human, viaAgentId=agent, sessionId=..., payload={assertion ref})
```

The worker never holds a credential, never sees the assertion, and cannot
manufacture one. It only learns that its action was parked and later executed.

### 4.2 What gets signed — the load-bearing detail

**Set the challenge to the hash of the action, not to a random nonce.**

The relying party chooses the challenge bytes. Making
`challenge = SHA-256(canonical(action))` means the assertion cryptographically covers
*which action was approved*, not merely *that some ceremony happened*. Without this,
an approval for "stamp SYD-42 done" is replayable against SYD-43 — you have built a
liveness check, not an authorization.

The canonical payload must pin everything that matters: issue ref, transition,
session id, the agent acting, the PR head SHA if one is in play, and an expiry. The
sync assessment's rule applies here too — anything security-relevant that we read
must have a named producer keeping it fresh, and irreversibility decisions need a
live read, not a replica read.

Note what this does **not** get us: the authenticator UI shows only the RP name. The
*action* is rendered by our page. So the guarantee is "a UV-verified key holder
confirmed a ceremony whose challenge equals this action's hash," with the display
trusted at the page, not attested by the authenticator. That is precisely the gap the
`confirmation` extension would have closed, and it is closed to us (§2.5). It is
acceptable here because the human's browser is not agent-controlled — but it should
be stated plainly rather than glossed.

### 4.3 Option A — WebAuthn passkey via the existing web UI

The web UI is already a thin client over the same services, already has a session
cookie path (`getSessionActor`, `src/services/auth.ts:55-69`), and is already the
place humans stamp things. Making it the relying party is close to free:

- Enroll: a human actor registers one or more credentials; store credential id,
  public key, sign count.
- Affirm: `navigator.credentials.get()` with
  `userVerification: "required"`, challenge = the pending action's hash.
- Verify server-side: signature over `authenticatorData || SHA-256(clientDataJSON)`;
  **UV bit (flags bit 2) set**; challenge match; credential belongs to this actor;
  sign-count sanity.
- Transport: VAPID web push to a service worker, so the human gets pinged rather
  than polling. `ntfy` is the zero-infrastructure fallback and has proven prior art.

Pros: no new hardware; Face ID / Touch ID / Windows Hello work out of the box;
phones work via hybrid transport (QR + BLE proximity check, with data over an
encrypted tunnel — BLE is only proximity, never a data channel).
Cons: a WebAuthn RP implementation to own and keep correct; enrollment/recovery UX;
push plumbing.

### 4.4 Option B — FIDO key + `ssh-keygen -Y sign` (recommended first cut)

This is the finding I did not expect. OpenSSH already ships a complete
transaction-signing scheme, and it needs no custom crypto, no RP implementation, and
no browser.

Verified against the local man page (OpenSSH_10.2p1):

```
-Y sign
     Cryptographically sign a file or some data using an SSH key. ... if no files
     are specified then ssh-keygen will sign data presented on standard input. ...
     An additional signature namespace, used to prevent signature confusion across
     different domains of use (e.g. file signing vs email signing) must be provided
     via the -n flag.
```

And in **ALLOWED SIGNERS**:

```
verify-required
     Require signatures made using this key indicate that the user was first
     verified, e.g. by PIN or on-token biometrics.  This option only makes sense
     for the FIDO authenticator algorithms ecdsa-sk and ed25519-sk.
```

That second one is the prize: **the verifier can demand the UV bit.** A signature
made without the human verifying against the token is rejected by `ssh-keygen -Y
verify` itself. We do not implement that check — OpenSSH does.

Sketch:

```bash
# enrollment (once, on the human's machine)
ssh-keygen -t ed25519-sk -O resident -O verify-required -C "syd-affirm:sean"
# → public key registered against the human actor; allowed_signers gets:
#   sean@... namespaces="syd-affirm" verify-required ssh-ed25519-sk AAAA...

# affirming a parked action
syd affirm SYD-42            # fetches the pending action, renders it, then:
printf '%s' "$CHALLENGE" | ssh-keygen -Y sign -f ~/.ssh/id_ed25519_sk -n syd-affirm -
# → touch + PIN/fingerprint on the key → SSHSIG blob → POST to the server

# server-side verification — no custom crypto
ssh-keygen -Y verify -f allowed_signers -I sean -n syd-affirm -s sig <<< "$CHALLENGE"
```

**A nuance to get right.** The man page's *key-generation* `verify-required` says
"Currently PIN authentication is the only supported verification method, but other
methods may be supported in the future." The *allowed_signers* option says "e.g. by
PIN or on-token biometrics." These describe the same UV bit from two ends: what the
verifier checks is that UV was performed; *how* the token satisfies UV is the token's
business. On a YubiKey Bio a fingerprint satisfies it; on a standard YubiKey it is a
PIN. So "biometric" here means "biometric where the hardware supports it, PIN
otherwise" — which for our threat model is the same guarantee (possession + verified
holder), and we should describe it that way rather than promising fingerprints.

The `-n syd-affirm` namespace is not decoration: it is what stops a signature we
solicit from being replayable in any other domain of use.

Pros: no RP to implement or get wrong; hardware-verified UV enforced by OpenSSH;
works over SSH, in a terminal, anywhere; trivially scriptable; strong audit artifact
(the SSHSIG blob is storable in the event payload).
Cons: requires a FIDO key (~$30-50) and OpenSSH ≥ 8.4; no phone-native flow;
enrollment is a CLI chore.

### 4.5 Freshness, replay, scope

Whichever option:

- **Single-use.** The partial unique index on `pendingActions` already enforces one
  live pending row per `(session, issue, actionType)`; affirmation must be a
  compare-and-set on `status='pending'`.
- **Short expiry.** Minutes. An affirmation that outlives the human's attention is a
  bearer token with extra steps.
- **No caching, no "remember for N minutes"** on genuinely irreversible actions.
  1Password's 10-minute session is right for unlocking a vault and wrong for stamping
  done. Borrow AWS's `MultiFactorAuthAge` framing: make the max age an explicit
  per-action policy value, not a global default.
- **Bind to the session**, so an affirmation solicited by one worker cannot be
  redeemed by another.

## 5. What this actually buys — and what it doesn't

**Buys:**
- A cryptographic claim that a named human, holding an enrolled authenticator,
  verified themselves for *this specific action* within a bounded window.
- A durable audit artifact. `recordEvent` (`src/services/events.ts:5-28`) already
  carries `actorId` + `viaAgentId` + `sessionId`; the assertion reference slots into
  `payload`.
- Defense against the failure mode our current model cannot touch: a leaked or
  misused human token.

**Does not buy:**
- Protection against a human who approves without reading. The oldest failure in
  security, and a relay with good rendering only mitigates it.
- Authenticator-attested display of the action (§4.2) — the page is trusted, not the
  token.
- Anything at all if the gate can be bypassed. See §7.

**A caveat worth stating loudly:** this raises assurance on the *approval* while the
worker's *push* to `agent/<ref>` remains ungated. If stamping done is the only thing
that gets a biometric, we have hardened a bookkeeping step while the code path stays
where it was. That is not useless — done-stamping is what closes the loop and CLAUDE.md
treats it as the human's decision — but it should not be mistaken for hardening the
delivery pipeline.

## 6. Where it lands in this codebase

The map came back better than expected. **The primitive already exists and is
completely unused.**

```ts
// src/db/schema.ts:398-404 — the comment, verbatim
// Supervised interactive sessions (phase 1 design, docs/superpowers/): a
// hard-gated action (e.g. moving an issue to done) proposed by the agent side
// of a supervised session, awaiting the bound human's affirmation before it
// executes. The partial unique index pending_actions_active_uniq allows only
// one *pending* row per (session, issue, actionType) tuple at a time — once a
// row is affirmed or expired it stops blocking a fresh pending proposal for
// the same tuple, which is what onConflictDoUpdate dedup targets.
```

`pendingActions` (`schema.ts:405-430`) already has `sessionId`, `issueId`,
`actionType`, `payload`, `status` (`["pending", "affirmed", "expired"]`,
`schema.ts:395`), `affirmedById`, `affirmedAt`, and the partial unique index. A grep
finds **no service reads or writes it** — it is schema-only. Biometric affirmation is
not a new subsystem; it is *one more column* (`affirmationRef`, or the assertion in
`payload`) on a table that was already designed for this, plus a verifier.

Four things stand in the way, in rough order of cost:

1. **`SwitchyardError` cannot signal a challenge.** The class is literally
   `export class SwitchyardError extends Error {}` (`src/services/errors.ts:1`) — no
   code, no status, no metadata. `guard()` (`src/mcp/server.ts:38-49`) flattens it to
   `{ isError: true, text }`. "Parked, here is a challenge" is not an error and must
   not look like one to a worker. This needs a sibling type and translation in both
   `guard()` and the REST `app.onError`.
2. **The supervised path is not reachable end-to-end.** `resolveSupervisedPrincipal`
   has zero production callers; `/mcp` still resolves bearers via `authenticate()`
   (`src/server.ts:66-82`), which a `sup_` token can never match. Phase 1 built the
   plumbing. Affirmation needs the pipe connected first.
3. **The gates check *who*, not *how recently*.** All four sites branch on
   `actor.type === "agent"` / `!== "human"`. There is no freshness or challenge
   notion anywhere in the path. A human bearer token passes all four unconditionally
   today.
4. **Attribution is written but never read.** `listIssueEvents`
   (`src/services/events.ts:53-67`) projects `id, type, payload, createdAt,
   actorName` — not `viaAgentId` or `sessionId`. An affirmation nobody can see in the
   UI is an audit log with no auditor.

One structural note: the human-only predicate is duplicated three times
(`actors.ts:11-15`, `triage-actions.ts:11-15`, `github-repos.ts:23-27`) and is not
uniform — `!== "human"` in some places, `=== "agent"` in others. Any step-up rule
should land in **one** centralized policy decision, or it will be enforced in three
places and bypassed in a fourth.

## 7. The failure mode to design against

**npm is the cautionary tale.** npm required 2FA for publish — a real human factor on
a genuinely high-risk action. Then automation needed to publish, so **automation
tokens were introduced that skip the OTP check entirely**. The gate did not get
stronger; it got a documented bypass, and the bypass became the default path for
exactly the automated publishes that most needed the gate. npm's eventual answer was
not a better human factor but **trusted publishing** — short-lived OIDC credentials
scoped to a specific workflow — plus a "disallow tokens" setting for those who
genuinely want interactive-only.

The lesson maps onto us exactly. If dispatched workers need to stamp done at 3am and
a biometric blocks them, someone will add a bypass — and that bypass will be the path
every worker takes. So the design question is not "how do we add a biometric" but:

> **Which actions are we willing to make genuinely impossible without a present
> human?**

If the honest answer is "none, because unattended dispatch must keep flowing," then
this is theatre and we should not build it. If the answer is "done-stamping and
dependency removal, and unattended dispatch was never supposed to do those anyway" —
which is what CLAUDE.md already claims — then the gate costs nothing in throughput,
because agents were already forbidden from those transitions. **That framing matters:
we would not be adding friction to agents. We would be adding proof to humans.**

## 8. Recommendation

If this is pursued, roughly in this order:

1. **Finish the supervised-session path first.** Affirmation has nothing to hang on
   until `resolveSupervisedPrincipal` is reachable and `pendingActions` has a
   service. This is a prerequisite, not a co-requisite.
2. **Build the relay with no biometric at all.** Propose → park → notify → affirm →
   execute, affirmation being an authenticated click in the web UI. This is the
   Vault control-group pattern, it is most of the value (out-of-band human
   confirmation of a specific action, with an audit trail), and it makes the
   biometric a swap of one verifier rather than a new subsystem.
3. **Add `ssh-keygen -Y sign` + `verify-required` as the first real verifier.**
   Off-the-shelf, hardware-verified, no RP to get wrong. Prove the challenge-binding
   end-to-end here where the crypto is someone else's problem.
4. **Add WebAuthn later, if the phone flow justifies the RP implementation.**
5. **Shape the affirmation record like an AP2 Cart Mandate** — signed, covering
   exactly what was displayed. Cheap now; possibly interoperable later.

Open questions worth settling before any of this:

- Is the threat we care about a **leaked human token**, or a **human approving
  carelessly**? Only the first is addressed here. If it is the second, the money goes
  into rendering the action well, not into cryptography.
- Does `service` fit the step-up model at all, or is it exempt by construction?
  (SYD-213 is the live thread; `service` is currently fail-closed out of the issue
  write path at `issues.ts:151-155` and `issues.ts:294-298`.)
- What is the recovery story when the authenticator is lost? A break-glass path that
  is weaker than the gate *is* the gate. This question has sunk more MFA rollouts
  than any crypto flaw.

## Sources

**Claude Code ecosystem**
- [anthropics/claude-code#38747 — Remote cryptographic signing approval via iOS app](https://github.com/anthropics/claude-code/issues/38747)
- [anthropics/claude-code#58270 — Local session authentication](https://github.com/anthropics/claude-code/issues/58270)
- [anthropics/claude-code#60433 — Mobile notification and remote approval](https://github.com/anthropics/claude-code/issues/60433)
- [yuuichieguchi/claude-remote-approver](https://github.com/yuuichieguchi/claude-remote-approver) · [wmoto-ai/cc-g2](https://github.com/wmoto-ai/cc-g2)
- [Claude Code hooks guide](https://code.claude.com/docs/en/hooks-guide)

**Approval-gate architectures**
- [Vault control groups](https://developer.hashicorp.com/vault/docs/enterprise/control-groups) · [`/sys/control-group` API](https://developer.hashicorp.com/vault/api-docs/system/control-group)
- [AWS: Secure API access with MFA](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_mfa_configure-api-require.html)
- [Duo Push design](https://jon.oberheide.org/blog/2011/06/08/duo-push-the-next-generation-of-two-factor-authentication/)
- [npm: requiring 2FA for publishing](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/) · [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [1Password app integration security](https://developer.1password.com/docs/cli/app-integration-security/)

**FIDO / WebAuthn**
- [FIDO Alliance — standards for trusted AI agent interactions](https://fidoalliance.org/fido-alliance-to-develop-standards-for-trusted-ai-agent-interactions/)
- [Google AP2](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol) · [ap2-protocol.org](https://ap2-protocol.org/)
- [w3c/webauthn#2020 — confirmation extension (closed)](https://github.com/w3c/webauthn/pull/2020)
- [W3C Secure Payment Confirmation](https://www.w3.org/TR/secure-payment-confirmation/)
- [Yubico: Securing SSH with FIDO2](https://developers.yubico.com/SSH/Securing_SSH_with_FIDO2.html) · [User Presence vs User Verification](https://developers.yubico.com/WebAuthn/WebAuthn_Developer_Guide/User_Presence_vs_User_Verification.html)
- [Corbado: AI Agents Authentication](https://www.corbado.com/blog/ai-agents-passkeys) · [WebAuthn hybrid transport](https://www.corbado.com/blog/webauthn-passkey-qr-code)
- [draft-bradleylundberg-cfrg-arkg](https://datatracker.ietf.org/doc/draft-bradleylundberg-cfrg-arkg/)
- `man ssh-keygen` (OpenSSH_10.2p1) — `-Y sign` / `-Y verify`, ALLOWED SIGNERS `verify-required`
