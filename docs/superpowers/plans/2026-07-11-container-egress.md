# Container Egress Allowlist + Token-Safe npm ci (SYD-110) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dispatch containers can only reach an explicit egress allowlist (tracker, Anthropic API, npm registry), and pre-session `npm ci` runs without the secret env vars — closing both token-exfiltration paths from SYD-110.

**Architecture:** A `docker network create --internal syd-workers` network (no direct egress) plus a tinyproxy sidecar (`syd-egress`) dual-homed on that network and the default bridge, filtering by domain allowlist (`FilterDefaultDeny`). Worker containers join the internal network with `HTTP_PROXY`/`HTTPS_PROXY` pointed at the sidecar — Claude Code, npm, and git(https) all honor these. Setup is idempotent and ensured at worker/deliver startup via an injected-exec helper (unit-testable). `npm-ci-guard.mjs` strips the three secret vars from the `npm ci` environment (chosen over `--ignore-scripts`, which would break native-module builds like better-sqlite3 in dispatched repos).

**Tech Stack:** Docker (OrbStack locally, Docker on NAS), tinyproxy on alpine, TypeScript/vitest. No new npm dependencies.

## Global Constraints

- Secrets never in argv: proxy/network args must not embed token values (they don't — only hostnames).
- Default egress mode is `"proxy"` when `containerized` is set; `egress: "open"` in switchyard-worker.json is the explicit escape hatch.
- Allowlist = `api.anthropic.com`, `registry.npmjs.org`, the host of `config.url`, plus optional `egressAllow: string[]` from config.
- Both container launch paths get the same treatment: `buildDockerArgs` (work sessions) and `buildConflictResolutionDockerArgs` (SYD-100 conflict resolution).
- `npm ci` runs with `SWITCHYARD_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` removed from its env — everything else passes through.
- Known residual risks documented, not solved here: Docker embedded-DNS exfil channel; covert channels via allowlisted hosts.
- Gates before any commit: `npm run typecheck && npm run build:ui && npm test`.

## File Structure

- Modify: `scripts/npm-ci-guard.mjs` — strip secret vars from `npm ci` env.
- Test: `tests/scripts/npm-ci-guard.test.ts` — extend.
- Modify: `scripts/worker-select.ts` — `EGRESS_*` constants, `egressEnvArgs`/network args in both docker-args builders, `egress`/`egressAllow` in `WorkerConfig`, new `renderTinyproxyConf(domains)` + `egressAllowlist(config)` + `ensureEgressGuard(config, exec)` helpers.
- Test: `tests/scripts/worker-select.test.ts` — extend for args builders + allowlist + tinyproxy config; new ensure tests with mocked exec.
- Modify: `scripts/agent-worker.ts`, `scripts/deliver.ts` — call `ensureEgressGuard` at startup when containerized + egress proxy mode.
- Create: `Dockerfile.egress-proxy` + `scripts/egress-proxy-entry.sh` — alpine + tinyproxy, conf rendered from `ALLOWED_DOMAINS` env at start.
- Modify: `package.json` `build:worker-image` — build both images.
- Modify: `scripts/init-worker.ts`/`init-worker-lib.ts` — validate `egress` config values (reject unknown).

## Key Interfaces

```ts
// worker-select.ts
export type WorkerConfig = { /* existing */ egress?: "proxy" | "open"; egressAllow?: string[] };
export const EGRESS_NETWORK = "syd-workers";
export const EGRESS_PROXY_NAME = "syd-egress";
export const EGRESS_PROXY_IMAGE = "switchyard-egress-proxy";
export const EGRESS_PROXY_PORT = 8888;
export function egressAllowlist(config: WorkerConfig): string[];      // sorted, deduped
export function egressMode(config: WorkerConfig): "proxy" | "open";  // default "proxy"
export function renderTinyproxyConf(domains: string[]): string;
export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>;
export async function ensureEgressGuard(config: WorkerConfig, exec: ExecFn): Promise<void>;
```

Docker args added when mode is `"proxy"`: `--network syd-workers`, `-e HTTP_PROXY=http://syd-egress:8888`, `-e HTTPS_PROXY=...`, `-e http_proxy/https_proxy` lowercase variants (npm/git honor lowercase), `-e NO_PROXY=localhost,127.0.0.1`.

`ensureEgressGuard` idempotence: `docker network inspect` → create `--internal` if missing; `docker ps` filter for the proxy → if not running, `docker rm -f` leftovers then `docker run -d --restart unless-stopped --network bridge --name syd-egress -e ALLOWED_DOMAINS=<csv> switchyard-egress-proxy` then `docker network connect syd-workers syd-egress` (dual-home). If the allowlist changed (compare `docker inspect` env), recreate the proxy.

---

### Task 1: npm ci without secrets (TDD)
- [ ] Failing test: guard invokes `npm ci` with an env lacking the three secret vars but keeping PATH/others.
- [ ] Implement via `execFileSync("npm", ["ci"], { env: sanitized })`. Green. Commit.

### Task 2: egress config + docker args (TDD)
- [ ] Failing tests: `egressMode` defaults to "proxy", honors "open"; `egressAllowlist` = tracker host + built-ins + extras (sorted/deduped); `buildDockerArgs`/`buildConflictResolutionDockerArgs` include network+proxy args in proxy mode, omit them in open mode, never embed token values.
- [ ] Implement. Green. Commit.

### Task 3: tinyproxy config + ensureEgressGuard (TDD)
- [ ] Failing tests: `renderTinyproxyConf` emits FilterDefaultDeny + one anchored regex per domain + Listen/Port; `ensureEgressGuard` with mocked exec: creates missing network with `--internal`, starts missing proxy with ALLOWED_DOMAINS env + connects it, no-ops when both exist with same allowlist, recreates proxy when allowlist differs.
- [ ] Implement. Green. Commit.

### Task 4: wiring + image
- [ ] `Dockerfile.egress-proxy` + `scripts/egress-proxy-entry.sh` (render conf from env — same logic as renderTinyproxyConf, shell-side; entry writes conf then execs tinyproxy in foreground).
- [ ] Hook `ensureEgressGuard` into agent-worker + deliver startup (containerized + proxy mode only); extend `build:worker-image`; init-worker config validation for `egress`.
- [ ] Gates green. Commit.

### Task 5: live verification (local OrbStack docker)
- [ ] Build both images. Run ensureEgressGuard for real (tiny driver or the worker `--once` path). From a canary container on `syd-workers`: (a) direct `curl https://example.com` fails (no route), (b) `curl -x http://syd-egress:8888 https://api.anthropic.com` connects (TLS handshake reaches host), (c) `curl -x ... https://example.com` gets proxy 403. Record outputs.
- [ ] Docs note in README or docs/: egress model, escape hatch, residual DNS channel. Commit; SYD-110 comment + in_review.
