> Generated: 2026-07-08 | Token-lean format for LLM context

# Satellite processes (`scripts/`, `worker-sdk/`)

Everything here is a separate process from the main server; all talk to it over REST with an agent bearer token.

## Auto-dispatch worker (`scripts/agent-worker.ts`)

Polls for dispatchable issues and spawns headless Claude Code sessions on them.

```
tick (intervalSeconds, default 300s)        pollEvents (eventPollSeconds, 15s)
  GET /api/issues?status=todo&label=auto      GET /api/events → needs_input_cleared → fast re-dispatch
        │ selectDispatchable / filterRetryCapped (worker-select.ts)
        ▼
  dispatch → runner "cli":  claude -p  (bare host  |  docker if containerized:true)
             runner "sdk":  dispatchSdk → worker-sdk/sdk-runner.ts (in-process, no argv token)
        │
  logs → <repo>/.superpowers/worker-logs/<ref>.log ; pidfile lock .superpowers/worker.pid
```

- Config: `switchyard-worker.json` (`url, label, intervalSeconds, eventPollSeconds, maxConcurrent, projects{KEY→{repo}}, containerized, image, dispatchPolicy, runner`). Validated by `validateWorkerConfig` (`init-worker-lib.ts`).
- Human control point: only `todo` + configured label (`auto`) is ever picked up. Dispatched sessions can't move issues to `done` (server-enforced).
- Flags: `--once`, `--dry-run`. Token via `SWITCHYARD_TOKEN` or repo `.env` (0600).
- Pure logic lives in `scripts/worker-select.ts` (selection, resume detection, tick gating, retry caps, docker args, containerized prompt) — unit-tested in `tests/scripts/`.

### Containerized mode (`Dockerfile.worker`, `scripts/container-entry.sh`)

Host repo mounted at `/origin` (rw) → container clones to `/work`, checks out `agent/<ref>`, runs `claude -p`, pushes `agent/<ref>` back to `/origin` iff commits exist. No host FS beyond the mount, no GitHub creds in the container. Rebuild image after upgrading `@anthropic-ai/claude-code`: `npm run build:worker-image`.

**Egress + credentials (SYD-110/SYD-186):** sessions run on an `--internal` network whose only exit is the `syd-egress` sidecar — a TLS-intercepting mitmproxy (`Dockerfile.egress-proxy`, `scripts/egress-inject-addon.py`) that injects the real provider credential by host and allowlists the rest, refusing everything else. The real keys + the CA private key live only in the sidecar (`ensureEgressGuard` passes them + a persisted CA volume, recreating on key-set change); the agent container holds only `CLAUDE_CODE_OAUTH_TOKEN=placeholder` + the CA public cert (`-v syd-egress-ca:/ca:ro`, `NODE_EXTRA_CA_CERTS` in `container-entry.sh`), never the real key (`buildDockerArgs`). `egress: "open"` opts out — real key passed bare, no sidecar.

### SDK runner (`worker-sdk/`)

`runSdkSession` drives the Claude Agent SDK in-process; MCP token handed over as an in-memory object; one log line per tool call (`sdk-format.ts`). Isolated deps (zod@4): `npm install --prefix worker-sdk`. Not combinable with `containerized` yet.

## Worker doctor (`scripts/init-worker.ts` + `init-worker-lib.ts`)

`npm run init-worker` — checks config, repos, docker image, tokens, server reachability, and that the token is an *agent* actor. `--self-test` dry-run tick; `--install-launchd` writes + loads `~/Library/LaunchAgents/com.switchyard.worker.plist` (KeepAlive, no secrets in plist).

## Delivery worker (`scripts/deliver.ts`)

Merges + deploys agent work when a human stamps the issue done (SYD-49).
Polls `/api/events` (`delivery.pollSeconds`, 30s) for `status_changed→done`
(human-only, server-enforced) → merges open `agent/<ref>` PR via `gh` →
deploys `npm run deploy` from a clean clone (`delivery.cloneDir`, default
`~/.switchyard/deliver-clones/<KEY>`) → comments merge SHA + deploy result.
No open agent PR ⇒ skip (interactive work merges directly). Cursor persists in
`.superpowers/deliver-cursor`; lock `.superpowers/deliver.pid`. Pure logic in
`scripts/delivery-lib.ts`, exec in `scripts/delivery-exec.ts`. The dispatch
worker publishes `agent/<ref>` → PR on container exit (`delivery.openPrs`).

## Webhook consumers

- Dispatcher (in-server): `services/webhook-dispatcher.ts`, 2s poll from `webhookCursor`, best-effort POST, HMAC header when secret set.
- Slack notifier (`scripts/slack-notifier.ts` + `slack-format.ts`): standalone HTTP listener (:3301) registered as a webhook; forwards triage filings, needs-input, in_review to `SLACK_WEBHOOK_URL`; verifies `SWITCHYARD_WEBHOOK_SECRET`.

## The Dreamer (`scripts/dreamer.sh`, `prompts/dreamer.md`)

Nightly (launchd 04:30, `launchd/com.switchyard.dreamer.plist`) headless session: reads last 24h of `/api/events` + board, writes digest to `~/.claude/dreams/switchyard-YYYY-MM-DD.md`, files ≤3 findings into triage. Read-and-file only — never modifies existing issues. `DREAMER_DRY_RUN=1` = digest only.

## Deploy (`scripts/deploy-nas.sh`)

`npm run deploy`: tar working tree (excludes node_modules, .git, .superpowers, dist, *.db, .env, switchyard-worker.json) → ssh NAS `100.85.158.109` → `sudo -n /usr/local/bin/switchyard-deploy` rebuilds the container.
