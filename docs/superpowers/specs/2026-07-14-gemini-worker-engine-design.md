# Gemini containerized worker engine (design)

- **Date:** 2026-07-14
- **Status:** Draft — awaiting review
- **Project 2b of 2.** Adds the **Gemini** engine on top of the Project 1
  credential-injecting egress proxy (SYD-186, shipped) and alongside the
  **Codex** engine (SYD-187, `docs/superpowers/specs/2026-07-12-codex-worker-engine-design.md`).
- Depends on **SYD-220** (generalizes the `-e SWITCHYARD_LEASE` dispatch env from
  claude-only to all engines) — this spec's lease wiring assumes that generalization.
- **Auth decision (Sean, 2026-07-14):** the Gemini worker uses **AI-Studio
  API-key auth** (`GEMINI_API_KEY` → `x-goog-api-key`), *not* Google-login
  OAuth / Code Assist. This is the clean path: the injection rule is **already
  provisioned** in the SYD-186 addon, the key is static (injection-safe, no
  refresh), and it matches the maintainer's active local config
  (`~/.gemini/settings.json` `security.auth.selectedType: "gemini-api-key"`).

## Context & goal

Switchyard's dispatch worker drives headless agent sessions in disposable
containers (`scripts/agent-worker.ts` → `buildDockerArgs` → `Dockerfile.worker*`
+ `container-entry*.sh`). Project 1 made the real provider credential never enter
the container: the `syd-egress` sidecar TLS-MITMs provider hosts and injects the
real credential; the container holds only a placeholder + the CA public cert.
SYD-187 added **Codex** as a second engine on the same pipeline.

**Goal:** add **Google Gemini CLI (`gemini --yolo --prompt`)** as a third engine
that reuses the entire dispatch pipeline (selection, retry, session reporting,
branch publish, delivery) and the same credential-injection posture — a Gemini
container holds no real provider credential. Auth is a **static AI-Studio API
key**, injected by the proxy exactly as the other providers' keys are.

Unlike Codex (which needed a live spike to pin an *unknown* ChatGPT-OAuth shape),
Gemini's request shape is **already pinned by construction** (§Spike results):
the egress rule exists and is selftested, the CLI is Node (so CA-trust mirrors
Claude), and the maintainer's active auth mode is API-key. No live call is spent.

## Non-goals

- **Google-login OAuth / Code Assist mode** (`cloudcode-pa.googleapis.com`,
  `Authorization: Bearer`, ~hourly token refresh). Chosen against in favor of the
  static API key — it would need refresh infrastructure in the proxy that does
  not exist. If ever needed, it is its own follow-up (new host rule + refresh).
- **The cursor engine** — a separate fast-follow (Sean, SYD-187 comment).
- **Metered-vs-free routing / model selection policy.** The worker uses Gemini's
  default model unless a config override is set; per-issue model routing is out.
- **Bare-host Gemini dispatch.** Containerized only — the injecting proxy is a
  containerized-dispatch concern.
- **Changing server-enforced governance.** Triage/done/dependency/lease rules are
  server-side and engine-agnostic; engines are worker-side dispatch only.

## Background: what exists today

- **Project 1 proxy (`scripts/egress-inject-addon.py`, `worker-select.ts`):**
  `syd-egress` runs mitmproxy + a host-keyed injection addon. The **Gemini rule
  is already provisioned and selftested**: `generativelanguage.googleapis.com`
  is in `PROVIDER_HOSTS`, `injection_for` returns
  `[("x-goog-api-key", env["GEMINI_API_KEY"])]`, and `x-goog-api-key` is in the
  caller-auth strip-list (`_AUTH_HEADERS`). `_selftest` already asserts it
  ("OpenAI / Gemini … the rules are provisioned now"). **No addon change.**
- **Codex engine (SYD-187):** established the per-engine-process model, the
  `engine` field on `WorkerConfig`, `Dockerfile.worker.codex`,
  `container-entry.codex.sh`, and the `buildDockerArgs` engine branch. This spec
  mirrors those directly.
- **SYD-220:** generalized `buildDockerArgs`'s lease env from
  `opts.leaseToken && engine === "claude"` to `opts.leaseToken` (all engines),
  so a leased Gemini container automatically receives `-e SWITCHYARD_LEASE`.
- **Dispatch is engine-agnostic:** selection/retry/resume/session-reporting/
  watchdog/branch-publish/delivery are untouched; the deltas are one config
  enum value, one Dockerfile, one entry script, one adapter, and a
  `buildDockerArgs` branch.

## Design

### A. Per-engine process + `engine` field

- Extend `engine?: "claude" | "codex"` → `"claude" | "codex" | "gemini"` on
  `WorkerConfig` (default `"claude"`). **One worker process per engine.**
- A Gemini worker runs with `engine: "gemini"`, its **own minted switchyard
  token**, and poll label **`auto-gemini`**. Routing uses the existing
  soft-affinity sort (SYD-201): the worker sets `dispatchPolicy: "all-todo"` and
  issues carry `worker_preference: "gemini"` (a triage decision) — a worker
  never starves when its own backlog is empty. No per-issue engine plumbing.
- `agent-worker.ts` runs the Gemini worker from a distinct config file
  (`switchyard-worker.gemini.json`), same as any other worker role.

### B. Credential model (Gemini = AI-Studio API key, proxy-injected)

- The **real `GEMINI_API_KEY` lives only in `syd-egress`**, never in a Gemini
  container.
- Injection host/header (already provisioned, §Background):
  **`generativelanguage.googleapis.com`**, header **`x-goog-api-key: <real key>`**;
  caller auth (`authorization`/`x-api-key`/`x-goog-api-key`) is stripped first.
- The Gemini container gets a **placeholder `GEMINI_API_KEY`** (proxy mode) so the
  CLI believes it is authenticated and issues the request; the proxy swaps in the
  real key over the wire. In **open** mode (no injecting sidecar) the real key is
  passed bare (`-e GEMINI_API_KEY`, value from the worker env, never argv).
- **Non-interactive auth selection:** set **`GEMINI_DEFAULT_AUTH_TYPE=gemini-api-key`**
  so the CLI does not present the interactive auth picker (the picker is what hung
  a bare `gemini --version` during recon). `GEMINI_SANDBOX=false` — the container
  is the sandbox, not gemini's own sandbox layer.
- **CA trust:** gemini is a **Node** binary → it honors **`NODE_EXTRA_CA_CERTS`**
  pointing at the mounted CA bundle (Claude's mechanism), not Codex's
  `SSL_CERT_FILE` and not `update-ca-certificates`.

### C. No addon change

Unlike Codex (which added a new `chatgpt.com` rule), the Gemini injection rule
already exists and is selftested. `PROVIDER_HOSTS`, `injection_for`, and
`_AUTH_HEADERS` are **untouched**. `ensureEgressGuard`/`PROVIDER_KEY_VARS`
already pass `GEMINI_API_KEY` into the sidecar and name it in the `INJECT_KEYS`
freshness sentinel (it was provisioned with the OpenAI/Gemini rules); confirm
during implementation and add it if absent. No new lifecycle machinery.

### D. MCP + lease wiring (`container-entry.gemini.sh`)

gemini-cli reads MCP servers from `settings.json` under `mcpServers`, supporting
the **`httpUrl`** (streamable HTTP) transport with a **`headers`** map, and it
**expands `$VAR`/`${VAR}`** in settings values (`resolveEnvVars`). So the entry
script writes a `0600 settings.json` under **`GEMINI_DIR=/tmp/gemini-home`** with:

```json
{
  "security": { "auth": { "selectedType": "gemini-api-key" } },
  "mcpServers": {
    "switchyard": {
      "httpUrl": "${SWITCHYARD_URL}/mcp",
      "headers": {
        "Authorization": "Bearer ${SWITCHYARD_TOKEN}",
        "X-Switchyard-Lease": "${SWITCHYARD_LEASE}"
      }
    }
  }
}
```

Because the header values are **env references, not literals**, the switchyard
token and the session lease **never appear in the file or in argv** — the same
security property Codex gets from `bearer_token_env_var`/`env_http_headers`
(SYD-220), achieved here via gemini's native env expansion. The env vars stay
exported so gemini reads them at connect time (they are *not* unset). The
`X-Switchyard-Lease` line is written **only when `SWITCHYARD_LEASE` is set**
(leased dispatch under SYD-210); absent for answer/non-lease sessions, matching
`container-entry.sh`/`container-entry.codex.sh`.

The rest of `container-entry.gemini.sh` mirrors `container-entry.codex.sh`:
clone `/origin`→`/work`, `BASE_BRANCH` fetch + `agent/<ref>` checkout,
`prime-workspace-trust`, `npm ci` guard, stack checks, `NODE_EXTRA_CA_CERTS` from
the mounted `/ca`, run the session, commit-count gate, `agent/<ref>`-only push.

### E. Container contract

- **`Dockerfile.worker.gemini`** — mirrors `Dockerfile.worker.codex`: base image,
  `RUN npm install -g @google/gemini-cli`, drops to a non-root user, ships
  `prime-workspace-trust.mjs`/`npm-ci-guard.mjs`/`stack-check.mjs`. No CA-trust
  tooling install needed (Node honors `NODE_EXTRA_CA_CERTS`, like the Claude
  image).
- **Headless invocation:** `gemini --yolo --prompt "$WORKER_PROMPT"` (full-auto,
  non-interactive; the container is the sandbox). Exact flag spelling
  (`--yolo` / `--approval-mode`, `--prompt` / `-p`) is confirmed against the
  installed CLI at implementation time.
- The engine-agnostic `buildContainerizedPrompt` is **reused** — it describes the
  task and the switchyard MCP tools (same tool names for Gemini).

### F. Engine adapter (`scripts/engines/gemini.ts`)

Pure builders, mirroring `scripts/engines/codex.ts`:
- `DEFAULT_GEMINI_BINARY = "gemini"`, `DEFAULT_GEMINI_IMAGE = "switchyard-worker-gemini"`.
- `GEMINI_API_KEY_VAR`, `GEMINI_DEFAULT_AUTH_TYPE_VAR`, `SWITCHYARD_LEASE_HEADER`
  (shared with codex) constants.
- `buildGeminiSettingsJson(switchyardUrl, { tokenEnvVar?, leaseEnvVar? })` →
  the `settings.json` string in §D (lease header line present only when
  `leaseEnvVar` is given).
- `buildGeminiExecArgs(prompt)` → `["--yolo", "--prompt", prompt]`.

### G. Dispatch wiring (`buildDockerArgs`)

`buildDockerArgs` gains a `gemini` branch:
- **image** default `switchyard-worker-gemini` (`DEFAULT_GEMINI_IMAGE`).
- **credArgs, proxy mode:** `-e GEMINI_API_KEY=placeholder` + the read-only CA
  mount; **open mode:** `-e GEMINI_API_KEY` (real, from worker env). Plus
  `-e GEMINI_DEFAULT_AUTH_TYPE=gemini-api-key` and `-e GEMINI_SANDBOX=false` in
  both modes.
- **lease:** no change — SYD-220 already added `-e SWITCHYARD_LEASE` for all
  engines when `opts.leaseToken` is present; `container-entry.gemini.sh` (§D)
  consumes it.
- the "requires auth env" guard validates `GEMINI_API_KEY` is present in the
  **worker/sidecar** env (for the injector) in proxy mode, not the container.
- `validateWorkerConfig` accepts `engine: "gemini"`, rejects unknown. New
  `npm run build:worker-image-gemini`.

## Security invariants (preserved + added)

- Real `GEMINI_API_KEY` + the CA private key: only in `syd-egress`, never in a
  Gemini container, never in argv. Container holds only a placeholder key + the
  CA public cert.
- Injection hosts stay a **fixed table** — not caller-controlled (unchanged).
- Domain allowlist (default-deny) unchanged for all non-provider egress.
- `SWITCHYARD_TOKEN` and `SWITCHYARD_LEASE` reach gemini via env-expanded
  `settings.json` headers — **names in the file, values only in the env**, never
  in argv or the file (parity with Codex per SYD-220).
- Gemini containers get **no GitHub credentials** and push only `agent/<ref>`
  (container-entry contract, preserved).

## Testing

- **Unit (`gemini.ts` adapter):** `buildGeminiSettingsJson` emits
  `mcpServers.switchyard` with the `httpUrl` and the `Authorization` header;
  includes the `X-Switchyard-Lease` header only when a lease env var is given,
  omits it otherwise; the token/lease **values** never appear (only `${VAR}`
  references). `buildGeminiExecArgs` → `["--yolo","--prompt",prompt]`.
- **Unit (`buildDockerArgs`):** Gemini **proxy** mode → placeholder
  `GEMINI_API_KEY` + CA mount + no real key; the real key appears only in the
  sidecar run args; **open** mode → real `-e GEMINI_API_KEY`; both carry
  `GEMINI_DEFAULT_AUTH_TYPE`; leased → bare `-e SWITCHYARD_LEASE` (value never in
  argv); Claude/Codex paths unchanged.
- **Unit (config):** `validateWorkerConfig` accepts `engine: "gemini"`, rejects
  unknown.
- **Unit (addon):** unchanged — the existing Gemini selftest still passes (no
  addon edit).
- **Manual acceptance (go-live):** dispatch a real `auto-gemini` /
  `worker_preference: gemini` issue; confirm it produces its `agent/<ref>` PR
  (the injected `x-goog-api-key` path reaches `generativelanguage.googleapis.com`)
  AND `docker exec <ref> env` shows **no** real key — only the placeholder + the
  CA. The SYD-186 acceptance, for Gemini. Under a lease-enforcing tracker,
  confirm the session's `update_issue`/`in_review` succeed (the `${SWITCHYARD_LEASE}`
  header authorizes them), mirroring SYD-220's codex residual.

## Rollout

1. Build `scripts/engines/gemini.ts` + `Dockerfile.worker.gemini` +
   `container-entry.gemini.sh` + the `buildDockerArgs` branch + config enum,
   behind the existing containerized path (default engine = Claude; existing
   workers unaffected). No addon change.
2. `npm run verify` (CI mirror) green; unit tests per §Testing.
3. Prove via the manual acceptance; provision a `switchyard-worker.gemini.json`
   worker + its launchd job as part of go-live (mirrors the SYD-186/187
   worker-host go-live: pull main → `build:worker-image-gemini` → start the
   gemini worker). Depends on SYD-220 landing first for leased dispatch.

## Spike results (resolved by construction — 2026-07-14)

No live API call was spent; the four dimensions a Codex-style spike pins are
already fixed by existing artifacts + the maintainer's environment:

- **Injection host = `generativelanguage.googleapis.com`; header =
  `x-goog-api-key`.** Pinned by the already-provisioned, selftested addon rule
  (`scripts/egress-inject-addon.py`: `PROVIDER_HOSTS`, `injection_for`,
  `_selftest`).
- **Token lifetime = static** (AI-Studio API key). No refresh — the injection-safe
  case; strictly simpler than Codex's ~10-day OAuth JWT.
- **CA trust = `NODE_EXTRA_CA_CERTS`.** gemini-cli is Node
  (`@google/gemini-cli/dist/index.js`), so it uses the same mechanism as the
  Claude image, confirming SYD-187's hypothesis.
- **MCP config = `settings.json` `mcpServers` with `httpUrl` + `headers`, with
  `$VAR` expansion.** Confirmed in the installed CLI (`httpUrl`, `"headers"`,
  `resolveEnvVars`), enabling the values-in-env-only property of §D.
- **Headless flags = `--yolo --prompt`** (`nonInteractive`, `approval-mode`,
  `--yolo`, `--prompt` present in the installed CLI). Exact spelling reconfirmed
  at implementation time.
- **Auth-picker hang:** a bare `gemini` startup blocks on interactive auth
  selection; `GEMINI_DEFAULT_AUTH_TYPE=gemini-api-key` (env) forces the mode
  non-interactively — folded into §B/§G.

Environment basis (maintainer's host, 2026-07-14): active auth
`security.auth.selectedType: "gemini-api-key"`, `GEMINI_API_KEY` set,
`@google/gemini-cli` on Node 24.
