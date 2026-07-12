# Credential-Injecting Egress Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the tinyproxy egress sidecar with a TLS-intercepting proxy that both domain-allowlists general egress and injects real provider credentials into outbound API calls via MITM, so agent containers never hold real provider keys — proven end-to-end on the Claude worker.

**Architecture:** One sidecar (`syd-egress`) runs `mitmproxy` with a header-injection addon. Agent containers proxy all egress through it (`HTTP(S)_PROXY`, unchanged) and trust its CA. For provider hosts the proxy terminates TLS, strips the caller's auth header, injects the real credential, and re-encrypts to the real provider; for allowlisted non-provider hosts it tunnels un-intercepted; everything else is refused. Real keys and the CA private key live only in the sidecar; agent containers get a placeholder credential + the CA public cert.

**Tech Stack:** mitmproxy (Python addon), Docker, TypeScript (`scripts/worker-select.ts` + Vitest for the Docker-args/lifecycle logic).

## Global Constraints

- **Real provider credentials AND the CA private key appear only in the `syd-egress` container** — never in an agent container, never in any process argv. Agent containers hold only the CA **public** cert + a placeholder credential.
- **Injection hosts are a fixed table** (`api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`), never caller-controlled.
- **Anthropic rule:** `sk-ant-oat*` → `Authorization: Bearer <token>`; `sk-ant-api*` → `x-api-key: <token>` + remove `authorization`. Caller auth header always stripped before injection. (Confirmed from onecli `apps/gateway/src/secret_inject.rs`.)
- **Domain allowlist stays default-deny** for all non-provider egress.
- **Bodies stream** (LLM APIs are SSE) — never buffer.
- **The CA is stable/persisted** — never regenerated on a sidecar recreate (that breaks container trust).
- **`SWITCHYARD_TOKEN` handling unchanged** — stays an env var in the agent container.
- Spec: `docs/superpowers/specs/2026-07-12-credential-injecting-egress-proxy-design.md`.

---

## File Structure

- Create `scripts/egress-inject-addon.py` — the mitmproxy addon: the fixed host→injection rules (with the `sk-ant-oat`/`sk-ant-api` branch), the default-deny allowlist decision for non-intercepted hosts, and a `--selftest` block of pure-function assertions (no pytest dependency).
- Modify `Dockerfile.egress-proxy` — base on mitmproxy, add the addon + a CA-load/persist entrypoint.
- Create `scripts/egress-proxy-entry.sh` — **repurposed** (was tinyproxy): load-or-generate the persisted CA, then `exec mitmdump` with the addon, allowlist, and provider keys from env.
- Modify `scripts/container-entry.sh` — install the mounted CA public cert into the trust store + export `NODE_EXTRA_CA_CERTS` before `claude -p`.
- Modify `scripts/worker-select.ts` — `ensureEgressGuard` (ensure CA; pass provider keys to sidecar; recreate on allowlist/key-set change), `buildDockerArgs` (Claude: drop real cred, add placeholder + CA-cert mount).
- Modify `tests/scripts/worker-select.*.test.ts`.
- Modify `codemaps/workers.md`.

---

## Task 1: Spike — mitmproxy addon + Claude OAuth through MITM (gate)

**Files:**
- Modify: `docs/superpowers/specs/2026-07-12-credential-injecting-egress-proxy-design.md` (fold results into §A/§H; resolve the "Open questions" implementation-engine item)

**Interfaces:**
- Produces: a confirmed, minimal mitmproxy addon shape (`request(flow)` hook rewriting `flow.request.headers`) and the exact CA-trust steps a Node CLI needs (`NODE_EXTRA_CA_CERTS` path + system-store install), captured in the spec.

- [ ] **Step 1: Stand up mitmproxy locally with a trivial inject addon.** `pip install mitmproxy` (or `pipx`/`uvx`), write a 10-line addon that, for `flow.request.pretty_host == "api.anthropic.com"`, sets `flow.request.headers["authorization"] = "Bearer <REAL_OAUTH_TOKEN>"`. Run `mitmdump -s addon.py --listen-port 8888`.

- [ ] **Step 2: Trust the CA and run Claude Code through it.** Export the mitmproxy CA (`~/.mitmproxy/mitmproxy-ca-cert.pem`), then run `HTTPS_PROXY=http://127.0.0.1:8888 NODE_EXTRA_CA_CERTS=~/.mitmproxy/mitmproxy-ca-cert.pem CLAUDE_CODE_OAUTH_TOKEN=placeholder claude -p "say hi"`. Confirm: the session completes, and the addon log shows the request to `api.anthropic.com` with the injected bearer.

- [ ] **Step 3: Confirm the OAuth token-exchange survives MITM.** Verify Claude Code's OAuth flow (the "token exchange" the SDK does with the placeholder) works end-to-end through the intercept — if it needs extra headers preserved, note them. Cross-check against onecli's `secret_inject.rs` behavior.

- [ ] **Step 4: Write results into the spec** — pin the addon hook shape, the CA-trust steps, and mark §H resolved / choose the implementation engine. Commit.

```bash
git add docs/superpowers/specs/2026-07-12-credential-injecting-egress-proxy-design.md
git commit -m "docs: resolve MITM/mitmproxy spike for egress proxy (Task 1)"
```

> **Gate:** Task 2's rule module is written generically, but any Claude-OAuth-specific header nuance comes from this task.

---

## Task 2: mitmproxy injection addon + allowlist

**Files:**
- Create: `scripts/egress-inject-addon.py`
- Test: self-contained `--selftest` (run via `python3 scripts/egress-inject-addon.py --selftest`)

**Interfaces:**
- Produces (pure functions, importable + self-tested):
  - `injection_for(host: str, env: Mapping[str,str]) -> list[tuple[str,str|None]] | None` — returns header ops `(name, value|None)` (`None` = remove) for a provider host, else `None`. Anthropic branch reads `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` and picks by `sk-ant-oat`/`sk-ant-api` prefix; openai/gemini read their keys.
  - `host_allowed(host: str, allowlist: set[str]) -> bool` — exact, case-insensitive (mirrors the old anchored-ERE semantics: no substring matches).
  - a mitmproxy `request(flow)` hook applying `injection_for`, and a `http_connect(flow)`/`tls_clienthello` gate that refuses/`kill()`s hosts that are neither a provider nor allowlisted.

- [ ] **Step 1: Write the addon with pure functions + a `--selftest` block.**

```python
#!/usr/bin/env python3
"""mitmproxy addon: inject real provider credentials, default-deny the rest.
Real keys come from the proxy container's env; agent containers never hold them.
"""
import os, sys
from collections.abc import Mapping

PROVIDER_HOSTS = {"api.anthropic.com", "api.openai.com", "generativelanguage.googleapis.com"}

def injection_for(host: str, env: Mapping) -> list | None:
    h = host.lower()
    if h == "api.anthropic.com":
        tok = env.get("CLAUDE_CODE_OAUTH_TOKEN") or env.get("ANTHROPIC_API_KEY") or ""
        if tok.startswith("sk-ant-oat"):
            return [("authorization", f"Bearer {tok}")]
        return [("x-api-key", tok), ("authorization", None)]
    if h == "api.openai.com":
        return [("authorization", f"Bearer {env.get('OPENAI_API_KEY','')}")]
    if h == "generativelanguage.googleapis.com":
        return [("x-goog-api-key", env.get("GEMINI_API_KEY",""))]
    return None

def host_allowed(host: str, allowlist: set) -> bool:
    return host.lower() in {a.lower() for a in allowlist}

def _apply(headers, ops):
    # strip any caller-supplied auth first, then apply injected ops
    for k in ("authorization", "x-api-key", "x-goog-api-key"):
        if k in headers: del headers[k]
    for name, value in ops:
        if value is None:
            if name in headers: del headers[name]
        else:
            headers[name] = value

# --- mitmproxy hooks (only imported when run under mitmdump) ---
def request(flow):  # noqa: ANN001
    ops = injection_for(flow.request.pretty_host, os.environ)
    if ops is not None:
        _apply(flow.request.headers, ops)

def _selftest():
    a = injection_for("api.anthropic.com", {"CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat-XYZ"})
    assert a == [("authorization", "Bearer sk-ant-oat-XYZ")], a
    b = injection_for("api.anthropic.com", {"ANTHROPIC_API_KEY": "sk-ant-api-XYZ"})
    assert b == [("x-api-key", "sk-ant-api-XYZ"), ("authorization", None)], b
    assert injection_for("evil.example.com", {}) is None
    assert host_allowed("registry.npmjs.org", {"registry.npmjs.org"})
    assert not host_allowed("registry.npmjs.org.attacker.net", {"registry.npmjs.org"})
    print("selftest ok")

if __name__ == "__main__":
    if "--selftest" in sys.argv:
        _selftest()
```

- [ ] **Step 2: Run the selftest — verify it passes.**

Run: `python3 scripts/egress-inject-addon.py --selftest`
Expected: `selftest ok`.

- [ ] **Step 3: Add the connect-time allowlist gate.** Implement the `http_connect`/`tls_clienthello` hook: if the target host is neither in `PROVIDER_HOSTS` nor in the `ALLOWED_DOMAINS` env allowlist, `flow.kill()` (default-deny). Confirm the addon loads under `mitmdump -s scripts/egress-inject-addon.py` without error.

Run: `ALLOWED_DOMAINS=registry.npmjs.org mitmdump -s scripts/egress-inject-addon.py --listen-port 8899 &` then a quick allowed vs disallowed CONNECT probe; stop it.
Expected: allowed host tunnels; disallowed host is killed.

- [ ] **Step 4: Commit.**

```bash
git add scripts/egress-inject-addon.py
git commit -m "feat: mitmproxy credential-injection + allowlist addon (Task 2)"
```

---

## Task 3: Proxy image — mitmproxy + addon + persisted CA

**Files:**
- Modify: `Dockerfile.egress-proxy`
- Modify (repurpose): `scripts/egress-proxy-entry.sh`

**Interfaces:**
- Produces: image `switchyard-egress-proxy` running `mitmdump` on 8888 with the addon, reading provider keys + `ALLOWED_DOMAINS` from env, and loading a **persisted** CA from a mounted volume (`/home/mitmproxy/.mitmproxy`) — generating it once if absent.

- [ ] **Step 1: Rewrite `Dockerfile.egress-proxy`** to base on `mitmproxy/mitmproxy` (or `python:3.12-slim` + `pip install mitmproxy`), `COPY scripts/egress-inject-addon.py` and `scripts/egress-proxy-entry.sh`, non-root, `ENTRYPOINT ["/entry.sh"]`.

- [ ] **Step 2: Rewrite `scripts/egress-proxy-entry.sh`** to: require `ALLOWED_DOMAINS`; ensure the CA dir exists (mitmproxy auto-generates the CA on first run into `~/.mitmproxy`, persisted via the volume); `exec mitmdump --listen-host 0.0.0.0 --listen-port 8888 -s /egress-inject-addon.py --set block_global=false`. (Verify the exact mitmdump flags for headless/allow-proxied-hosts during implementation.)

- [ ] **Step 3: Build the image.** Run: `docker build -f Dockerfile.egress-proxy -t switchyard-egress-proxy .` — Expected: builds clean.

- [ ] **Step 4: Smoke-test** with a named volume for the CA and a dummy allowlist (no real keys): confirm `mitmdump` starts, writes `mitmproxy-ca-cert.pem` into the volume, and an allowed-host CONNECT tunnels. Stop the container.

- [ ] **Step 5: Commit.**

```bash
git add Dockerfile.egress-proxy scripts/egress-proxy-entry.sh
git commit -m "feat: egress-proxy image runs mitmproxy with injection addon + persisted CA (Task 3)"
```

---

## Task 4: CA trust in the agent container

**Files:**
- Modify: `scripts/container-entry.sh`

**Interfaces:**
- Consumes: a read-only mount of the CA public cert at a known path (e.g. `/ca/mitmproxy-ca-cert.pem`).
- Produces: the CA installed into the trust store + `NODE_EXTRA_CA_CERTS` exported before `claude -p`.

- [ ] **Step 1: Add CA-trust setup** near the top of `container-entry.sh` (after the clone, before `claude -p`): if `/ca/mitmproxy-ca-cert.pem` exists, `cp` it into `/usr/local/share/ca-certificates/switchyard-egress.crt` + `update-ca-certificates` (needs root or a pre-baked writable dir — verify against the non-root `node` user; may instead rely solely on `NODE_EXTRA_CA_CERTS` for the Node-based Claude CLI), and `export NODE_EXTRA_CA_CERTS=/ca/mitmproxy-ca-cert.pem`.

```sh
# Trust the egress proxy's CA so intercepted TLS to provider hosts verifies.
if [ -f /ca/mitmproxy-ca-cert.pem ]; then
  export NODE_EXTRA_CA_CERTS=/ca/mitmproxy-ca-cert.pem
fi
```

- [ ] **Step 2: Verify** (deferred to Task 7's live run) that Claude Code honors `NODE_EXTRA_CA_CERTS` for the intercepted connection. Note in the script comment that Codex (Rust, Project 2) will need the system-store install instead.

- [ ] **Step 3: Commit.**

```bash
git add scripts/container-entry.sh
git commit -m "feat: agent container trusts the egress proxy CA (Task 4)"
```

---

## Task 5: `ensureEgressGuard` — CA + provider keys + recreate-on-change

**Files:**
- Modify: `scripts/worker-select.ts`
- Test: `tests/scripts/worker-select.egress.test.ts`

**Interfaces:**
- Produces: `injectKeyEnvArgs(env): string[]` (bare `-e VAR` for each present provider key: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`); a CA volume/mount constant; `ensureEgressGuard` now runs the sidecar with the CA volume + those keys and recreates it when the **key-var set** changes (sentinel env `INJECT_KEYS=<sorted,names>`), never regenerating the CA.

- [ ] **Step 1: Write failing tests** (extend the injected-`exec` pattern already used for `ensureEgressGuard`): the sidecar `docker run` args include the CA volume mount and `-e CLAUDE_CODE_OAUTH_TOKEN` when present; omit `-e OPENAI_API_KEY` when absent; a change in the present key-var set triggers `rm -f` + recreate; the CA volume is never removed/regenerated on recreate.

- [ ] **Step 2: Run — verify fail.**

- [ ] **Step 3: Implement.** Add `injectKeyEnvArgs`; mount a named CA volume (e.g. `syd-egress-ca:/home/mitmproxy/.mitmproxy`) on the sidecar; bake `INJECT_KEYS=<sorted key-var names>` as the freshness sentinel (names only, never values); extend `inspectProxy().sameKeys` to compare it; keep the race-tolerant structure.

- [ ] **Step 4: Run — verify pass.**

- [ ] **Step 5: Commit.**

```bash
git add scripts/worker-select.ts tests/scripts/worker-select.egress.test.ts
git commit -m "feat: egress sidecar holds keys + persisted CA; recreate on key-set change (Task 5)"
```

---

## Task 6: `buildDockerArgs` — placeholder + CA mount, drop real cred (Claude)

**Files:**
- Modify: `scripts/worker-select.ts`
- Test: `tests/scripts/worker-select.test.ts`

**Interfaces:**
- Produces: for a containerized Claude dispatch, the agent-container argv includes `-e CLAUDE_CODE_OAUTH_TOKEN=placeholder`, a **read-only** CA-cert mount (`-v syd-egress-ca:/ca:ro` or a cert-file mount), the existing `HTTP(S)_PROXY` egress args, and **excludes** any real Anthropic credential.

- [ ] **Step 1: Write failing tests.**

```ts
it("Claude agent container gets a placeholder + CA mount and no real credential", () => {
  const args = buildDockerArgs(issue, project, config, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-REAL" } as NodeJS.ProcessEnv);
  const joined = args.join(" ");
  expect(joined).toContain("CLAUDE_CODE_OAUTH_TOKEN=placeholder");
  expect(joined).not.toContain("sk-ant-oat-REAL");            // real value never crosses into the agent container
  expect(joined).toMatch(/-v [^ ]*egress-ca[^ ]*:\/ca:ro/);   // CA mounted read-only
  const passesRealCred = args.some((a, i) => a === "-e" && args[i+1] === "CLAUDE_CODE_OAUTH_TOKEN"); // bare passthrough of the real var
  expect(passesRealCred).toBe(false);
});
```

- [ ] **Step 2: Run — verify fail.**

- [ ] **Step 3: Implement.** In `buildDockerArgs` (Claude path): remove the real-cred `-e CLAUDE_CODE_OAUTH_TOKEN`/`-e ANTHROPIC_API_KEY` passthrough; add `-e CLAUDE_CODE_OAUTH_TOKEN=placeholder` and `-v <ca-volume>:/ca:ro`; keep `egressDockerArgs`. Update the "requires auth env" guard to validate the key is present in the **worker/sidecar** env (for the injector), not in the agent container.

- [ ] **Step 4: Run — verify pass.** Also `npx vitest run tests/scripts/`.

- [ ] **Step 5: Commit.**

```bash
git add scripts/worker-select.ts tests/scripts/worker-select.test.ts
git commit -m "feat: Claude agent container uses MITM proxy; placeholder + CA, no real key (Task 6)"
```

---

## Task 7: End-to-end acceptance + codemap

**Files:**
- Modify: `codemaps/workers.md`

- [ ] **Step 1: Full gate.** `npm run typecheck` and `npm test`; both green.

- [ ] **Step 2: Bring up the guard.** Start the worker (or call the guard directly): `ensureEgressGuard` stands up `syd-egress` (mitmproxy + addon + CA volume + real Anthropic cred in the sidecar env + `ALLOWED_DOMAINS`). Confirm `docker ps` shows it and the CA volume holds `mitmproxy-ca-cert.pem`.

- [ ] **Step 3: Dispatch a real Claude SYD issue** (containerized). Confirm it produces its `agent/<ref>` PR — i.e. the intercepted+injected OAuth path reaches Anthropic and the session works with the CA trusted.

- [ ] **Step 4: Prove the key is absent from the agent container.** `docker exec <syd-ref> env | grep -Ei 'anthropic|claude'` shows **only** `CLAUDE_CODE_OAUTH_TOKEN=placeholder` (+ `NODE_EXTRA_CA_CERTS`) — no real credential. Capture as acceptance evidence and attach to the tracking issue (visual-verification norm).

- [ ] **Step 5: Update `codemaps/workers.md`** — egress line now reads "TLS-intercepting mitmproxy: injects provider creds by host, allowlists the rest; agent containers hold only a placeholder + the CA public cert." Commit.

```bash
git add codemaps/workers.md
git commit -m "docs: codemap note for intercepting egress proxy (Task 7)"
```

---

## Self-Review

**Spec coverage:**
- §A intercepting proxy (MITM provider hosts, tunnel allowlist, refuse rest) → Tasks 2 (addon) + 3 (image). ✅
- §B host-keyed injection table (oat/api branch, openai, gemini) → Task 2. ✅
- §C credential model (keys+CA-priv only in sidecar; placeholder + CA-pub in agent) → Tasks 5 + 6; proven in Task 7 Step 4. ✅
- §D CA lifecycle/trust distribution → Task 3 (persist/generate) + Task 4 (trust in agent) + Task 5 (CA volume, never regen). ✅
- §E networking (all egress via proxy; no base-URL/NO_PROXY special case) → unchanged `egressDockerArgs`, asserted in Task 6. ✅
- §F lifecycle → Task 5. ✅
- §G Claude retrofit + acceptance → Tasks 4/6 + Task 7. ✅
- §H spike → Task 1 (gate). ✅
- Testing section → Task 2 selftest, Task 5/6 vitest, Task 3 smoke, Task 7 manual. ✅
- OpenAI/Gemini rules provisioned but not exercised (Project 2) → Task 2 covers them; no engine wiring. ✅

**Placeholder scan:** the literal string `placeholder` is the *intended* container credential (onecli's pattern), not a plan gap. mitmdump flags (Task 3), CA-trust-under-non-root specifics (Task 4), and any Claude-OAuth header nuance (Task 1) are confirmed in-task against the real tools — flagged honestly, not hand-waved. No "TBD/handle errors/similar to". ✅

**Type/name consistency:** `injection_for` / `host_allowed` / `_apply` (Task 2), `injectKeyEnvArgs` / `INJECT_KEYS` sentinel / CA volume `syd-egress-ca` (Tasks 5–6) used consistently. The Anthropic `sk-ant-oat`→Bearer / `sk-ant-api`→x-api-key rule is identical in the Global Constraints, §B, and Task 2 code. ✅

**Implementation-verification notes (honest gaps):** exact `mitmdump` flags for headless + allow-arbitrary-proxied-hosts (Task 3), CA install under the non-root user vs `NODE_EXTRA_CA_CERTS`-only (Task 4), and the Claude-OAuth-through-MITM confirmation (Task 1) are validated against the live tools in their tasks.
