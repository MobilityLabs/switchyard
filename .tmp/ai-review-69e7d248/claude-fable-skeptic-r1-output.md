# Skeptic review — PR #152 (SYD-210 Layer B: claim lease heartbeats)

Reviewed the full diff plus post-diff source: `scripts/agent-worker.ts`, `scripts/worker-select.ts`, `scripts/container-entry.sh`, `src/services/leases.ts`, `src/services/issues.ts`, `src/mcp/server.ts`, `src/services/webhook-dispatcher.ts`. Every file:line below was read this session.

The service-layer mechanics (heartbeatLease, the pure `heartbeatTick`, the MCP/REST adapters, connection-level header injection) are clean and well-tested. The failures are all at the seams: the modes and restart paths the happy-path tests don't cover.

---

## CRITICAL 1 — CLI dispatch mode (the default runner) can no longer complete its workflow, and its only recovery path gets it killed

The lease reaches the session in containerized mode (spawn env → `-e SWITCHYARD_LEASE` → `container-entry.sh:125-129` MCP header) and SDK mode (`dispatchSdk` → `switchyardLeaseToken` → `sdk-runner.ts` header). The third mode — bare-host `claude -p`, i.e. `runner: "cli"` (the default: `agent-worker.ts:574` `(config.runner ?? "cli")`) with `containerized: false` — gets **nothing**: the else-branch spawn at `agent-worker.ts:619-634` passes no `--mcp-config`, no env var, no header. The session talks to switchyard through whatever static MCP config the host has, which carries only the shared bearer token.

Yet `buildPrompt` (`agent-worker.ts:441`) now tells that session "This issue is already claimed for your session — do not call claim_issue," and the code comment (`agent-worker.ts:437-440`) claims its "claim-scoped calls are authorized automatically." That is false in this mode. Its `update_issue → in_review` and `request_human_input` hit the hard cutover (`issues.ts:238-241` → `validateLease`, `leases.ts:79-85`) and are rejected — deterministically, every dispatch.

Trace the organic recovery: the rejection message (`leases.ts:81-84`) tells the session to "call claim_issue to (re)claim." If it disobeys the prompt and does so, `claimIssue` (`issues.ts:526-533`) refuses — but its error message *coaches* "Pass takeover: true to seize the claim." An LLM will follow that. Takeover invalidates the **host's** lease; the host's heartbeat loop (started unconditionally for CLI dispatches too, `agent-worker.ts:650-654`) then fails 10 consecutive beats and `killSession`s the CLI session ~10 minutes later — mid-work, after it "recovered."

On current main this mode works (prompt says claim first; takeover re-mint is stable because nothing heartbeats). This PR regresses it from working to a kill-trap. Either thread the lease into CLI mode (per-dispatch `--mcp-config` temp file, mirroring `container-entry.sh`), or make CLI dispatch refuse to run/log loudly under the lease regime, or keep the old claim-first prompt for this mode only.

## CRITICAL 2 — a worker restart orphans every live container's lease; contradicts the SYD-121 adopt contract this codebase explicitly promises

`killActiveSessions` (`agent-worker.ts:1080-1091` doc comment) deliberately leaves containers running across a worker restart: "the next startup's `reconcileContainerSessions` re-adopts it rather than losing the work to a restart." But the lease token lives only in the dead worker process's memory (`opts.leaseToken` closure). `adoptContainerSession` (`agent-worker.ts:1180-1233`) re-attaches exit handling via `docker wait` — and starts **no heartbeat**, because it has no token to beat with.

Runtime consequence, on the *documented* worker-host deploy procedure (`launchctl kickstart -k` with the tracker staying up — so the server-uptime gate does not apply, it protects tracker restarts only):

1. Container was dispatched >60s ago, so its lease has been heartbeated at least once → `expires_at` is already collapsed to last-beat + 600s.
2. Worker restarts, adopts the container, heartbeats stop.
3. ≤600s later `expireLeases` invalidates the lease and flips the issue to `todo`/unassigned (`leases.ts:164-190`) — while the container is alive and working.
4. The container's stale `X-Switchyard-Lease` header now fails `validateLease`: its `in_review` move and any escalation are rejected. Its work lands on the branch (the entry script pushes regardless) but the tracker state is stranded, and the now-`todo` issue is claimable/dispatchable by anyone outside this worker's in-memory `active` map.

So Layer B silently converts "containers survive worker restarts" into "containers survive at most ~10 minutes past a worker restart." Every routine worker deploy with in-flight sessions hits this. Options: persist a `ref → leaseToken` map to a 0600 file so reconciliation resumes heartbeats (matches the existing file-handoff idiom); or have adoption honestly takeover-and-kill orphans; or at minimum document drain-before-restart as an operational requirement. Right now the failure is silent and delayed, which is the worst combination.

## MAJOR 3 — the server-uptime gate does not deliver its stated guarantee; the real protection is the cadence arithmetic, and outages >10 min still kill all in-flight work

The gate's comment (`leases.ts:138-142`) says it gives "every live container a chance to re-heartbeat before any expiry fires." But `heartbeatLease` calls `validateLease` → `getActiveLease`, which requires `gt(expiresAt, now)` (`leases.ts:33`). A lease whose `expires_at` lapsed **during** the outage can never be re-heartbeated — the heartbeat 4xxes. The gate merely postpones the sweep by 600s; nothing can save the lease in that window.

Work the arithmetic: with 60s cadence, a heartbeated lease always has ≥540s remaining when an outage starts. Outage <540s → the lease never lapses, the first post-restart sweep finds nothing to expire, the gate did nothing. Outage >600s → the lease lapsed, re-heartbeat is impossible, and the host's miss counter kills the container at ~10 min anyway. The gate materially closes only the 540–600s sliver where the 2s-cadence sweep could beat the next 60s heartbeat to a just-lapsed lease. That's a defensible razor-thin race to close, but the comment, the plan ("giving every live container a full window to re-establish its heartbeat"), and the test name all claim far more than it does. If the intended guarantee is "live containers survive any tracker outage up to the grace window," `heartbeatLease` must accept an expired-but-uninvalidated lease during the grace period (or generally). Otherwise fix the comments so the next person doesn't rely on protection that isn't there.

Second-order: when the host does hit 10 misses on a containerized session, `killSession` → `docker kill` kills PID 1 (the entry script) — the branch-push at `container-entry.sh:164-167` never runs, so a tracker outage of >10 min discards *all* uncommitted-to-origin work of every healthy in-flight container. That may be an accepted cost, but it's nowhere stated.

## MAJOR 4 — the heartbeat failure handler inverts the correct response to the two failure classes

`postHeartbeat` (`agent-worker.ts:378-394`) collapses everything to a boolean: a 4xx ("lease invalidated/superseded" — permanent, unrecoverable once `invalidatedAt` is set) and a connection error / 5xx (transient) both count as one miss.

- **After a takeover** (human seizes via `claim_issue takeover:true`), the host's token is dead *now*, and every subsequent beat will 4xx — yet the zombie session keeps working the issue for another ~10 minutes before cancellation. That is a ten-minute sanctioned double-work window on exactly the SYD-93 failure mode this whole lease system exists to close, with the loser potentially pushing conflicting commits the whole time.
- **During a pure network outage**, the host kills at 10 misses even though the tracker-side lease may be perfectly safe (short outage: never lapsed; restart: gate-protected) and heartbeats would have resumed on recovery.

Cancel promptly (1–2 confirming beats) on 4xx; be patient — arguably indefinitely, given finding 3's analysis that the server side is the actual authority — on network/5xx. The pure `heartbeatTick` makes this an easy extension (`ok` → tri-state).

## MAJOR 5 — the MCP `heartbeat` tool is a one-call trap for interactive sessions

Design decision 1 is explicit: heartbeat renewal SHORTENS the window, and "an interactive session never heartbeats." But the tool is registered on the shared MCP surface (`src/mcp/server.ts:291-301`) available to every interactive agent session, with a description that says "you normally do NOT need to call it" — which is an invitation, not a barrier; LLMs call the tools they see. One curious/dutiful `heartbeat` call from an interactive session irreversibly collapses its 8h lease to 600s; no timer follows; ten minutes later the sweep flips the issue to `todo` mid-session and auto-dispatch can grab it → duplicate work (the exact dispatch-races-interactive failure already seen twice on this project). The enforcement here is prompt-strength, guarding a server-state trap.

The host loop uses REST, not MCP — the MCP tool exists only for B2 symmetry. Drop it, or register it only when `connectionLeaseToken` is present (a genuine host-injected container session), or make the MCP-surface variant renew to `max(current_expires_at, now + window)` so a stray call can never shorten. Any of these is small; the current shape is a loaded footgun on the primary interactive surface.

## MINOR 6 — 200-without-leaseToken strands a claim silently

`claimIssueHost` (`agent-worker.ts:356-361`): on an un-upgraded tracker, the claim succeeds server-side (issue → in_progress, 8h lease minted) but the missing `leaseToken` makes the worker return null and skip — with **no log line** (the "lost the claim race" log fires only in the catch path). The issue then sits claimed-by-nobody until the 4h stale guess / 8h TTL releases it. The comment acknowledges the mismatch case; log it loudly (and ideally release the claim just taken, e.g. PATCH back to todo) instead of skipping silently.

## MINOR 7 — "never enters the LLM transcript" is overstated: the lease sits in the session's own env

`container-entry.sh` writes the header file (`chmod 600`, same UID as the session) and then launches `claude` (line 146) with `SWITCHYARD_LEASE` (and `SWITCHYARD_TOKEN`) still exported — the session has Bash in its allowlist, so `env` puts the token one plausible tool call away from the transcript. The invariant actually delivered is "not placed in the transcript by us." `unset SWITCHYARD_LEASE SWITCHYARD_TOKEN` after writing `/tmp/switchyard-mcp.json` (line 141) is a one-line hardening that makes the claim nearly true (the config file itself remains readable — unavoidable). Pre-existing pattern for the bearer token, but this PR is the one stating the invariant.

## MINOR 8 — heartbeat fetch has no timeout and the loop is re-entrant

`postHeartbeat` uses bare `fetch` with no `AbortSignal`; a black-holing tracker (connection accepted, no response — a wedged deploy) holds each attempt to undici's default ~300s headers timeout while `setInterval` (`agent-worker.ts:411-422`) keeps firing, stacking up to ~5 concurrent in-flight beats and stretching worst-case cancellation from ~10 to ~15 minutes. Out-of-order settlement around recovery can also glitch the consecutive-failure counter (a late failure landing after a fresh success re-increments a streak that should be dead). `AbortSignal.timeout(10_000)` per beat, and optionally a "previous beat still in flight counts as this tick's outcome" guard. (Also: if the injected `log` callback ever throws, the `.then` rejection is unhandled — `logLine` catches internally today, so latent only.)

---

## Summary

The core lease/heartbeat service code is solid. But the PR's three headline promises each have a hole: "the session's writes are authorized automatically" is false for the default CLI runner (C1); "containers survive worker restarts" (SYD-121) is silently revoked (C2); "a redeploy can't mass-expire live leases" is true only by cadence arithmetic, not by the gate built for it (M3). C1 and C2 are runtime-path breakages on supported, documented flows and should be resolved (or explicitly descoped in writing) before merge; M4/M5 are cheap to fix and close real double-work windows.

VERDICT: REVISE — concerns above should be addressed first
