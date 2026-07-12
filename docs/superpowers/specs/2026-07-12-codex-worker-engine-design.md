# Codex containerized worker engine (design)

- **Date:** 2026-07-12
- **Status:** Draft — awaiting review
- **Project 2a of 2.** This spec adds the **Codex** engine on top of the
  Project 1 credential-injecting egress proxy (SYD-186, shipped). The **Gemini**
  engine is a deliberate fast-follow with its own spec/plan (§Rollout).
- Builds on: `docs/superpowers/specs/2026-07-12-credential-injecting-egress-proxy-design.md`.
- Reference (not merged): the stranded SYD-83 branch (`agent/SYD-83`) has a
  working Codex adapter and `container-entry.codex.sh` — used here as a
  blueprint for the CLI contract, **not** its config model (see §Non-goals).

## Context & goal

Switchyard's dispatch worker drives headless **Claude Code** sessions in
disposable containers (`scripts/agent-worker.ts` → `buildDockerArgs` →
`Dockerfile.worker` + `container-entry.sh`). Project 1 made the real Claude
credential never enter the container: the `syd-egress` sidecar TLS-MITMs
provider hosts and injects the real credential; the container holds only a
placeholder + the CA public cert.

**Goal:** add **OpenAI Codex CLI (`codex exec`)** as a second engine that reuses
the entire dispatch pipeline (selection, retry, session reporting, branch
publish, delivery) and the same credential-injection security posture — a Codex
container holds no real provider credential. Auth is the user's **ChatGPT
subscription login** (not a metered API key), injected by the proxy exactly as
Claude's OAuth token is.

Because Codex authenticates via ChatGPT OAuth (a login, not a static key) and is
a Rust binary (different CA-trust and MCP-config mechanics than Claude's Node
CLI), the exact request shape is proven with a **spike first** (mirrors SYD-185).

## Non-goals

- **Gemini engine** — fast-follow, separate spec (§Rollout). The SYD-186 addon's
  provisioned Gemini rule stays untouched here.
- **The runner-registry model** (SYD-83's `runners` map + per-issue
  `runner:<name>` label). We chose the **per-engine-process** model instead
  (§A) — SYD-83's registry is declined; only its Codex CLI mechanics are reused.
- **Bare-host Codex dispatch.** Containerized only — the injecting proxy is a
  containerized-dispatch concern.
- **Metered OpenAI API-key auth.** Chosen against in favor of the ChatGPT
  subscription login.
- **Changing server-enforced governance.** Triage/done/dependency rules are
  server-side and engine-agnostic; engines are worker-side dispatch only.

## Background: what exists today

- **Project 1 proxy (`scripts/egress-inject-addon.py`, `worker-select.ts`):**
  `syd-egress` runs mitmproxy + a host-keyed injection addon; `ensureEgressGuard`
  mounts a persisted CA volume, passes provider keys into the sidecar (bare
  `-e`), and recreates it when the allowlist/key-set (`INJECT_KEYS`) changes;
  `buildDockerArgs` (Claude, proxy mode) drops the real cred and adds
  `CLAUDE_CODE_OAUTH_TOKEN=placeholder` + a read-only CA mount;
  `container-entry.sh` sets `NODE_EXTRA_CA_CERTS`.
- **Codex CLI contract (from `agent/SYD-83`, reference):** Codex reads MCP
  config from `$CODEX_HOME/config.toml` (not a CLI flag) with
  `bearer_token_env_var = "SWITCHYARD_TOKEN"` (token name, never the value);
  runs `codex exec "<prompt>" --ask-for-approval never` for headless use. Its
  auth there was a static API key — **replaced** here by ChatGPT-OAuth injection.
- **Dispatch is engine-agnostic:** selection/retry/resume/session-reporting/
  watchdog/branch-publish/delivery in `agent-worker.ts` + `worker-select.ts` are
  untouched; the deltas are a config field, one Dockerfile, one entry script, and
  a `buildDockerArgs` branch.

## Design

### A. Per-engine process + `engine` field

- New `engine?: "claude" | "codex"` on `WorkerConfig` (default `"claude"`;
  reserved-extensible to `"gemini"`). **One worker process per engine.**
- A Codex worker runs with `engine: "codex"`, its **own minted switchyard
  token**, and poll **label `auto-codex`**. An issue is routed to Codex by
  carrying the `auto-codex` label (a triage decision); the Codex worker process
  (configured `engine: codex`, label `auto-codex`) picks it up. Provenance falls
  out per-process — no per-issue engine plumbing.
- `agent-worker.ts` runs a Codex worker from a distinct config file
  (`--config <path>` / a `switchyard-worker.codex.json`), same as any other
  worker role. Selection/retry/reporting are the existing engine-agnostic code.

### B. Credential model (Codex = ChatGPT OAuth, proxy-injected)

- The **real ChatGPT OAuth token lives only in `syd-egress`** (like Claude's
  `sk-ant-oat`), never in a Codex container.
- The Codex container gets a **placeholder `${CODEX_HOME}/auth.json`** so `codex`
  believes it is logged in and issues the request (onecli's pattern); the proxy
  strips the placeholder auth and injects the real token.
- Injection host/header confirmed by the spike (§F). Expected: the ChatGPT
  backend host with an `Authorization: Bearer <real-oauth-token>`.
- **CA trust:** Codex is a Rust binary → the CA is installed into the container's
  **system trust store** (`update-ca-certificates`), not `NODE_EXTRA_CA_CERTS`.
- `SWITCHYARD_TOKEN` stays a bare `-e` passthrough (scoped identity, unchanged).

### C. Addon change (new Codex injection rule)

`scripts/egress-inject-addon.py` gains a rule for the Codex/ChatGPT host the
spike pins, injecting the real ChatGPT OAuth token (read from a new proxy env
var, e.g. `CODEX_OAUTH_TOKEN`) as `Authorization: Bearer`. The provisioned
`api.openai.com → Bearer $OPENAI_API_KEY` rule is **repurposed/replaced** to
match the actual ChatGPT-login shape (the metered-API-key rule is unused given
the auth choice). Caller auth is stripped first, as for every provider host.
The pure `injection_for` selftest gains Codex cases.

### D. Lifecycle (`ensureEgressGuard`)

`PROVIDER_KEY_VARS` gains the Codex OAuth token var so it is passed into the
sidecar (bare `-e`) and named in the `INJECT_KEYS` freshness sentinel — so
standing up or key-rotating the Codex credential recreates the sidecar (never
regenerating the CA). No new lifecycle machinery; it reuses SYD-186's.

### E. Container contract

- **`Dockerfile.worker.codex`** — installs the Codex CLI, non-root, plus the CA
  install path (system trust store). Mirrors `Dockerfile.worker`'s posture.
- **`scripts/container-entry.codex.sh`** — mirrors the **current**
  `container-entry.sh` (clone `/origin`→`/work`, `BASE_BRANCH` fetch,
  `prime-workspace-trust`, `npm ci` guard, stack checks, `agent/<ref>`-only push,
  commit-count gate), but:
  - installs the mounted CA into the system trust store (`update-ca-certificates`);
  - writes `$CODEX_HOME/config.toml` with `[mcp_servers.switchyard]` +
    `bearer_token_env_var = "SWITCHYARD_TOKEN"`;
  - the placeholder `auth.json` is mounted by `buildDockerArgs` (§B);
  - runs `codex exec "$WORKER_PROMPT" --ask-for-approval never`.
- The engine-agnostic `buildContainerizedPrompt` is **reused** — it describes the
  task and the switchyard MCP tools (same tool names for Codex), not Claude
  specifics.

### F. Dispatch wiring (`buildDockerArgs`)

`buildDockerArgs` branches on `engine`:
- **Codex, proxy mode:** image `switchyard-worker-codex`; mount the placeholder
  `auth.json` + the read-only CA mount; egress args; `SWITCHYARD_TOKEN` bare; **no**
  real provider credential. The "requires auth env" guard validates the ChatGPT
  OAuth token is present in the **worker/sidecar** env (for the injector), not the
  container.
- **Claude:** unchanged (SYD-186).
`validateWorkerConfig` validates `engine`. New `npm run build:worker-image-codex`.

### G. Spike (gate, mirrors SYD-185)

Stand up `codex` locally, `codex login` (ChatGPT), and run `codex exec` through a
local mitmproxy with the CA trusted (system store). Confirm: (a) the exact host
and auth header Codex sends; (b) that a **placeholder auth.json** in the
container still lets `codex` issue the request while the proxy injects the real
token; (c) the injected `Authorization: Bearer` reaches the ChatGPT backend and
the session works; (d) **token lifetime / refresh** behavior — ChatGPT OAuth
access tokens expire; onecli injects statically with no mid-session refresh, so
the spike measures whether a session outlives the token and documents the risk.
Results pin §C's rule and §B's placeholder, then commit into this spec.

## Security invariants (preserved + added)

- Real ChatGPT OAuth token + the CA private key: only in `syd-egress`, never in a
  Codex container, never in argv. Container holds only a placeholder auth.json +
  the CA public cert.
- Injection hosts stay a **fixed table** — not caller-controlled.
- Domain allowlist (default-deny) unchanged for all non-provider egress.
- `SWITCHYARD_TOKEN` read by Codex via `bearer_token_env_var` — never in argv or
  the config file (SYD-83 contract, preserved).
- Codex containers get **no GitHub credentials** and push only `agent/<ref>`
  (container-entry contract, preserved).

## Testing

- **Unit (addon):** `injection_for` Codex host → Bearer with the real token;
  caller auth stripped; selftest extended.
- **Unit (`buildDockerArgs`):** Codex proxy mode → placeholder auth.json + CA
  mount + no real credential; the real token appears only in the sidecar run
  args; Claude path unchanged.
- **Unit (`ensureEgressGuard`):** the Codex token var is passed to the sidecar
  and named in `INJECT_KEYS`; recreate-on-change; CA never regenerated.
- **Unit (config):** `validateWorkerConfig` accepts `engine`, rejects unknown.
- **Unit (Codex adapter):** the `config.toml` builder + `codex exec` argv (ported
  from SYD-83's `runners/codex.ts` tests).
- **Integration (spike):** §G, against the real `codex` CLI + mitmproxy.
- **Manual acceptance:** dispatch a real `auto-codex` issue; confirm it produces
  its `agent/<ref>` PR (the injected OAuth path reaches the ChatGPT backend) AND
  `docker exec <ref> env` (+ the mounted auth.json) shows **no** real credential —
  only the placeholder + the CA. The SYD-186 acceptance, for Codex.

## Rollout & relationship to Gemini

1. Spike (§G) → pin the Codex injection rule + placeholder shape.
2. Build addon rule + `Dockerfile.worker.codex` + `container-entry.codex.sh` +
   `buildDockerArgs`/`ensureEgressGuard`/config, behind the existing
   containerized path (default engine = Claude; existing workers unaffected).
3. Prove via the manual acceptance; provision a `switchyard-worker.codex.json`
   worker + its launchd job as part of go-live (mirrors the SYD-186 worker-host
   go-live: pull main → `build:worker-image-codex` → start the codex worker).
4. **Gemini fast-follow (separate spec):** Google-login OAuth likely hits a
   different host (Code Assist API) with a different auth shape than the
   provisioned `x-goog-api-key` rule — its own spike + addon rule + Node-CLI CA
   trust (`NODE_EXTRA_CA_CERTS`, like Claude) + `engine: "gemini"`.

## Open questions

- **ChatGPT OAuth token source on the host:** `codex login` writes
  `${CODEX_HOME}/auth.json`; the real access token must be extracted into the
  worker/`.env` so `ensureEgressGuard` can hand it to the sidecar. The spike
  confirms the exact field + whether a refresh token must travel too.
- **Token refresh / session lifetime** (§G(d)) — if sessions can outlive the
  access token, decide between accepting the risk (short sessions, like onecli)
  or teaching the sidecar to refresh. Deferred to the spike's findings.
- **Codex host exactness:** `api.openai.com` vs `chatgpt.com`/backend-api for a
  ChatGPT-login session — pinned by the spike before the addon rule is finalized.
