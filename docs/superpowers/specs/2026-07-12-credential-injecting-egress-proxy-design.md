# Credential-injecting egress proxy (design)

- **Date:** 2026-07-12
- **Status:** Draft — awaiting review
- **Project 1 of 2.** This spec covers the shared proxy infrastructure. A
  follow-up spec (Codex & Gemini containerized workers) builds on it.

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
A single trusted proxy sidecar holds the keys and injects them into outbound
provider requests; agent containers carry only a dummy key and a base-URL that
points at the proxy. This is a stronger model than "keys in a locked room," and
it is the foundation the Codex and Gemini workers (Project 2) will require,
since their credentials (an OpenAI key, a Gemini key) are equally worth keeping
out of an untrusted session.

Because the mechanism is novel, we **prove it on the Claude worker first** — the
engine already running in production — before adding new engines.

## Non-goals

- Codex and Gemini worker engines themselves — separate follow-up spec (Project
  2). This spec only builds the proxy and retrofits Claude onto it.
- Bare-host (non-containerized) dispatch. The injecting proxy is a
  containerized-dispatch concern; the bare-host `cli`/`sdk` runners are
  out of scope.
- Rotating or minting provider keys. The proxy injects whatever key it is
  configured with; key management stays a host/`.env` concern.
- Replacing `SWITCHYARD_TOKEN` handling. That token is the session's *intended*
  identity (scoped, low-value); it stays an env var in the agent container as
  today.

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

### A. One unified proxy sidecar (replaces tinyproxy)

A single sidecar, `syd-egress`, takes on **both** responsibilities:

1. **Domain-allowlist forward proxy** (the tinyproxy role today). Agent
   containers point `HTTP_PROXY`/`HTTPS_PROXY` at it; it enforces a default-deny
   hostname allowlist for general egress (npm, git, the switchyard MCP call).
   HTTPS is handled via the `CONNECT` method: the proxy validates the target
   host against the allowlist, then tunnels bytes without terminating TLS.
2. **Credential-injecting reverse proxy** (new). Each engine's *provider* API
   base-URL is overridden to target this proxy on a per-provider path prefix.
   The proxy reverse-proxies the request to the real provider host, **injecting
   the real credential** and overwriting any dummy key the CLI sent.

One component means the allowlist and the injection routes live together and
share one lifecycle; provider hosts are implicitly reachable because they are
the injector's fixed upstreams. The cost is re-implementing the `CONNECT`
forward-proxy path in Node (tinyproxy did this for free) — see the spike in §H.

**Implementation:** a small TypeScript service, `scripts/inject-proxy.ts` (name
TBD; it is the whole egress proxy now, so `scripts/egress-proxy.ts` may read
better), plus `Dockerfile.egress-proxy` rebuilt to run it instead of tinyproxy.
Same idiom as `scripts/slack-notifier.ts`: a Hono app for the origin-form
(reverse-proxy) routes, a raw `http.Server` `connect` handler for the
forward-proxy `CONNECT` path, and an injectable `fetch`/`net.connect` so the
logic is unit-testable without Docker or real upstreams.

### B. Injection routing table

Fixed prefix → upstream + credential map (the proxy can never be used as an
open relay to an arbitrary host):

| Prefix        | Upstream                                   | Injected credential                         |
|---------------|--------------------------------------------|---------------------------------------------|
| `/anthropic/*`| `https://api.anthropic.com/*`              | Claude auth (OAuth bearer or API key — §H)  |
| `/openai/*`   | `https://api.openai.com/*`                 | `Authorization: Bearer $OPENAI_API_KEY`     |
| `/gemini/*`   | `https://generativelanguage.googleapis.com/*` | `x-goog-api-key: $GEMINI_API_KEY`        |

(`/openai` and `/gemini` rows are provisioned now but only exercised by Project
2. Claude is the row we prove.)

Requirements on the reverse-proxy path:
- **Stream** request and response bodies (LLM APIs are SSE — never buffer).
- Preserve method, remaining path, query string, and headers, **except** the
  auth headers, which are stripped and replaced with the injected credential.
- Return the upstream status/headers/stream unchanged otherwise.

### C. Credential model

- The **real** provider credentials exist **only** in the `syd-egress`
  container's environment, passed `-e` from the host `.env` (0600) at
  `docker run` time (values from the launcher's env, never argv). This container
  runs **no agent code and mounts no repo** — it is a minimal trusted component,
  so a compromised *session* container cannot reach the key material.
- Agent containers receive:
  - a **dummy** provider key (e.g. `sk-dummy-switchyard`) so the CLI's own
    "is a key present" check passes;
  - a **base-URL override** pointing at `syd-egress` on the provider's prefix.
- `SWITCHYARD_TOKEN` continues to be passed to the agent container (unchanged).

Residual risk (documented, accepted): a prompt-injected session can still *use*
the provider through the proxy (that is how the agent legitimately runs) and
could burn provider quota, but it **cannot read the credential** and **cannot
reach any host outside the allowlist / fixed upstreams**. This is a large
reduction from today's "key readable in-env."

### D. Base-URL override per engine

- **Claude Code (proved here):** `ANTHROPIC_BASE_URL=http://syd-egress:PORT/anthropic`.
- Codex → `config.toml` `[model_providers.*].base_url` + dummy `env_key`
  (Project 2).
- Gemini → `GOOGLE_GEMINI_BASE_URL` (Project 2).

### E. Networking nuance

With both a base-URL override and `HTTPS_PROXY` set, the client must send
provider requests **directly** to `syd-egress` (origin-form) rather than
tunneling to it *through* itself. Achieve this by adding the proxy's own
hostname to `NO_PROXY` so provider base-URL traffic goes direct (plain HTTP on
the internal network — the network is the trust boundary, so no TLS to the proxy
is needed), while all other egress still flows through `HTTP(S)_PROXY` →
`CONNECT`. Validating this interaction is part of the spike (§H).

### F. Lifecycle

`ensureEgressGuard(config, exec)` evolves to stand up the unified proxy: same
race-tolerant idempotent pattern, dual-homed onto `syd-workers`, but now also
passing the provider-key env vars into the sidecar and recreating it when the
allowlist **or** the injected-key set changes. The `docker inspect` freshness
check extends to cover the key-var presence (not the values — never logged or
compared in cleartext beyond a presence/hash check).

### G. Claude retrofit + acceptance

Flip the Claude containerized path in `buildDockerArgs`:
- **Remove** `-e ANTHROPIC_API_KEY` / `-e CLAUDE_CODE_OAUTH_TOKEN` from the agent
  container.
- **Add** `-e ANTHROPIC_BASE_URL=http://syd-egress:PORT/anthropic` and a dummy
  key var.
- Route the real Claude credential to the `syd-egress` container instead.

**Acceptance (manual integration):** dispatch a real Claude-labeled SYD issue;
confirm it still produces its `agent/<ref>` PR, **and** `docker exec` into the
running agent container shows **no** real Anthropic credential in its
environment (only the dummy key + base-URL).

## H. OAuth spike (do first)

Claude Code currently authenticates with `CLAUDE_CODE_OAUTH_TOKEN` (a Claude
subscription credential), not a plain `ANTHROPIC_API_KEY`. Two unknowns must be
resolved before the retrofit is trustworthy:

1. **Does Claude Code, pointed at a custom `ANTHROPIC_BASE_URL`, drive its
   requests in a way the proxy can inject the OAuth bearer into?** The user
   reports an existing CLI ("onecli") already proxies Claude Code OAuth
   successfully — **consult it as prior art** for the exact headers/endpoints and
   any OAuth-specific request shape (e.g. beta headers, token audience).
2. **Token refresh.** If the OAuth access token can expire within a session
   (≤1h watchdog), decide whether the proxy injects a static token for the
   session or must refresh. Prefer static-for-session if the token outlives the
   session; document the refresh path if not.

Deliverable of the spike: a one-page note confirming the injected-request shape
for Claude OAuth, folded back into this spec before implementation. If OAuth
proves impractical, the fallback proof is Codex-with-API-key — but the user's
prior-art pointer suggests OAuth is the intended, feasible path.

## Security invariants (preserved + added)

- Real provider credentials: **only** in the trusted `syd-egress` container
  (no agent code, no repo mount); never in an agent container, never in argv.
- Injector upstreams are a **fixed table** — not caller-controlled — so the
  proxy cannot be turned into an open relay.
- Domain allowlist (default-deny) remains for all non-provider egress.
- `SWITCHYARD_TOKEN` handling unchanged (scoped identity, intended for the
  session).
- `npm ci` continues to run with the secret vars stripped from its environment
  (existing `npm-ci-guard.mjs` behavior) — and there are now *fewer* secrets to
  strip in the agent container.

## Testing

- **Unit (injector):** prefix routing → correct upstream + injected header;
  streaming passthrough (no buffering); dummy-key overwrite; unknown paths
  rejected; upstreams not caller-overridable; `CONNECT` allowlist enforcement
  (allowed host tunnels, disallowed host 403s). Injectable `fetch`/socket, per
  repo idiom.
- **Unit (`ensureEgressGuard`):** idempotency and recreate-on-change for both
  allowlist and key-set; race tolerance preserved.
- **Unit (`buildDockerArgs`):** Claude agent container gets base-URL + dummy key
  and **no** real Anthropic credential; the real credential appears only in the
  sidecar's run args (as bare `-e`, never a value in argv).
- **Manual integration:** the §G acceptance.

## Rollout & relationship to Project 2

1. OAuth spike (§H) → fold results in.
2. Build the unified proxy + `ensureEgressGuard` evolution + Claude retrofit,
   behind the existing containerized path (default engine = Claude, no config
   migration for existing workers beyond the retrofit).
3. Prove via §G acceptance.
4. **Project 2** (separate spec) adds the Codex and Gemini engines: the `/openai`
   and `/gemini` injector routes are already provisioned, so Project 2 is engine
   config + Dockerfiles + entry scripts + per-engine `buildDockerArgs`, pointing
   each engine's base-URL at the corresponding prefix.

Per the repo's board-driven-dev norm, this spec → an implementation plan →
filed SYD issues for triage, not an in-session build.

## Open questions

- Final service filename (`scripts/egress-proxy.ts` vs `inject-proxy.ts`) and
  whether the proxy port stays 8888 or splits forward/origin listeners.
- Exact dummy-key format each CLI will accept without a preflight validation
  error (resolve per engine; Claude in the spike).
