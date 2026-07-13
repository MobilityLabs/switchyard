# Codex Containerized Worker Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenAI Codex CLI (`codex exec`) as a second containerized worker engine that reuses the whole dispatch pipeline and the SYD-186 credential-injection posture — a Codex container holds no real provider credential, authenticating via the user's ChatGPT subscription login injected by the `syd-egress` proxy.

**Architecture:** Per-engine worker process selected by an `engine` field on `WorkerConfig`. The real ChatGPT OAuth token lives only in `syd-egress`, which MITMs the ChatGPT host and injects it; the Codex container gets a placeholder `auth.json` + the CA in its system trust store. Deltas are contained: a new addon injection rule, an `engine` config field, a `buildDockerArgs` branch, one Dockerfile, one entry script.

**Tech Stack:** TypeScript (`scripts/worker-select.ts`, Vitest), Python (mitmproxy addon, `--selftest`), Docker, shell (POSIX `sh`), the `codex` CLI.

## Global Constraints

- **Real ChatGPT OAuth token AND the CA private key appear only in `syd-egress`** — never in a Codex container, never in argv. The container holds only a placeholder `auth.json` + the CA public cert.
- **Injection hosts are a fixed table** — never caller-controlled.
- **`SWITCHYARD_TOKEN`** is read by Codex via `bearer_token_env_var` — never in argv or the config file. Stays a bare `-e` passthrough.
- **Codex is a Rust binary:** CA trust is via the **system store** (`update-ca-certificates`), NOT `NODE_EXTRA_CA_CERTS`.
- **Domain allowlist stays default-deny;** bodies stream (SSE); the CA is stable/persisted (never regenerated on recreate) — all inherited from SYD-186 unchanged.
- **Default engine stays `claude`** — existing workers are untouched; `engine: "codex"` is additive.
- Spec: `docs/superpowers/specs/2026-07-12-codex-worker-engine-design.md`.

## File Structure

- Modify `scripts/egress-inject-addon.py` — add the Codex host → ChatGPT-OAuth injection rule + selftest cases (Task 2).
- Create `scripts/engines/codex.ts` — pure Codex builders (`buildCodexConfigToml`, `buildCodexExecArgs`) + constants (Task 3). Ported from the stranded `agent/SYD-83:scripts/runners/codex.ts`, minus the API-key auth.
- Modify `scripts/worker-select.ts` — `engine` field on `WorkerConfig`, the Codex OAuth var in `PROVIDER_KEY_VARS` (Task 4), the `buildDockerArgs` engine branch (Task 5).
- Modify `scripts/init-worker-lib.ts` — validate `engine` (Task 4).
- Create `Dockerfile.worker.codex` + `scripts/container-entry.codex.sh`; modify `package.json` (`build:worker-image-codex`) (Task 6).
- Modify `tests/scripts/worker-select.test.ts`, `tests/scripts/worker-select.egress.test.ts`, `tests/init-worker-lib.test.ts`, create `tests/scripts/engines/codex.test.ts`.
- Modify `codemaps/workers.md` (Task 7).

---

## Task 1: Spike — Codex ChatGPT-login through MITM (gate)

**Files:**
- Modify: `docs/superpowers/specs/2026-07-12-codex-worker-engine-design.md` (fold results into §B/§C/§G; resolve the "Open questions")

**Interfaces:**
- Produces: the exact **injection host** (e.g. `chatgpt.com`), the **auth header** Codex sends, confirmation that a **placeholder `auth.json`** lets `codex` issue the request while the proxy injects, and the **token-refresh/lifetime** finding — all captured in the spec as pinned values Tasks 2/5/6 consume.

- [ ] **Step 1: Install Codex and log in.** `npm i -g @openai/codex` (or the documented install), then `codex login` (ChatGPT). Locate `${CODEX_HOME:-~/.codex}/auth.json` and note its fields (access token, refresh token, expiry).

- [ ] **Step 2: Run `codex exec` through a local mitmproxy with the CA trusted.** Reuse the SYD-186 addon locally: `ALLOWED_DOMAINS=<host> mitmdump -s scripts/egress-inject-addon.py --listen-port 8888`. With the mitmproxy CA installed into the OS trust store, run `HTTPS_PROXY=http://127.0.0.1:8888 codex exec "say hi" --ask-for-approval never` and capture, from the mitmdump flow log, the **exact host + auth header** Codex sends.

- [ ] **Step 3: Confirm placeholder-auth + injection.** Replace `auth.json`'s token with a placeholder string; add a temporary addon rule injecting the *real* token for that host; confirm `codex exec` completes (proves the onecli placeholder pattern works end-to-end through the MITM). Cross-check against onecli's Codex handling.

- [ ] **Step 4: Measure token lifetime.** Note the access-token expiry from `auth.json`; decide whether a typical session outlives it (documented risk) or a refresh is needed.

- [ ] **Step 5: Write results into the spec and commit.** Pin the host constant, the header, the placeholder shape, and the refresh decision in §B/§C/§G.

```bash
git add docs/superpowers/specs/2026-07-12-codex-worker-engine-design.md
git commit -m "docs: resolve Codex ChatGPT-login MITM spike (Task 1)"
```

> **Gate:** Task 2's host constant and Task 6's placeholder `auth.json` come from this task. Tasks 3–5 (config/argv/docker plumbing) are engine-mechanics and can proceed in parallel with the spike; Tasks 2 and 6 consume its output.

---

## Task 2: Codex injection rule in the addon

**Files:**
- Modify: `scripts/egress-inject-addon.py`
- Test: the file's `--selftest` block (`python3 scripts/egress-inject-addon.py --selftest`)

**Interfaces:**
- Consumes: the injection host from Task 1 (below shown as `chatgpt.com` — replace with the spike-pinned value).
- Produces: `injection_for` returns the ChatGPT-OAuth Bearer op for the Codex host, reading `CODEX_OAUTH_TOKEN` from the proxy env.

- [ ] **Step 1: Add the Codex host to `PROVIDER_HOSTS` and a branch in `injection_for`.** In `scripts/egress-inject-addon.py`, add the constant and rule (host string = the Task 1 value):

```python
# add to PROVIDER_HOSTS (Task 1 pins the exact host for a ChatGPT-login session)
CODEX_HOST = "chatgpt.com"
PROVIDER_HOSTS = {
    "api.anthropic.com",
    "api.openai.com",
    "generativelanguage.googleapis.com",
    CODEX_HOST,
}
```

In `injection_for`, add before the final `return None`:

```python
    if h == CODEX_HOST:
        # ChatGPT subscription-login OAuth: inject the real access token the
        # proxy holds (extracted from `codex login`'s auth.json on the host).
        return [("authorization", f"Bearer {env.get('CODEX_OAUTH_TOKEN', '')}")]
```

- [ ] **Step 2: Extend the selftest.** Add to `_selftest()`:

```python
    assert injection_for("chatgpt.com", {"CODEX_OAUTH_TOKEN": "cxo-TOK"}) == [
        ("authorization", "Bearer cxo-TOK")], "codex"
    assert connect_decision("chatgpt.com", set()) == "mitm"  # provider host, always intercepted
```

- [ ] **Step 3: Run the selftest — verify it passes.**

Run: `python3 scripts/egress-inject-addon.py --selftest`
Expected: `selftest ok`

- [ ] **Step 4: Commit.**

```bash
git add scripts/egress-inject-addon.py
git commit -m "feat: mitmproxy injects Codex ChatGPT-login OAuth by host (Task 2)"
```

---

## Task 3: Codex adapter — pure builders

**Files:**
- Create: `scripts/engines/codex.ts`
- Test: `tests/scripts/engines/codex.test.ts`

**Interfaces:**
- Produces: `buildCodexConfigToml(switchyardUrl, tokenEnvVar?) -> string`, `buildCodexExecArgs(prompt) -> string[]`, and constants `DEFAULT_CODEX_IMAGE = "switchyard-worker-codex"`, `CODEX_BEARER_TOKEN_ENV_VAR = "SWITCHYARD_TOKEN"`, `CODEX_OAUTH_TOKEN_VAR = "CODEX_OAUTH_TOKEN"`.

- [ ] **Step 1: Write the failing test.**

```ts
// tests/scripts/engines/codex.test.ts
import { describe, it, expect } from "vitest";
import {
  buildCodexConfigToml,
  buildCodexExecArgs,
  DEFAULT_CODEX_IMAGE,
  CODEX_BEARER_TOKEN_ENV_VAR,
} from "../../../scripts/engines/codex.js";

describe("codex engine builders", () => {
  it("writes an MCP config.toml that names the token env var, never the token", () => {
    const toml = buildCodexConfigToml("http://host:3300/");
    expect(toml).toContain("[mcp_servers.switchyard]");
    expect(toml).toContain('url = "http://host:3300/mcp"');
    expect(toml).toContain('bearer_token_env_var = "SWITCHYARD_TOKEN"');
    expect(toml).not.toMatch(/Bearer |token = /);
  });

  it("builds a headless codex exec argv (container is the sandbox)", () => {
    // Spike (Task 1): codex 0.142.5 dropped --ask-for-approval; headless
    // full-auto is --dangerously-bypass-approvals-and-sandbox.
    expect(buildCodexExecArgs("do the thing")).toEqual([
      "exec", "--dangerously-bypass-approvals-and-sandbox", "do the thing",
    ]);
  });

  it("exposes the codex image + bearer var constants", () => {
    expect(DEFAULT_CODEX_IMAGE).toBe("switchyard-worker-codex");
    expect(CODEX_BEARER_TOKEN_ENV_VAR).toBe("SWITCHYARD_TOKEN");
  });
});
```

- [ ] **Step 2: Run — verify it fails.**

Run: `npx vitest run tests/scripts/engines/codex.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `scripts/engines/codex.ts`.**

```ts
// OpenAI Codex CLI engine adapter (SYD-187). Ported from the stranded
// agent/SYD-83:scripts/runners/codex.ts, minus its API-key auth: auth here is
// the user's ChatGPT login, injected by the syd-egress proxy (the container
// holds only a placeholder auth.json), so no provider key is passed in-container.
//
// Codex reads MCP config from $CODEX_HOME/config.toml (not a CLI flag) with a
// dedicated bearer_token_env_var key — the token name, never its value, so the
// bearer never appears in the file or in argv.

export const DEFAULT_CODEX_BINARY = "codex";
export const DEFAULT_CODEX_IMAGE = "switchyard-worker-codex";

/** Env var Codex is told (via bearer_token_env_var) to read the switchyard MCP token from at run time. */
export const CODEX_BEARER_TOKEN_ENV_VAR = "SWITCHYARD_TOKEN";

/** Proxy-held ChatGPT OAuth token the syd-egress sidecar injects for the Codex host (secret). */
export const CODEX_OAUTH_TOKEN_VAR = "CODEX_OAUTH_TOKEN";

/** ChatGPT account UUID (NON-secret) codex sends as the chatgpt-account-id header; goes in the container's placeholder auth.json. */
export const CODEX_ACCOUNT_ID_VAR = "CODEX_ACCOUNT_ID";

export function buildCodexConfigToml(
  switchyardUrl: string,
  tokenEnvVar: string = CODEX_BEARER_TOKEN_ENV_VAR,
): string {
  const url = `${switchyardUrl.replace(/\/$/, "")}/mcp`;
  return `[mcp_servers.switchyard]\nurl = "${url}"\nbearer_token_env_var = "${tokenEnvVar}"\n`;
}

// Spike (Task 1): headless full-auto in codex 0.142.5 (the container is the
// sandbox). `--ask-for-approval never` was removed in this version.
export function buildCodexExecArgs(prompt: string): string[] {
  return ["exec", "--dangerously-bypass-approvals-and-sandbox", prompt];
}
```

- [ ] **Step 4: Run — verify it passes.**

Run: `npx vitest run tests/scripts/engines/codex.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit.**

```bash
git add scripts/engines/codex.ts tests/scripts/engines/codex.test.ts
git commit -m "feat: Codex engine pure builders (config.toml + exec argv) (Task 3)"
```

---

## Task 4: `engine` config field + Codex OAuth var in the guard

**Files:**
- Modify: `scripts/worker-select.ts` (add `engine` to `WorkerConfig`; add the Codex var to `PROVIDER_KEY_VARS`)
- Modify: `scripts/init-worker-lib.ts` (validate `engine`)
- Test: `tests/scripts/worker-select.egress.test.ts`, `tests/init-worker-lib.test.ts`

**Interfaces:**
- Consumes: `CODEX_OAUTH_TOKEN_VAR` (Task 3).
- Produces: `WorkerConfig.engine?: "claude" | "codex"`; `PROVIDER_KEY_VARS` includes `CODEX_OAUTH_TOKEN`, so `ensureEgressGuard` passes it to the sidecar + names it in `INJECT_KEYS`.

- [ ] **Step 1: Write the failing test** (egress) — add to `tests/scripts/worker-select.egress.test.ts`:

```ts
it("passes the Codex OAuth token into the sidecar when present", async () => {
  const { calls, exec } = mockExec(({ args }) => {
    if (args[0] === "network" && args[1] === "inspect") return new Error("no such network");
    if (args[0] === "inspect") return new Error("no such container");
    return "";
  });
  await ensureEgressGuard(config, exec, { CODEX_OAUTH_TOKEN: "cxo-REAL" } as NodeJS.ProcessEnv);
  const run = calls.find((c) => c.args[0] === "run")!;
  const passes = run.args.some((a, i) => a === "-e" && run.args[i + 1] === "CODEX_OAUTH_TOKEN");
  expect(passes).toBe(true);
  expect(run.args.join(" ")).toContain("INJECT_KEYS=CODEX_OAUTH_TOKEN");
  expect(run.args.join(" ")).not.toContain("cxo-REAL");
});
```

- [ ] **Step 2: Run — verify it fails.**

Run: `npx vitest run tests/scripts/worker-select.egress.test.ts`
Expected: FAIL (`INJECT_KEYS` empty; `-e CODEX_OAUTH_TOKEN` absent).

- [ ] **Step 3: Implement.** In `scripts/worker-select.ts`, add `CODEX_OAUTH_TOKEN` to `PROVIDER_KEY_VARS`:

```ts
export const PROVIDER_KEY_VARS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "CODEX_OAUTH_TOKEN",
] as const;
```

And add the `engine` field to the `WorkerConfig` type (near `runner`/`containerized`):

```ts
  /** Which agent engine this worker drives: "claude" (default) or "codex". Selected per-worker-process. */
  engine?: "claude" | "codex";
```

- [ ] **Step 4: Run — verify the egress test passes.**

Run: `npx vitest run tests/scripts/worker-select.egress.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing config-validation test** — add to `tests/init-worker-lib.test.ts`:

```ts
it("rejects an unknown engine", () => {
  const problems = validateWorkerConfig({ ...baseConfig, engine: "gpt5" });
  expect(problems.join(" ")).toMatch(/engine/);
});
it("accepts engine: codex", () => {
  expect(validateWorkerConfig({ ...baseConfig, engine: "codex" })).toEqual([]);
});
```

(Use the file's existing `baseConfig`/valid-config fixture; if none, construct a minimal valid config inline matching the other tests.)

- [ ] **Step 6: Run — verify it fails, then implement the check** in `scripts/init-worker-lib.ts` (near the `runner` check):

```ts
  if (c.engine !== undefined && c.engine !== "claude" && c.engine !== "codex") {
    problems.push('`engine` must be "claude" or "codex"');
  }
```

- [ ] **Step 7: Run — verify pass.** `npx vitest run tests/init-worker-lib.test.ts tests/scripts/worker-select.egress.test.ts`

- [ ] **Step 8: Commit.**

```bash
git add scripts/worker-select.ts scripts/init-worker-lib.ts tests/scripts/worker-select.egress.test.ts tests/init-worker-lib.test.ts
git commit -m "feat: engine config field + Codex OAuth var in the egress guard (Task 4)"
```

---

## Task 5: `buildDockerArgs` — Codex engine branch

**Files:**
- Modify: `scripts/worker-select.ts`
- Test: `tests/scripts/worker-select.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_CODEX_IMAGE` (Task 3), `WorkerConfig.engine` (Task 4), `EGRESS_CA_VOLUME` (SYD-186).
- Produces: for `engine: "codex"` proxy mode, argv = the `switchyard-worker-codex` image + a read-only CA mount + egress args + bare `SWITCHYARD_TOKEN`, and **no** real provider credential and **no** Claude placeholder. The placeholder `auth.json` is written in-container (Task 6).

- [ ] **Step 1: Write the failing test** — add to the `buildDockerArgs` describe in `tests/scripts/worker-select.test.ts`:

```ts
it("codex engine: image + CA mount, no real credential and no Claude placeholder (SYD-187)", () => {
  const args = buildDockerArgs(
    issue({ ref: "SYD-1" }),
    project,
    { ...config, engine: "codex" },
    { CODEX_OAUTH_TOKEN: "cxo-REAL" } as NodeJS.ProcessEnv,
  );
  const joined = args.join(" ");
  expect(args[args.length - 1]).toBe("switchyard-worker-codex");
  expect(joined).toMatch(/-v [^ ]*egress-ca[^ ]*:\/ca:ro/);
  expect(joined).not.toContain("cxo-REAL");
  expect(joined).not.toContain("CLAUDE_CODE_OAUTH_TOKEN"); // no Claude cred/placeholder on the codex path
  const passesToken = args.some((a, i) => a === "-e" && args[i + 1] === "CODEX_OAUTH_TOKEN");
  expect(passesToken).toBe(false); // real token stays in the sidecar, not the container
  const passesAcct = args.some((a, i) => a === "-e" && args[i + 1] === "CODEX_ACCOUNT_ID");
  expect(passesAcct).toBe(true); // non-secret account UUID goes to the container (for auth.json)
  expect(args).toContain("SWITCHYARD_TOKEN"); // scoped token still bare-passed
});
```

- [ ] **Step 2: Run — verify it fails.**

Run: `npx vitest run tests/scripts/worker-select.test.ts`
Expected: FAIL (default image + Claude placeholder present).

- [ ] **Step 3: Implement the engine branch in `buildDockerArgs`.** Add `import { DEFAULT_CODEX_IMAGE } from "./engines/codex.js";` at the top. Replace the auth-guard + `image`/`credArgs` computation so it branches on engine:

```ts
  const engine = config.engine ?? "claude";

  if (engine === "claude" && !env.CLAUDE_CODE_OAUTH_TOKEN && !env.ANTHROPIC_API_KEY) {
    throw new Error(
      "containerized Claude dispatch requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in the worker's environment",
    );
  }
  if (engine === "codex" && !env.CODEX_OAUTH_TOKEN) {
    throw new Error(
      "containerized Codex dispatch requires CODEX_OAUTH_TOKEN in the worker's environment (the injector's ChatGPT token)",
    );
  }

  const image =
    config.image ?? (engine === "codex" ? DEFAULT_CODEX_IMAGE : DEFAULT_WORKER_IMAGE);
```

Then set `credArgs` per engine (replacing the current Claude-only proxy/open computation):

```ts
  const proxy = egressMode(config) === "proxy";
  const credArgs =
    engine === "codex"
      // The container always gets the non-secret account UUID (for the
      // placeholder auth.json's chatgpt-account-id). Proxy mode: the sidecar
      // injects the real token, container gets only the CA — no real token, no
      // CLAUDE placeholder. Open mode (no sidecar): the real token in-container.
      ? [
          "-e", "CODEX_ACCOUNT_ID",
          ...(proxy
            ? ["-v", `${EGRESS_CA_VOLUME}:/ca:ro`]
            : ["-e", "CODEX_OAUTH_TOKEN"]),
        ]
      : proxy
        ? ["-e", "CLAUDE_CODE_OAUTH_TOKEN=placeholder", "-v", `${EGRESS_CA_VOLUME}:/ca:ro`]
        : ["-e", "CLAUDE_CODE_OAUTH_TOKEN", "-e", "ANTHROPIC_API_KEY"];
```

Ensure the `return [...]` array uses this `image` and `...credArgs` (already wired for Claude in SYD-186 — only the computation above changes).

- [ ] **Step 4: Run — verify pass, and the Claude tests still pass.**

Run: `npx vitest run tests/scripts/worker-select.test.ts`
Expected: PASS (new codex test + all existing Claude tests).

- [ ] **Step 5: Commit.**

```bash
git add scripts/worker-select.ts tests/scripts/worker-select.test.ts
git commit -m "feat: buildDockerArgs Codex branch — codex image + CA, no real key (Task 5)"
```

---

## Task 6: Codex container image + entry script

**Files:**
- Create: `Dockerfile.worker.codex`
- Create: `scripts/container-entry.codex.sh`
- Modify: `package.json` (add `build:worker-image-codex`)

**Interfaces:**
- Consumes: the mounted CA at `/ca/mitmproxy-ca-cert.pem` (SYD-186), the placeholder-`auth.json` shape from Task 1.
- Produces: image `switchyard-worker-codex` whose entrypoint clones/branches/pushes like `container-entry.sh` but installs the CA into the **system trust store**, writes a placeholder `auth.json` + the switchyard `config.toml`, and runs `codex exec`.

- [ ] **Step 1: Create `scripts/container-entry.codex.sh`** — mirror the current `scripts/container-entry.sh` (read it first for the exact clone/`BASE_BRANCH`/prime-trust/`npm ci`/stack-check/push-gate blocks) with these engine deltas:

```sh
#!/bin/sh
# Container entrypoint for the Codex engine (SYD-187) — the codex-exec
# counterpart of container-entry.sh. Same contract: clone /origin -> /work,
# branch agent/<ref>, push only if commits, no host FS beyond the mount, no
# GitHub creds. Auth is the user's ChatGPT login, injected by the syd-egress
# proxy — this container holds only a placeholder auth.json + the CA.
#
# Required env: ISSUE_REF, SWITCHYARD_URL, SWITCHYARD_TOKEN, WORKER_PROMPT.
set -eu
: "${ISSUE_REF:?ISSUE_REF is required}"
: "${SWITCHYARD_URL:?SWITCHYARD_URL is required}"
: "${SWITCHYARD_TOKEN:?SWITCHYARD_TOKEN is required}"
: "${WORKER_PROMPT:?WORKER_PROMPT is required}"

# Trust the egress proxy CA. Spike (Task 1): codex (Rust) honors SSL_CERT_FILE —
# no system-store install needed (contrast container-entry.sh's NODE_EXTRA_CA_CERTS).
if [ -f /ca/mitmproxy-ca-cert.pem ]; then
  export SSL_CERT_FILE=/ca/mitmproxy-ca-cert.pem
fi

git config --global --add safe.directory /origin
git clone /origin /work
cd /work
node /prime-workspace-trust.mjs /work

BASE_BRANCH="${BASE_BRANCH:-main}"
git fetch origin "$BASE_BRANCH"
git checkout -b "agent/$ISSUE_REF" "origin/$BASE_BRANCH"
INITIAL_HEAD=$(git rev-parse HEAD)
git config user.name "switchyard-worker"
git config user.email "worker@switchyard.local"

if [ -f package.json ]; then node /npm-ci-guard.mjs /work; fi
if [ -n "${STACK_CHECKS:-}" ] && [ -f scripts/stack-check.mjs ]; then
  node scripts/stack-check.mjs || exit 1
fi

# Codex reads MCP config + auth from $CODEX_HOME. The token name (not value)
# goes in config.toml. The placeholder auth.json (spike Task 1) carries the REAL
# account_id (non-secret — codex sends it as the chatgpt-account-id header, which
# the backend matches against the injected token's account) + a PLACEHOLDER
# access_token; the proxy injects the real Authorization: Bearer.
: "${CODEX_ACCOUNT_ID:?CODEX_ACCOUNT_ID is required (the non-secret ChatGPT account UUID)}"
export CODEX_HOME=/tmp/codex-home
mkdir -p "$CODEX_HOME"
cat > "$CODEX_HOME/config.toml" <<TOMLEOF
[mcp_servers.switchyard]
url = "$SWITCHYARD_URL/mcp"
bearer_token_env_var = "SWITCHYARD_TOKEN"
TOMLEOF
chmod 600 "$CODEX_HOME/config.toml"
cat > "$CODEX_HOME/auth.json" <<AUTHEOF
{"OPENAI_API_KEY":null,"tokens":{"id_token":"placeholder","access_token":"placeholder","refresh_token":"placeholder","account_id":"$CODEX_ACCOUNT_ID"},"last_refresh":"2026-01-01T00:00:00Z"}
AUTHEOF
chmod 600 "$CODEX_HOME/auth.json"

# Headless full-auto — the container is the sandbox (spike Task 1; the old
# --ask-for-approval never was removed in codex 0.142.5).
set +e
codex exec --dangerously-bypass-approvals-and-sandbox "$WORKER_PROMPT" < /dev/null
CODEX_EXIT=$?
set -e

COMMIT_COUNT=$(git rev-list "$INITIAL_HEAD"..HEAD --count)
if [ "$COMMIT_COUNT" -gt 0 ]; then
  git push origin "agent/$ISSUE_REF"
  echo "pushed branch agent/$ISSUE_REF with $COMMIT_COUNT commit(s)"
else
  echo "no commits produced"
fi
exit "$CODEX_EXIT"
```

(Replace the `auth.json` stub line with the exact placeholder shape pinned in Task 1 — inline it if it's a fixed literal.)

- [ ] **Step 2: Syntax-check the entry script.**

Run: `sh -n scripts/container-entry.codex.sh`
Expected: no output (valid).

- [ ] **Step 3: Create `Dockerfile.worker.codex`.** Read `Dockerfile.worker` first and mirror it (base image, non-root user, the `/prime-workspace-trust.mjs` + `/npm-ci-guard.mjs` copies, git/node toolchain), plus: install the `codex` CLI and `COPY scripts/container-entry.codex.sh /entry.sh`. Keep `ENTRYPOINT ["/bin/sh", "/entry.sh"]`. (No CA tooling needed — the entry script points `SSL_CERT_FILE` at the mounted cert, per the Task 1 spike.)

- [ ] **Step 4: Add the build script** to `package.json` `scripts`:

```json
"build:worker-image-codex": "docker build -f Dockerfile.worker.codex -t switchyard-worker-codex ."
```

- [ ] **Step 5: Build the image (needs Docker + `codex` install layer).**

Run: `npm run build:worker-image-codex`
Expected: builds clean. (If Docker/registry is unavailable in the environment, defer to the Task 7 acceptance run and note it.)

- [ ] **Step 6: Commit.**

```bash
git add Dockerfile.worker.codex scripts/container-entry.codex.sh package.json
git commit -m "feat: Codex worker image + entry (system-store CA, placeholder auth.json) (Task 6)"
```

---

## Task 7: End-to-end acceptance + codemap

**Files:**
- Create: `switchyard-worker.codex.json` (worker config; not committed if it holds host specifics — treat like `switchyard-worker.json`, which is deploy-excluded)
- Modify: `codemaps/workers.md`

- [ ] **Step 1: Full gate.** `npm run typecheck`, `npm run build:ui`, `npm test` — all green.

- [ ] **Step 2: Provision the Codex worker (host).** From `codex login`'s `auth.json`: `CODEX_OAUTH_TOKEN=$(jq -r .tokens.access_token ~/.codex/auth.json)` (secret) and `CODEX_ACCOUNT_ID=$(jq -r .tokens.account_id ~/.codex/auth.json)` (non-secret) into the worker `.env`. Write `switchyard-worker.codex.json` with `engine: "codex"`, `label: "auto-codex"`, `containerized: true`, `egressAllow: ["github.com"]` (spike: codex reaches github.com), and its own minted token. Use the **real** codex binary path (not a cmux temp-dir shim) for the launchd job. Kick the egress guard so `ensureEgressGuard` recreates `syd-egress` with `INJECT_KEYS` now including `CODEX_OAUTH_TOKEN`. **Token refresh:** the access token lives ~10 days — a periodic re-extract into `.env` (or a login refresh) keeps it valid; note this in the worker doctor.

- [ ] **Step 3: Dispatch a real `auto-codex` issue.** Confirm it produces its `agent/<ref>` PR — i.e. the injected ChatGPT-OAuth path reaches the backend and `codex exec` works with the CA trusted.

- [ ] **Step 4: Prove no real credential in the container.** `docker exec <syd-ref> env` and inspect `$CODEX_HOME/auth.json` — the real token must be **absent** (only the placeholder + the CA). Capture as acceptance evidence and attach to SYD-187.

- [ ] **Step 5: Update `codemaps/workers.md`** — note the Codex engine: `engine: "codex"` worker, `auto-codex` label, `switchyard-worker-codex` image, system-store CA trust, ChatGPT-OAuth injected by `syd-egress`. Commit.

```bash
git add codemaps/workers.md
git commit -m "docs: codemap note for the Codex worker engine (Task 7)"
```

---

## Self-Review

**Spec coverage:**
- §A per-engine process + `engine` field → Task 4 (field) + Task 5 (dispatch branch) + Task 7 (worker provisioning). ✅
- §B credential model (ChatGPT OAuth in sidecar; placeholder auth.json + CA in container) → Task 5 (no real cred, CA mount) + Task 6 (placeholder auth.json, system-store CA). ✅
- §C addon Codex rule → Task 2. ✅
- §D `ensureEgressGuard` Codex token var → Task 4. ✅
- §E container contract → Task 6. ✅
- §F `buildDockerArgs` branch → Task 5. ✅
- §G spike → Task 1 (gate). ✅
- Testing section → Task 2 selftest, Tasks 3/4/5 vitest, Task 7 manual. ✅

**Placeholder scan:** The word "placeholder" refers to the *intended* container `auth.json` (onecli's pattern), not a plan gap. The one spike-derived value (the injection host, shown as `chatgpt.com`) and the `auth.json` stub shape are explicitly produced by Task 1 and consumed by Tasks 2/6 — flagged, not hand-waved. No "TBD/handle errors/similar to". ✅

**Type/name consistency:** `CODEX_OAUTH_TOKEN` (var) / `CODEX_OAUTH_TOKEN_VAR` (constant) / `DEFAULT_CODEX_IMAGE = "switchyard-worker-codex"` / `buildCodexConfigToml` / `buildCodexExecArgs` / `engine: "claude" | "codex"` used identically across Tasks 3–6. `bearer_token_env_var = "SWITCHYARD_TOKEN"` matches the SYD-83 contract and Task 6's `config.toml`. ✅

**Honest implementation gaps:** the exact ChatGPT-login host + header, the placeholder `auth.json` shape, and token-refresh behavior are validated against the live `codex` CLI in Task 1 and consumed downstream; the image build + full dispatch (Tasks 6/7) need Docker + a real ChatGPT login.
