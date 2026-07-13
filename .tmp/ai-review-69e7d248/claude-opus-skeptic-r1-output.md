# The Skeptic — Review of PR #152 (SYD-210 Layer B: session-scoped claim lease heartbeats)

Scope: correctness, lease lifecycle/security (token out of transcript/argv), host-claim-vs-container-claim resolution, heartbeat/expiry race arithmetic, test coverage. Every file:line below was read this session.

## Arithmetic & boundaries — verified CORRECT

- **Window = N × interval.** `HEARTBEAT_INTERVAL_MS = 60_000`, `HEARTBEAT_MISS_LIMIT = 10` (`scripts/worker-select.ts:414-415`); `claims.heartbeat_window_seconds` default `600` (`src/services/settings.ts:41`). 60 × 10 = 600. ✓
- **Heartbeat collapses the window.** Mint TTL = `8*3600 = 28800s` (`settings.ts:35`); `heartbeatLease` sets `expiresAt = now + 600` (`leases.ts:108`). 600 < 28800, so the first container heartbeat shortens 8h → 10min exactly as the design claims. ✓ The first `setInterval` tick fires at +60s (`worker-select.ts` cadence), so the claim keeps the full 8h window for the first ≤60s — no expiry gap before the first beat.
- **`heartbeatTick` cancel boundary.** `heartbeatTick(failures, ok, missLimit=10)` returns `cancel = (failures+1) >= missLimit` (`worker-select.ts:425-433`). It takes exactly 10 consecutive failures to cancel; any success resets to 0. The test walks `MISS_LIMIT-1=9` non-cancelling misses then a 10th that cancels (`tests/scripts/lease-heartbeat.test.ts:9-18`). ✓
- **Uptime gate boundary.** `expireLeases` skips the sweep when `now - serverStartedAt < 600` (`leases.ts:149-153`). Strict `<`: at exactly 600s the sweep runs. Test asserts `now-60`→0 (skip) and `now-601`→1 (resume) (`tests/services/lease-expiry.test.ts:49-52`). ✓ A 5–15s tracker restart is far inside the 600s grace, and a host only self-cancels after its own 600s of failures, so the two coincide rather than race. ✓
- **Per-spawn env, no collision.** `dispatch` passes `env: { ...process.env, SWITCHYARD_LEASE: opts.leaseToken }` to `spawn` (`agent-worker.ts:603-605`) — it does not mutate `process.env`, so concurrent containers get independent lease values. The comment's claim is correct. ✓
- **Token never in argv/transcript** (container + SDK paths): container gets bare `-e SWITCHYARD_LEASE` (name only) in `buildDockerArgs` (`worker-select.ts:401`), value injected via spawn env, then written to `/tmp/switchyard-mcp.json` as an MCP header by `container-entry.sh:351-355` — same handling as the already-trusted `SWITCHYARD_TOKEN`, never argv. SDK path sets the header in `sdk-runner.ts:936-937`. The model reads tool *results*, not the MCP config file, and `claim_issue` (which returns the token) is not called by dispatched sessions. ✓
- **Signature change is safe.** Only `webhook-dispatcher.ts:102` passes the new 3rd arg; every other `expireLeases` caller (all in tests) uses the 1–2 arg form, which is unchanged behavior. ✓

## MAJOR — findings

### M1. Default (bare-host, `runner:"cli"`, non-containerized) dispatch is broken: session is told "don't claim" but no lease is injected

`WorkerConfig.containerized` is optional with no default (`worker-select.ts:151`) and `runner` defaults to `"cli"` (`agent-worker.ts:574`). So the **default** dispatch path is the bare-host `claude -p` branch (`agent-worker.ts:607-634`).

Lease injection exists on exactly two paths: container (spawn env → `container-entry.sh` header) and SDK (`sdk-runner.ts` header). The bare-host CLI `spawn("claude", …)` at `agent-worker.ts:619-634` has **no** `env: { SWITCHYARD_LEASE }` and no way to add an MCP header — that session inherits the host's stored MCP config (worker bearer token, no lease header).

Meanwhile both prompts were changed to forbid re-claiming (`agent-worker.ts:221` buildPrompt; `worker-select.ts:379` containerized prompt). Trace the bare-host session:
1. `runTick` claims via `claimIssueHost`, mints lease L1 for the worker actor, passes `leaseToken` to `dispatch` (`agent-worker.ts:1015-1019`).
2. The `claude -p` session is told *not* to call `claim_issue`.
3. It calls `update_issue → in_review`. Server sees `connectionLeaseToken = undefined` (no header) and no `lease_token` arg → `updateIssue` lease validation **rejects** it (`leases.ts:72-86`).
4. It cannot recover by re-claiming: the same-actor active-lease guard throws "already has an active lease held by this actor" without `takeover` (`issues.ts:526-533`).

So a bare-host session can no longer complete its claim-scoped writes. Production is containerized (per project notes), so prod is unaffected — but this is the *default* config combination, and the change silently breaks it. Recommend either gating the no-reclaim prompt + injection to container/SDK modes, or explicitly guarding/ documenting bare-host CLI as unsupported-for-leases (e.g. skip lease injection AND keep the "call claim_issue first + takeover" prompt for that mode).

### M2. The `heartbeat` MCP tool is LLM-callable; an interactive session that calls it collapses its own 8h window to 600s

`heartbeat` is registered as a normal model-facing tool (`src/mcp/server.ts:471-484`) accepting an explicit `lease_token`. The design's load-bearing invariant is "an interactive session never heartbeats, so it keeps the long 8h TTL" (`leases.ts:93-95`, plan decision #1). That invariant is protected **only** by prose in the tool description ("you normally do NOT need to call it yourself") — nothing in the service enforces it.

An interactive/coordinating session holds its `lease_token` in-transcript (from `claim_issue`). If the model calls `heartbeat` even once, `heartbeatLease` sets `expiresAt = now + 600` (`leases.ts:106-111`) — a 48× reduction of its own safety window. If that session then goes idle >10min while `in_progress` (routine for human-in-the-loop work / compaction), `expireLeases` releases the claim → issue returns to `todo` → auto-dispatch picks it up. That is precisely the duplicate-work class this whole feature exists to prevent, now re-enabled *by* the feature.

This directly contradicts the project rule "keep them enforced in services (not just prompts)." Options: don't expose `heartbeat` as a model-facing MCP tool at all (host-only via REST/connection header), or reject a `heartbeat` whose caller presented an explicit `lease_token` tool-arg (only the connection-header form, i.e. the host, should renew). At minimum this trade-off should be explicitly accepted in writing.

## MINOR — findings

### m1. Two prompt tests now assert the *opposite* of the new intent yet still pass

`tests/scripts/agent-worker.test.ts:43` and `tests/scripts/worker-select.test.ts:1066` both assert `expect(prompt).toContain("claim_issue")`. The prompts changed from "Call claim_issue first" to "do not call claim_issue" — the substring `"claim_issue"` survives, so both tests stay green while no longer validating anything meaningful (they'd pass identically for the old and inverted instruction). Update them to assert the new instruction (e.g. `/do not call claim_issue/i` and `/already claimed for your session/i`) so a future accidental revert is caught.

### m2. No test covers the container lease-injection surface

There is no assertion that `buildDockerArgs` includes `-e SWITCHYARD_LEASE` when `opts.leaseToken` is set and omits it when absent (the existing `worker-select.test.ts:780-784` only covers `SWITCHYARD_TOKEN`). This is the security-relevant path (how the container carries its lease). A regression that dropped the `-e` line, or embedded the value inline, would not be caught. Cheap to add alongside the existing bare-`-e` test. Similarly nothing exercises `container-entry.sh`'s conditional header assembly (`container-entry.sh:351-355`).

### m3. Host-side timer/cancellation wiring is untested (acknowledged)

`startLeaseHeartbeat` (`agent-worker.ts`), `postHeartbeat`, and the SDK `externalAbortSignal` fold (`sdk-runner.ts:923-928`) have no unit coverage — only the pure `heartbeatTick` is tested. The plan explicitly calls this "integration-shaped," so this is a noted gap, not a blocker. One nit worth a line of coverage: `stop()` is referenced inside the `setInterval` callback before its `const` declaration (`agent-worker.ts` startLeaseHeartbeat body); this is safe only because the callback first fires at +60s, well after synchronous init — a comment or a test would document that assumption.

### m4. Lease lingers ~10min as "active" after a clean in_review handoff (cosmetic)

A container that finishes by moving to `in_review` does not invalidate its lease (invalidation only fires on moved-to-todo / takeover / human-answer — `issues.ts:341,539`, `comments.ts:56`). After exit, `stopHeartbeat()` stops beats and the lease sits `active` until `expires_at` (~last beat + 600s); the expiry sweep then finds the issue is no longer `in_progress`, makes 0 changes, and just marks the lease invalidated (`leases.ts:171-182`). Harmless, but means `getActiveLease` reports an active lease on an `in_review` issue for up to a window. Worth a one-line comment.

## HYPOTHESIS (not verified against a running system)

- **Crash-loop starves expiry.** If the tracker restarts more often than every 600s, `serverStartedAt` keeps resetting and `expireLeases` returns 0 every sweep (`leases.ts:149-153`) — no lease ever expires. Low severity: a sub-600s crash-loop is a larger outage and the dispatcher is barely functioning anyway. Flagging as a bounded consequence of the global-skip gate, not a finding.

## Summary

The core arithmetic (600 = 60×10 vs 28800 mint; strict-`<` uptime gate; 10-miss cancel) is internally consistent and correct, and the container/SDK token-handling keeps the lease out of argv and the transcript. Two behavioral issues should be resolved or explicitly signed off before merge: **M1** (the default bare-host CLI runner is broken by the no-reclaim prompt with no compensating injection) and **M2** (the interactive 8h invariant is prose-only and self-sabotageable via the model-facing `heartbeat` tool). The MINORs are low-effort hardening, notably the two stale prompt tests (m1) that pass against inverted intent.

VERDICT: REVISE — concerns above should be addressed first
