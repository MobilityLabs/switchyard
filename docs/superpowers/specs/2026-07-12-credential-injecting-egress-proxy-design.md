# Credential-injecting egress proxy (design)

- **Date:** 2026-07-12
- **Status:** Draft — awaiting review
- **Project 1 of 2.** This spec covers the shared proxy infrastructure. A
  follow-up spec (Codex & Gemini containerized workers) builds on it.
- **Revision (2026-07-12):** interception method changed from base-URL override
  to **TLS MITM + a private CA**, following prior art in
  [onecli](https://github.com/onecli/onecli) (see §H). Earlier base-URL-override
  sections are superseded.

## Context & goal

Switchyard dispatches agent sessions into disposable Docker containers
(`scripts/agent-worker.ts` → `buildDockerArgs`). Today those containers receive
the **real** provider credentials as environment variables (`-e
ANTHROPIC_API_KEY`, `-e CLAUDE_CODE_OAUTH_TOKEN`) alongside the low-value scoped
`SWITCHYARD_TOKEN`. The SYD-110 egress guard (a tinyproxy sidecar with a domain
allowlist on an `--internal` Docker network) mitigates *exfiltration* — a
prompt-injected session can only reach allowlisted hosts — but the real keys
still live in the container. `docs/2026-07-10-in-depth-review.md:293` flags this:
once a high-value credential is an env var in a networked container, careful
argv hygiene doesn't stop a compromised session from *reading* it.

The goal: **real provider account credentials never enter an agent container.**
A single trusted proxy sidecar holds the keys, intercepts the container's
outbound TLS to the provider hosts, and injects the real credential into each
request. Agent containers carry only a **placeholder** credential (enough to
make the CLI attempt the call) and trust the proxy's CA.

Because the mechanism is novel to this codebase, we **prove it on the Claude
worker first** — the engine already running in production — before adding new
engines.

## Non-goals

- Codex and Gemini worker engines themselves — separate follow-up spec (Project
  2). This spec builds the proxy and retrofits Claude onto it; the OpenAI/Gemini
  injection rules are provisioned but only exercised by Project 2.
- Bare-host (non-containerized) dispatch. The injecting proxy is a
  containerized-dispatch concern; the bare-host `cli`/`sdk` runners are out of
  scope.
- Rotating or minting provider keys. The proxy injects whatever key it is
  configured with; key management stays a host/`.env` concern.
- Replacing `SWITCHYARD_TOKEN` handling. That token is the session's *intended*
  identity (scoped, low-value); it stays an env var in the agent container.

## Background: what exists today

- `scripts/worker-select.ts`
  - `EGRESS_NETWORK = "syd-workers"` (`--internal`), `EGRESS_PROXY_NAME =
    "syd-egress"`, `EGRESS_PROXY_IMAGE = "switchyard-egress-proxy"`, port 8888.
  - `EGRESS_BASELINE = ["api.anthropic.com", "registry.npmjs.org"]` + tracker
    host + `config.egressAllow`.
  - `ensureEgressGuard(config, exec)` idempotently (race-tolerant) creates the
    internal network and the tinyproxy sidecar, dual-homing it onto the bridge
    and the internal network.
  - `egressDockerArgs(config)` joins agent containers to the internal network and
    sets `HTTP(S)_PROXY` → the sidecar, `NO_PROXY=localhost,127.0.0.1`.
  - `buildDockerArgs(...)` assembles the `docker run` argv: resource limits,
    `no-new-privileges`, the `/origin` mount, and the `-e` secret passthrough
    (bare `-e VAR`, values from the worker env, never argv).
- `scripts/egress-proxy-entry.sh` + `Dockerfile.egress-proxy`: tinyproxy with
  `FilterDefaultDeny`, one anchored ERE per allowlisted hostname.
- `scripts/container-entry.sh`: clones `/origin` → `/work`, checks out
  `agent/<ref>`, writes the switchyard MCP config (bearer token in a 0600 file,
  not argv), runs `claude -p`, pushes the branch back if commits exist.

All of the selection / retry / resume / session-reporting / watchdog /
branch-publish / delivery machinery is **credential-agnostic** and untouched by
this work.

## Design

### A. One intercepting proxy sidecar (replaces tinyproxy)

A single sidecar, `syd-egress`, is a **TLS-intercepting forward proxy**. Agent
containers point `HTTP_PROXY`/`HTTPS_PROXY` at it exactly as today; **provider
base URLs are unchanged** (the CLIs still address `api.anthropic.com` etc.). Per
`CONNECT`:

1. **Provider host** (in the injection table, §B) → **MITM**: the proxy
   completes the `CONNECT`, then terminates TLS itself using a leaf certificate
   generated on the fly and signed by the proxy's own CA, decrypts the request,
   **strips the caller's auth header and injects the real credential**, and
   re-encrypts to the real provider over a genuine TLS connection. Response
   streams straight back (SSE-safe).
2. **Allowlisted non-provider host** (npm, git, the switchyard MCP call) →
   **plain tunnel**: validate the host against the default-deny allowlist and
   pipe bytes through without terminating TLS (today's tinyproxy behavior).
3. **Anything else** → refused.

One component owns both the allowlist and the injection, sharing one lifecycle.
The cost versus the old tinyproxy is TLS interception + CA distribution — which
is why the **recommended implementation is `mitmproxy` with a small
header-injection addon** rather than hand-rolling TLS termination and on-the-fly
cert minting. mitmproxy is purpose-built for exactly this (CA generation, SNI
leaf-cert minting, streaming, an addon hook to rewrite headers, and an
allowlist/kill filter for non-provider hosts); onecli's bespoke Rust interceptor
(`apps/gateway/src/ca.rs`, `gateway/mitm.rs`) is the analog. The **pure
host→injection mapping** (§B) stays a tiny, unit-tested module regardless of the
proxy engine. *(If we prefer to keep everything in-repo TypeScript, a Node MITM
is possible but carries the cert-minting complexity mitmproxy already solves —
flagged as an implementation choice, not settled here.)*

### B. Injection table (keyed by host)

Fixed target host → credential rewrite. The proxy only MITMs these hosts; it can
never be pointed at an arbitrary upstream.

| Provider host                          | Rewrite                                                                                 |
|----------------------------------------|-----------------------------------------------------------------------------------------|
| `api.anthropic.com`                    | If token starts `sk-ant-oat` (OAuth): set `Authorization: Bearer <token>`. If `sk-ant-api` (API key): set `x-api-key: <token>`, remove `authorization`. |
| `api.openai.com`                       | Set `Authorization: Bearer $OPENAI_API_KEY` *(Project 2)*                                |
| `generativelanguage.googleapis.com`    | Set `x-goog-api-key: $GEMINI_API_KEY` *(Project 2)*                                      |

The Anthropic rule is confirmed from onecli's `apps/gateway/src/secret_inject.rs`
(§H). In all cases the caller's own auth header is stripped first; the client's
`anthropic-version`/`anthropic-beta` (and equivalents) pass through untouched
because they originate from the CLI, not the credential.

Requirements on the intercept path:
- **Stream** bodies (LLM APIs are SSE — never buffer).
- Rewrite only the auth header(s); leave method, path, query, and other headers
  intact.
- Return upstream status/headers/stream unchanged.

### C. Credential model

- The **real** provider credentials **and the CA private key** exist **only** in
  the `syd-egress` container's environment/volume, never in an agent container
  and never in argv. This container runs **no agent code and mounts no repo** —
  a minimal trusted component, so a compromised *session* container cannot reach
  the key material or the CA signing key.
- Agent containers receive:
  - a **placeholder** credential so the CLI attempts the request. For Claude
    OAuth this is `CLAUDE_CODE_OAUTH_TOKEN=placeholder` (onecli's literal
    pattern — the SDK still performs its token exchange; the proxy overwrites the
    resulting auth header);
  - the CA **public** certificate (read-only mount) installed into the trust
    store — `NODE_EXTRA_CA_CERTS` for Node-based CLIs (Claude Code, Gemini) and
    the system store (`update-ca-certificates`) for others (Codex, Project 2).
- `SWITCHYARD_TOKEN` continues to be passed to the agent container (unchanged).

Residual risk (documented, accepted): a prompt-injected session can still *use*
the provider through the proxy (that is how the agent legitimately runs) and
could burn provider quota, but it **cannot read the credential**, **cannot reach
any host outside the allowlist / injection hosts**, and **cannot obtain the CA
signing key** (only the public cert is in the container). Large reduction from
today's "key readable in-env."

### D. CA lifecycle & trust distribution

- The proxy owns a **stable CA** (private key + cert), generated once and
  **persisted** (a Docker volume or a host-mounted 0600 dir) so it survives
  sidecar restarts — agent containers must keep trusting the same CA across
  dispatches.
- Only the CA **public cert** is exposed to agent containers (read-only mount
  from the persisted location). `container-entry.sh` installs it into the trust
  store and exports `NODE_EXTRA_CA_CERTS` before launching the CLI.
- `ensureEgressGuard` guarantees the CA exists before standing up the sidecar.

### E. Networking

All agent egress flows through `HTTP(S)_PROXY` → the sidecar via `CONNECT`
(unchanged from today). Provider hosts are MITM'd; everything else is
allowlist-tunneled. There is **no base-URL override and no `NO_PROXY` special
case** for provider traffic — a key simplification versus the superseded
base-URL approach, paid for by CA trust (§D).

### F. Lifecycle

`ensureEgressGuard(config, exec)` evolves to: (1) ensure the persisted CA (§D);
(2) stand up the intercepting sidecar with the same race-tolerant idempotent
pattern, dual-homed onto `syd-workers`, now passing the provider-key env vars
into the sidecar; (3) recreate the sidecar when the allowlist **or** the
injected-key set changes (freshness check compares key-var *names*, never
values). The CA is never regenerated on a recreate (that would break existing
trust).

### G. Claude retrofit + acceptance

Flip the Claude containerized path in `buildDockerArgs` + `container-entry.sh`:
- **Remove** `-e ANTHROPIC_API_KEY` / `-e CLAUDE_CODE_OAUTH_TOKEN` from the agent
  container.
- **Add** `-e CLAUDE_CODE_OAUTH_TOKEN=placeholder` and the read-only CA-cert
  mount; `container-entry.sh` installs the CA + sets `NODE_EXTRA_CA_CERTS`.
- Route the real Claude credential to the `syd-egress` container instead.

**Acceptance (manual integration):** dispatch a real Claude-labeled SYD issue;
confirm it still produces its `agent/<ref>` PR (the injected OAuth path actually
reaches Anthropic), **and** `docker exec` into the running agent container shows
**no** real Anthropic credential in its environment (only the placeholder + the
CA cert).

## H. Prior art & remaining spike

onecli (https://github.com/onecli/onecli) is a mature credential-injecting
gateway that specifically proxies Claude Code. Verified from its source and now
baked into this design:

- **Anthropic injection** (`apps/gateway/src/secret_inject.rs`): `sk-ant-oat` →
  `Authorization: Bearer`; `sk-ant-api` → `x-api-key` + remove authorization
  (§B).
- **Placeholder-in-container** (`packages/api/src/routes/container-config.ts`):
  `CLAUDE_CODE_OAUTH_TOKEN=placeholder` in the agent container (§C).
- **No mid-session refresh** for Anthropic — inject the token statically.
- **Interception via TLS MITM + CA** (`ca.rs`, `gateway/mitm.rs`) — base URL
  stays `api.anthropic.com`. This is why this spec now uses MITM (§A) rather than
  base-URL override.

Remaining spike (small): stand up a mitmproxy addon locally, point a throwaway
`claude -p` run through it with the CA trusted, and confirm (a) Claude Code's
OAuth token-exchange completes through the MITM and the session works, and
(b) the injected `Authorization: Bearer` reaches Anthropic. onecli demonstrates
this works; the spike is a local confirmation + pinning the mitmproxy addon
shape, not an open feasibility question.

## Security invariants (preserved + added)

- Real provider credentials **and the CA private key**: only in the trusted
  `syd-egress` container; never in an agent container, never in argv. Agent
  containers hold only the CA **public** cert.
- Injection hosts are a **fixed table** — not caller-controlled — so the proxy
  cannot be turned into an open relay.
- Domain allowlist (default-deny) remains for all non-provider egress.
- `SWITCHYARD_TOKEN` handling unchanged (scoped identity, intended for the
  session).
- `npm ci` continues to run with the secret vars stripped from its environment
  (existing `npm-ci-guard.mjs`) — and there are now *fewer* secrets in the agent
  container to strip.

## Testing

- **Unit (pure mapping):** host → injection rule (`sk-ant-oat` vs `sk-ant-api`
  branch; OpenAI/Gemini rules); caller auth header always stripped before
  injection; unknown host has no rule. Kept as a small standalone module even if
  the proxy engine is mitmproxy.
- **Unit (`ensureEgressGuard`):** CA-exists precondition; idempotency and
  recreate-on-change for both allowlist and key-set; CA never regenerated on
  recreate; race tolerance preserved.
- **Unit (`buildDockerArgs`):** Claude agent container gets the placeholder +
  CA-cert mount and **no** real Anthropic credential; the real credential appears
  only in the sidecar's run args (bare `-e`, never a value in argv).
- **Integration (mitmproxy addon):** a request to an intercepted host emerges
  upstream with the caller auth replaced by the injected credential and the body
  streamed; a non-provider allowlisted host tunnels un-intercepted; a
  disallowed host is refused.
- **Manual integration:** the §G acceptance.

## Rollout & relationship to Project 2

1. Spike (§H) → pin the mitmproxy addon shape + confirm Claude OAuth through
   MITM.
2. Build the intercepting proxy + CA lifecycle + `ensureEgressGuard` evolution +
   Claude retrofit, behind the existing containerized path (default engine =
   Claude; existing workers get the retrofit, no other config migration).
3. Prove via §G acceptance.
4. **Project 2** (separate spec) adds the Codex and Gemini engines: the OpenAI
   and Gemini injection rules are already provisioned, so Project 2 is engine
   config + Dockerfiles + entry scripts + CA trust for non-Node CLIs (Codex uses
   the system store) + per-engine `buildDockerArgs`.

Per the repo's board-driven-dev norm, this spec → an implementation plan →
filed SYD issues for triage, not an in-session build.

## Open questions

- **Implementation engine:** mitmproxy+addon (recommended) vs in-repo Node MITM.
  Decides the image, the test harness, and whether a Python dep enters the repo.
- CA persistence mechanism (named Docker volume vs host-mounted 0600 dir) and
  how the public cert is surfaced to agent containers (same volume, read-only).
- Whether the sidecar keeps port 8888 as the single proxy listener.
