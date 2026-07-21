# Touch ID affirmation for supervised sessions

**Date:** 2026-07-21
**Status:** Approved design (Sean, 2026-07-21)
**Depends on:** `feat/affirmation-relay` (the phase-2 signed-affirmation branch, unmerged as of this writing), and the cc-presence-gate project at `~/sites/cc-fido-gate`.
**Supersedes:** the "native notification + Touch-ID keychain" sketch in the phase-2 section of `2026-07-15-supervised-interactive-sessions-design.md` (already superseded once by `2026-07-16-affirmation-relay-design.md`; this spec is the concrete Touch ID answer).

## Context and decision

We evaluated whether Switchyard should keep rolling its own human-affirmation mechanism or piggyback on the cc-presence-gate plugin (`~/sites/cc-fido-gate`, MIT, ships `cc-fido` and `cc-touch-id`). Findings that drove the decision:

- cc-presence-gate is a **hardened descendant of Switchyard's own affirmation gate** — its `docs/design.md` explicitly generalizes the SYD-242 / PR #194 work, and critiques two weaknesses in our unmerged `src/services/ssh-verify.ts`: bare (PATH-resolved) `ssh-keygen` invocation, and an `allowed_signers` file written to an agent-writable tmpdir.
- Full piggyback is impossible today: cc-presence-gate verifies **locally** in a macOS-only Swift broker, and has **no detached "sign a server-issued challenge" verb** — the ceremony is welded to its local `PreToolUse` broker round-trip. Switchyard's verifier must run in the tracker's Linux container in TypeScript.
- Pure roll-your-own would rebuild the one thing we cannot reasonably rebuild: the **Developer-ID-signed, notarized, entitled app** that Secure Enclave key access requires. cc-presence-gate already ships it.

**Decision: split by role.** Switchyard owns server-side verification (TypeScript, Linux). cc-presence-gate owns the client-side Touch ID ceremony, via a new detached sign-challenge verb. The FIDO `ssh-keygen` path from `feat/affirmation-relay` lands first and remains supported as the fallback signer.

## Goals

- A human affirms a pending action (`syd affirm SYD-nnn`) with a fingerprint on their Mac instead of a security-key touch.
- Server-side verification of the Touch ID signature with **no new binary dependencies** (native `node:crypto`, no `openssh-client` on this path).
- One maintained ceremony codebase (cc-presence-gate), one maintained verifier (Switchyard services).
- The two hardening fixes cc-presence-gate identified land with the relay branch.

## Non-goals

- Proving user-verification cryptographically to the server (impossible in both the SSHSIG and raw-ECDSA models; see Trust statement).
- Gating anything beyond what `feat/affirmation-relay` already gates (only `done`; SYD-246 established `dependency.remove` is unreachable from a supervised session).
- Replacing the FIDO path. `sk-*` SSH keys remain first-class (lost-Mac recovery, non-Mac clients).
- Changing cc-presence-gate's local `PreToolUse` gating role — the new verb is additive.

## Design

### 1. Foundation: land `feat/affirmation-relay` with hardening

Merge the branch (canonical-action, key enrollment, `/affirm-signed`, `syd affirm`, SSHSIG verify) after two fixes:

- **Pinned `ssh-keygen` path.** `ssh-verify.ts` invokes an absolute path from config (`SWITCHYARD_SSH_KEYGEN`, default `/usr/bin/ssh-keygen`), never PATH resolution. Startup keeps the existing fail-loud behavior if the binary is missing.
- **Private `allowed_signers`.** The verifier builds the file inside a `0700` directory owned by the server process (`mkdtemp` under a private runtime dir, not shared `/tmp`), written `0600`, removed after verify.

### 2. Switchyard: `p256` as a second enrolled key type

- **Enrollment** (`affirmation-keys.ts`) accepts, alongside `sk-*` SSH public keys, a `p256` key: the Secure Enclave public key as SPKI PEM, plus a device label (e.g. "MBP Secure Enclave"). Secure Enclave keys are per-device and non-exportable, so enrollment is per-Mac and a lost Mac means enroll a new key / affirm via FIDO meanwhile.
- **Verification**: `node:crypto` `verify()` — ECDSA over P-256 with SHA-256, DER signature, against the stored SPKI key. No shelling out.
- **Domain separation**: the signed message for this key type is `"switchyard-affirm-p256\0" + canonical_action_bytes`. The SSHSIG path already has its namespace (`switchyard-affirm`); the prefix gives the raw-ECDSA path equivalent protection against cross-protocol signature reuse.
- `/affirm-signed` dispatches on the enrolled key's type; everything downstream (claim-then-execute via `affirmPendingAction`, expiry rules, one-live-pending invariant) is unchanged from the relay branch.

### 3. cc-presence-gate: detached sign-challenge verb

New verb on the `cc-touch-id` CLI (working name: `cc-touch-id affirm`):

- **Input**: the pending-action document as structured JSON on stdin — *not* opaque bytes. The broker only signs what it can render (WYSIWYS invariant preserved).
- **Flow**: client → broker socket → broker canonicalizes the document per the shared contract (§4), produces the human rendering with the existing confusable/bidi-escaping machinery (`Canonical.swift`), shows it in the `LAContext` Touch ID sheet, signs the domain-tagged canonical bytes with the Secure Enclave key (`.biometryCurrentSet`, `SecureEnclave.swift`), returns the DER signature.
- **Output**: JSON `{ "signature": "<base64 DER>", "publicKey": "<SPKI PEM>", "algo": "ecdsa-p256-sha256" }` on stdout; nonzero exit on decline/cancel/error (fail closed).
- **Enrollment export**: a `cc-touch-id export-pubkey` verb (or existing status output) prints the SPKI PEM for pasting into Switchyard enrollment.
- Tracked and specced in the cc-presence-gate repo's own SDD flow; this spec only fixes the interface.

### 4. Shared canonicalization contract

`src/services/canonical-action.ts` (TS) and the Swift verb must produce **byte-identical** canonical forms of the pending-action document. The contract (pinned in both repos):

- The exact field set of the signed document, sorted keys, UTF-8, no slash-escaping — the intersection of the relay branch's canonical form and `Canonical.swift`'s rules, to be nailed down field-by-field in the implementation plan.
- A **shared test-vector file** (JSON document → expected canonical bytes → a real signature that the real verifier accepts) vendored into both repos and asserted in both test suites.
- Acceptance is a **full round-trip through the real binaries on real hardware** (fingerprint included), not string comparison — per the standing rule from the fabricated `verify-required` incident: prove tool claims by running the tool.

### 5. Client flow (`syd affirm`)

1. Fetch the pending action, render it in the terminal (unchanged from the relay branch).
2. Signer selection: if the human has a `p256` key enrolled **and** the cc-presence-gate broker is reachable, pipe the document to `cc-touch-id affirm`; otherwise fall back to `ssh-keygen -Y sign` with the FIDO key. `--signer touchid|fido` overrides.
3. POST signature + key id to `/affirm-signed`; server verifies per key type and executes.

### Error handling

- Broker unreachable / verb missing / user cancels the Touch ID sheet → clear message and offer of the FIDO fallback; never silent success.
- Signature verify failure server-side → 403 `SwitchyardError`, pending action untouched (still affirmable).
- Biometric set changed (`.biometryCurrentSet` invalidates the SE key) → signing fails on-device; remedy is re-enrolling, message says so.
- Expired/closed session or expired pending action → existing relay-branch rejection semantics, unchanged.

### Trust statement (carried verbatim into user-facing docs)

The server verifies that **someone possessing an enrolled private key signed the exact action bytes**. It cannot cryptographically prove a fingerprint (or key-touch) happened — user presence/verification is enforced on-device: by the FIDO token at signing time, or by `LAContext` + `.biometryCurrentSet` for the Secure Enclave key. One asymmetry vs the FIDO path: an `sk-*` key type proves hardware backing at enrollment, but a bare P-256 SPKI carries no evidence of Secure Enclave origin — enrollment trusts that the key came from `cc-touch-id export-pubkey` on the human's Mac. Closing that would require WebAuthn-style attestation, which is out of scope (and pointless while enrollment is already a trusted human/admin action). The affirmation-relay spec's low-security-yield verdict still stands: a supervised session already holds full repo credentials, so this gate hardens the done-stamp bookkeeping step, not the code path. Touch ID buys ceremony UX and the artifact, not a new security boundary.

## Testing

- **Switchyard unit**: p256 verify (happy path, wrong key, tampered bytes, missing domain tag, DER malformed), enrollment validation (reject non-SPKI / non-P-256 input), signer-dispatch in `/affirm-signed`. Vitest, alongside the relay branch's existing `affirm-signed.test.ts` / `ssh-verify.test.ts` suites.
- **Cross-repo vectors**: the shared test-vector file asserted in both suites (§4).
- **Hardware e2e**: human-run — enroll SE key, `syd affirm` with fingerprint, verify board state + events attribution; and the FIDO fallback still round-trips. Screenshots/transcript attached to the issue per the visual-verification convention.
- `npm run verify` green before any done-stamp, as always.

## Delivery

Board-driven; sequencing is strict:

1. **SYD: land `feat/affirmation-relay` + hardening fixes** (§1). Rebase on current `main`, apply the two fixes, PR, human merge.
2. **cc-presence-gate: `affirm` + `export-pubkey` verbs** (§3, that repo's own tracker/SDD flow) — can proceed in parallel with 1 after the contract (§4) is pinned.
3. **SYD: `p256` enrollment + verify + `/affirm-signed` dispatch** (§2). Depends on 1; testable against vectors before 2 ships.
4. **SYD: `syd affirm` Touch ID integration + hardware e2e** (§5). Depends on 1–3; `workerPreference=interactive` (needs a Mac, a broker, and a finger).

Open follow-up: SYD-247 (macOS FIDO tooling note from the SYD-242 session) should be checked for overlap when filing.
