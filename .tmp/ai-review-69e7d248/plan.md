# SYD-210 Layer B — session-scoped claim lease heartbeats (PR #152)

This is a CODE REVIEW of a pull request, not a greenfield plan. Review the diff below for correctness, security (the lease token must never enter the LLM transcript or argv), the lease lifecycle, the host-claim-vs-container-claim resolution, and heartbeat/expiry race semantics. Read the full files at their absolute paths under the repo root as needed (git rev-parse --show-toplevel).

## Context (Layer A already merged, this builds on it)
- A claim is a session-scoped lease: server-minted hashed token, required on claim-scoped mutations. Layer A shipped mint/validate/invalidate/expire + adapters + takeover + hard-cutover.
- Layer B (this PR) adds honest liveness: heartbeats + server-uptime expiry gate + host-side heartbeat loop + token injection so containers carry the lease without it entering the transcript.

## Key files changed
- src/services/leases.ts (heartbeatLease, expireLeases uptime gate)
- src/services/settings.ts (claims.heartbeat_window_seconds=600)
- src/services/webhook-dispatcher.ts (thread process start into expireLeases)
- src/services/issues.ts (heartbeatClaim wrapper)
- src/mcp/server.ts + src/server.ts (heartbeat tool; connection-level lease token from X-Switchyard-Lease header)
- src/rest/api-routes.ts (POST /issues/:ref/heartbeat)
- scripts/agent-worker.ts (claimIssueHost captures token; startLeaseHeartbeat loop + cancellation; token injection; prompt no-reclaim)
- scripts/worker-select.ts (heartbeatTick pure fn; buildDockerArgs -e SWITCHYARD_LEASE; container prompt no-reclaim)
- scripts/container-entry.sh (adds X-Switchyard-Lease MCP header from SWITCHYARD_LEASE env)
- worker-sdk/sdk-runner.ts (lease header; external abort signal)

## Full diff (origin/main..HEAD)
```diff
diff --git a/docs/superpowers/plans/2026-07-13-syd-210-claim-leases.md b/docs/superpowers/plans/2026-07-13-syd-210-claim-leases.md
index 8e0fbfc..f3dc319 100644
--- a/docs/superpowers/plans/2026-07-13-syd-210-claim-leases.md
+++ b/docs/superpowers/plans/2026-07-13-syd-210-claim-leases.md
@@ -1736,15 +1736,51 @@ The new `leases.ts`/`lease-cutover.ts` services and `claim_leases` table are str
 
 ---
 
-## Layer B — fast-follow (documented, NOT built in this plan)
+## Layer B — honest liveness (heartbeats)
 
-Layer B replaces the residual idle-guess with honest liveness. It is a separate execution pass (and couples a tracker deploy with a worker-host upgrade — see the design §6 deploy-coordination note). Tasks, at a glance:
+Layer B replaces the residual idle-guess with honest liveness: a supervising worker heartbeats its container's lease, and a lease that stops being heartbeated expires in ~10 min instead of waiting out the 8h TTL. It couples a tracker deploy with a worker-host upgrade (design §6 deploy-coordination note), so the enforcing deploy from Layer A should land together with the Layer B worker-host upgrade (or with the worker host down, which it currently is).
 
-- **B1 — `heartbeatLease(db, issueId, actorId, token)`** in `leases.ts`: validate, then renew `last_beat_at = now` and `expires_at = now + ttl`. Test: a renewal pushes `expires_at` out; a wrong/absent token is rejected.
-- **B2 — `heartbeat(ref, lease_token)` tool + route** on both adapters (MCP tool, REST `POST /issues/:ref/heartbeat` reading `X-Switchyard-Lease`). Test: heartbeat by the holder extends the lease; a non-holder/no-token is rejected.
-- **B3 — host-side heartbeat loop** in `scripts/agent-worker.ts` + `worker-sdk/`: the supervising worker heartbeats the container's lease on a **60s** interval; after **N = 10** missed renewals it fires a cancellation signal and terminates its own workload rather than racing a re-dispatch. Token is injected host-side (env → SDK → tool arg), never in the LLM transcript.
-- **B4 — server-uptime expiry gate**: `expireLeases` must not mass-expire live leases right after a tracker redeploy (a correlated outage). Gate expiry on the server having been continuously up for the lease window (e.g. a process-start timestamp; only expire leases whose window fully elapsed since start). Test: leases do not expire within `N×interval` of a simulated restart.
-- **B5 — interactive TTL**: already covered by `claims.lease_ttl_seconds` (8h) from Layer A; a session that loses its token to compaction re-acquires via opt-in takeover (Task 5). No new work beyond confirming the interactive path in docs.
+### Locked design decisions
+
+1. **A heartbeat renewal SHORTENS the window.** `claimIssue` mints with `claims.lease_ttl_seconds` (8h) — the interactive fallback, since a fresh claim doesn't know whether it's a container or an interactive session. `heartbeatLease` renews `expires_at = now + claims.heartbeat_window_seconds` (**default 600s = N×interval**). So the *first* heartbeat from a container collapses its effective window from 8h to ~10 min; a container that keeps beating stays alive indefinitely, a dead one loses its lease within one window. An interactive session never heartbeats, so it keeps the long 8h TTL and recovers via takeover after compaction. This is the whole point — heartbeat = short honest window, no heartbeat = long TTL.
+2. **New setting `claims.heartbeat_window_seconds`** (default 600). Both `heartbeatLease`'s renewal and the server-uptime grace period read it, so they can never drift.
+3. **Server-uptime expiry gate.** A tracker redeploy is a *correlated* outage: every container's heartbeats fail at once during the ~5–15 s restart. To stop the first post-restart sweep from mass-expiring every live lease, `expireLeases` skips the entire sweep until the server has been continuously up for one full `heartbeat_window_seconds` — giving every live container a full window to re-establish its heartbeat before any expiry can fire. Process start time is captured once at server boot and threaded into the sweep.
+4. **Host-side loop (B3).** The supervising `agent-worker`/SDK process heartbeats on the container's behalf every **60 s**; after **N = 10** consecutive failures (~10 min) it fires a cancellation signal and terminates its own workload rather than racing a re-dispatch. The lease token is injected host-side (env → SDK → tool arg), **never** written into the LLM transcript.
+
+### Task B1 — `claims.heartbeat_window_seconds` + `heartbeatLease`
+
+**Files:** `src/services/settings.ts` (registry), `src/services/leases.ts`, `tests/services/lease-heartbeat.test.ts`
+
+- `heartbeatLease(db, issueId, actorId, token): ClaimLease` — `validateLease` first, then renew `last_beat_at = now` and `expires_at = now + getSetting(db, "claims.heartbeat_window_seconds")`; return the updated row.
+- Tests: a renewal moves `expires_at` to `now + window` (shorter than the 8h mint) and updates `last_beat_at`; a wrong/absent/expired/non-holder token is rejected (reuses `validateLease`).
+
+### Task B2 — `heartbeat` surface on both adapters
+
+**Files:** `src/mcp/server.ts`, `src/rest/api-routes.ts`, `tests/mcp/lease-tools.test.ts` (extend), `tests/rest/lease-header.test.ts` (extend)
+
+- MCP: new `heartbeat` tool `{ ref, lease_token }` → `heartbeatLease(db, actor, ...)`; returns `{ ok: true, expires_at }`. Description: "Keep your claim's lease alive — the host worker calls this on a timer; the LLM should not."
+- REST: `POST /issues/:ref/heartbeat` reading `c.var.leaseToken` (the `X-Switchyard-Lease` header); returns `{ ok: true, expiresAt }`.
+- Tests: the holder heartbeats and `expires_at` moves out; a no-token / stale-token / non-holder call is rejected.
+
+### Task B3 — host-side heartbeat loop + cancellation
+
+**Files:** `scripts/agent-worker.ts`, `worker-sdk/` (the SDK runner), plus a doctor/self-test touch if warranted
+
+- On dispatch, the host receives the lease token from `claim_issue` (already returned in Layer A) and holds it out-of-band (env/file handoff — never argv, never transcript).
+- A self-rescheduling 60 s loop calls `POST /issues/<ref>/heartbeat` with the `X-Switchyard-Lease` header. Count consecutive failures; at **10** (~10 min) fire the existing cancellation/kill path for that workload and stop the loop.
+- This is deploy-coupled host code and largely integration-shaped; unit-test the failure-counter/cancellation decision as a pure function where practical, and `log()` what was skipped. Full exercise happens on the worker host at go-live (gated on SYD-213).
+
+### Task B4 — server-uptime expiry gate
+
+**Files:** `src/services/leases.ts` (`expireLeases` signature), `src/services/webhook-dispatcher.ts` (capture + thread process start), `tests/services/lease-expiry.test.ts` (extend)
+
+- `expireLeases(db, now?, serverStartedAt?)`: when `serverStartedAt` is given and `now - serverStartedAt < getSetting(db, "claims.heartbeat_window_seconds")`, return 0 (skip the whole sweep). Otherwise behave as today.
+- `startWebhookDispatcher` captures a process-start timestamp once and passes it on every `expireLeases` call.
+- Tests: within the grace window after a simulated restart, an already-expired lease is NOT swept; past the grace window it is. (Threads an explicit `serverStartedAt`/`now` — no reliance on wall-clock.)
+
+### B5 — interactive TTL
+
+Already covered by `claims.lease_ttl_seconds` (8h) from Layer A; a session that loses its token to compaction re-acquires via opt-in takeover (Task 5). No new code — the interactive path is confirmed by the existing Layer A tests.
 
 `claims.deviation_seconds` (the "claimed but idle" attention chip, 1h) is unchanged — it powers a chip, not release.
 
diff --git a/scripts/agent-worker.ts b/scripts/agent-worker.ts
index c7a6024..a53bd58 100644
--- a/scripts/agent-worker.ts
+++ b/scripts/agent-worker.ts
@@ -81,6 +81,9 @@ import {
   partitionContainerSessions,
   egressMode,
   ensureEgressGuard,
+  heartbeatTick,
+  HEARTBEAT_INTERVAL_MS,
+  HEARTBEAT_MISS_LIMIT,
   type WorkerConfig,
   type WorkerProject,
   type WorkerIssue,
@@ -322,9 +325,13 @@ export async function refreshDispatchPolicy(config: WorkerConfig, token: string)
  * coordinating human session) both select the same unassigned todo and spin
  * up sessions before either calls claim_issue — selection and claim are now
  * atomic from this worker's side, not just from the dispatched session's.
- * The session still calls claim_issue itself per the prompt, but that just
- * reclaims the same actor's own issue at that point (a no-op check) since
- * the session authenticates with this same worker's token.
+ * The host claim mints the session-scoped lease (SYD-210); its plaintext token
+ * is returned here ONCE and threaded to the dispatched session out-of-band (an
+ * MCP connection header, never argv, never the LLM transcript) so its
+ * claim-scoped calls carry the lease, and the host heartbeats it while the
+ * session runs. The dispatched session must therefore NOT call claim_issue —
+ * a same-actor re-claim against the active lease would fail loudly (see
+ * buildPrompt).
  *
  * A refusal (already claimed, now blocked) means another actor won the race
  * — logged and treated as "skip this ref", not an error: it needs no retry
@@ -333,27 +340,91 @@ export async function refreshDispatchPolicy(config: WorkerConfig, token: string)
  * failures still retry across a self-deploy restart via withRetry, same as
  * the other tracker writes.
  */
-async function claimIssueHost(config: WorkerConfig, token: string, ref: string): Promise<boolean> {
+async function claimIssueHost(
+  config: WorkerConfig,
+  token: string,
+  ref: string,
+): Promise<string | null> {
   const url = `${config.url.replace(/\/$/, "")}/api/issues/${ref}/claim`;
   try {
-    await withRetry(async () => {
+    return await withRetry(async () => {
       const res = await fetch(url, {
         method: "POST",
         headers: { authorization: `Bearer ${token}` },
       });
       if (!res.ok) throw new HttpStatusError(res.status, await res.text());
+      const body = (await res.json()) as { leaseToken?: string };
+      // A claim always mints a lease; an absent token is a server/version
+      // mismatch (un-upgraded tracker) — treat as a lost race so we skip
+      // rather than dispatch a session that can't authenticate its writes.
+      return body.leaseToken ?? null;
     });
-    return true;
   } catch (err) {
     if (err instanceof HttpStatusError && err.status < 500) {
       console.log(`skipping ${ref}: lost the claim race (${err.message})`);
     } else {
       console.error(`could not claim ${ref} before dispatch: ${(err as Error).message}`);
     }
+    return null;
+  }
+}
+
+/**
+ * SYD-210 Layer B: renew a dispatched session's lease on the tracker. Returns
+ * true on a 2xx. The host calls this on a timer (startLeaseHeartbeat) so a
+ * live-but-quiet container keeps its claim, and a session the host can no
+ * longer reach loses it within the heartbeat window.
+ */
+async function postHeartbeat(
+  config: WorkerConfig,
+  token: string,
+  leaseToken: string,
+  ref: string,
+): Promise<boolean> {
+  const url = `${config.url.replace(/\/$/, "")}/api/issues/${ref}/heartbeat`;
+  try {
+    const res = await fetch(url, {
+      method: "POST",
+      headers: { authorization: `Bearer ${token}`, "X-Switchyard-Lease": leaseToken },
+    });
+    return res.ok;
+  } catch {
     return false;
   }
 }
 
+/**
+ * Starts the host-side heartbeat loop for a running session and returns a stop
+ * function. Every interval it renews the lease; after HEARTBEAT_MISS_LIMIT
+ * consecutive failures it calls `onExhausted` (which kills the session) and
+ * stops — the honest-liveness cancellation that replaces the 4h idle guess.
+ */
+function startLeaseHeartbeat(
+  config: WorkerConfig,
+  token: string,
+  leaseToken: string,
+  ref: string,
+  onExhausted: () => void,
+  log: (message: string) => void,
+): () => void {
+  let failures = 0;
+  const timer = setInterval(() => {
+    void postHeartbeat(config, token, leaseToken, ref).then((ok) => {
+      const r = heartbeatTick(failures, ok);
+      failures = r.failures;
+      if (!ok) log(`[worker] ${ref}: lease heartbeat failed (${failures}/${HEARTBEAT_MISS_LIMIT})`);
+      if (r.cancel) {
+        log(`[worker] ${ref}: ${HEARTBEAT_MISS_LIMIT} missed heartbeats — cancelling session`);
+        stop();
+        onExhausted();
+      }
+    });
+  }, HEARTBEAT_INTERVAL_MS);
+  timer.unref?.();
+  const stop = () => clearInterval(timer);
+  return stop;
+}
+
 export function buildPrompt(ref: string, opts: { resumed?: boolean } = {}): string {
   const resumedPreamble = opts.resumed
     ? `You previously escalated a question on Switchyard issue ${ref} and a human ` +
@@ -363,7 +434,11 @@ export function buildPrompt(ref: string, opts: { resumed?: boolean } = {}): stri
   return (
     resumedPreamble +
     `Work Switchyard issue ${ref} using the switchyard MCP tools. ` +
-    `Call claim_issue first. ` +
+    // SYD-210: the dispatch host already claimed this issue for your session and
+    // holds its lease — do NOT call claim_issue (a re-claim would fail). Your
+    // claim-scoped calls (update_issue, request_human_input) are authorized
+    // automatically; just call get_issue to read it and start work.
+    `This issue is already claimed for your session — do not call claim_issue; call get_issue to read it. ` +
     `Record a one-line note with the progress_note tool each time you start a new ` +
     `step (reading code, writing tests, implementing, verifying) so humans can ` +
     `watch progress live. ` +
@@ -489,7 +564,7 @@ export function dispatch(
   config: WorkerConfig,
   token: string,
   role: WorkerRole,
-  opts: { resumed?: boolean } = {},
+  opts: { resumed?: boolean; leaseToken?: string } = {},
 ): void {
   const project = config.projects[projectKeyOf(issue.ref)];
   const logDir = path.join(project.repo, ".superpowers", "worker-logs");
@@ -521,6 +596,13 @@ export function dispatch(
       child = spawn("docker", dockerArgs, {
         detached: true,
         stdio: ["ignore", fd, fd],
+        // SYD-210 Layer B: hand the lease to the container via the spawn env
+        // (bare -e SWITCHYARD_LEASE in dockerArgs reads it here) so it never
+        // appears in argv. Per-spawn env avoids collisions across concurrent
+        // containers.
+        env: opts.leaseToken
+          ? { ...process.env, SWITCHYARD_LEASE: opts.leaseToken }
+          : process.env,
       });
     } else {
       // Headless sessions can't answer permission prompts — grant the tools the
@@ -562,6 +644,15 @@ export function dispatch(
   activeMode.set(issue.ref, config.containerized ? "container" : "cli");
   console.log(`dispatched ${issue.ref} (pid ${child.pid}) -> ${logPath}`);
 
+  // SYD-210 Layer B: heartbeat the lease while the session runs; after N missed
+  // renewals, kill it (honest liveness — a dead/wedged session loses its claim
+  // within the window instead of holding it out to the 8h TTL).
+  const stopHeartbeat = opts.leaseToken
+    ? startLeaseHeartbeat(config, token, opts.leaseToken, issue.ref, () =>
+        killSession(child, config.containerized ? `syd-${issue.ref}` : null),
+      logLine)
+    : () => {};
+
   // Watchdog (SYD-115): a hung `claude -p` or stuck `docker run` would
   // otherwise hold this maxConcurrent slot forever. Cleared on exit/error
   // below so a session that finishes normally never gets killed late.
@@ -590,6 +681,7 @@ export function dispatch(
 
   child.on("exit", (code) => {
     clearTimeout(watchdog);
+    stopHeartbeat();
     active.delete(issue.ref);
     activeMode.delete(issue.ref);
     if (roleRunsAnswer(role)) triggerUnansweredDrain(config, token);
@@ -598,6 +690,7 @@ export function dispatch(
 
   child.on("error", (err) => {
     clearTimeout(watchdog);
+    stopHeartbeat();
     active.delete(issue.ref);
     activeMode.delete(issue.ref);
     // 'error' can fire after a successful 'spawn' with no 'exit' to follow —
@@ -622,7 +715,7 @@ function dispatchSdk(
   token: string,
   role: WorkerRole,
   logPath: string,
-  opts: { resumed?: boolean },
+  opts: { resumed?: boolean; leaseToken?: string },
 ): void {
   const allowedTools = config.allowedTools ?? [
     "mcp__switchyard__*",
@@ -653,6 +746,16 @@ function dispatchSdk(
     (message) => safeAppend(`[worker] ${message}\n`),
   );
 
+  // SYD-210 Layer B: heartbeat the lease while the SDK session runs; on N missed
+  // renewals, abort the query (the SDK's own cancellation) rather than racing a
+  // re-dispatch. Stopped when the session settles (finally, below).
+  const sdkAbort = new AbortController();
+  const stopHeartbeat = opts.leaseToken
+    ? startLeaseHeartbeat(config, token, opts.leaseToken, issue.ref, () => sdkAbort.abort(), (m) =>
+        safeAppend(`${m}\n`),
+      )
+    : () => {};
+
   const runnerPath = path.join(repoRoot(), "worker-sdk", "sdk-runner.ts");
   import(runnerPath)
     .then((mod: { runSdkSession: (o: object) => Promise<number> }) =>
@@ -661,9 +764,11 @@ function dispatchSdk(
         cwd: repo,
         switchyardUrl: config.url,
         switchyardToken: token,
+        switchyardLeaseToken: opts.leaseToken,
         allowedTools,
         logPath,
         timeoutMs: sessionTimeoutMs(config),
+        externalAbortSignal: sdkAbort.signal,
       }),
     )
     .then(
@@ -689,6 +794,7 @@ function dispatchSdk(
       console.error(`sdk dispatch cleanup error for ${issue.ref}: ${err.message}`),
     )
     .finally(() => {
+      stopHeartbeat();
       active.delete(issue.ref);
       if (roleRunsAnswer(role)) triggerUnansweredDrain(config, token);
     });
@@ -906,10 +1012,11 @@ export async function runTick(
             );
             continue;
           }
-          if (!(await claimIssueHost(config, token, issue.ref))) continue;
+          const leaseToken = await claimIssueHost(config, token, issue.ref);
+          if (!leaseToken) continue;
           recordAttempt(retryState, issue.ref, issue.updatedAt);
           const resumed = resumeRefs.delete(issue.ref);
-          dispatch(issue, config, token, role, { resumed });
+          dispatch(issue, config, token, role, { resumed, leaseToken });
         }
       } catch (err) {
         console.error(`poll failed: ${(err as Error).message}`);
diff --git a/scripts/container-entry.sh b/scripts/container-entry.sh
index 7bb93f4..ca65dd7 100755
--- a/scripts/container-entry.sh
+++ b/scripts/container-entry.sh
@@ -119,13 +119,21 @@ fi
 
 # Written as a file rather than `claude mcp add --header ...` so the bearer
 # token never appears in any process argv (visible via ps / docker top).
+# SYD-210 Layer B: when the host injects a session-scoped lease, add it as the
+# X-Switchyard-Lease MCP header so claim-scoped writes carry the lease. Absent
+# for answer/non-lease sessions.
+if [ -n "${SWITCHYARD_LEASE:-}" ]; then
+  MCP_HEADERS="\"Authorization\": \"Bearer $SWITCHYARD_TOKEN\", \"X-Switchyard-Lease\": \"$SWITCHYARD_LEASE\""
+else
+  MCP_HEADERS="\"Authorization\": \"Bearer $SWITCHYARD_TOKEN\""
+fi
 cat > /tmp/switchyard-mcp.json <<MCPEOF
 {
   "mcpServers": {
     "switchyard": {
       "type": "http",
       "url": "$SWITCHYARD_URL/mcp",
-      "headers": { "Authorization": "Bearer $SWITCHYARD_TOKEN" }
+      "headers": { $MCP_HEADERS }
     }
   }
 }
diff --git a/scripts/worker-select.ts b/scripts/worker-select.ts
index 8a47dfe..de93d62 100644
--- a/scripts/worker-select.ts
+++ b/scripts/worker-select.ts
@@ -699,7 +699,11 @@ export function buildContainerizedPrompt(
   return (
     resumedPreamble +
     `Work Switchyard issue ${ref} using the switchyard MCP tools. ` +
-    `Call claim_issue first. Implement the work with tests. Comment verification ` +
+    // SYD-210: the dispatch host already claimed this issue for your session and
+    // holds its lease — do NOT call claim_issue (a re-claim would fail); your
+    // claim-scoped writes are authorized automatically. Call get_issue to read it.
+    `This issue is already claimed for your session — do not call claim_issue; call get_issue to read it. ` +
+    `Implement the work with tests. Comment verification ` +
     `evidence describing what you did and how you verified it, then move the issue ` +
     `to in_review. Never move it to done — a human or review step does that. ` +
     `If you are blocked on a decision only a human can make, call request_human_input ` +
@@ -995,7 +999,7 @@ export function buildDockerArgs(
   project: WorkerProject,
   config: WorkerConfig,
   env: NodeJS.ProcessEnv,
-  opts: { resumed?: boolean } = {},
+  opts: { resumed?: boolean; leaseToken?: string } = {},
 ): string[] {
   const engine = config.engine ?? "claude";
 
@@ -1062,6 +1066,11 @@ export function buildDockerArgs(
     `SWITCHYARD_URL=${config.url}`,
     "-e",
     "SWITCHYARD_TOKEN",
+    // SYD-210 Layer B: the session-scoped lease, passed bare (value from the
+    // spawn env, never argv) exactly like SWITCHYARD_TOKEN — container-entry.sh
+    // adds it as the X-Switchyard-Lease MCP header so the session's
+    // claim-scoped writes carry the lease without it entering the transcript.
+    ...(opts.leaseToken ? ["-e", "SWITCHYARD_LEASE"] : []),
     ...credArgs,
     "-e",
     `WORKER_PROMPT=${prompt}`,
@@ -1116,3 +1125,28 @@ export function partitionContainerSessions(
   }
   return { orphaned, live };
 }
+
+// SYD-210 Layer B host-side heartbeat cadence. Interval 60s x miss-limit 10 =
+// a ~10-min window that comfortably exceeds the worst-case tracker redeploy
+// (~5-15s, SYD-66) — and the server also gates expiry on its own uptime, so a
+// redeploy can't mass-expire live leases regardless.
+export const HEARTBEAT_INTERVAL_MS = 60_000;
+export const HEARTBEAT_MISS_LIMIT = 10;
+
+/**
+ * Fold one heartbeat outcome into the consecutive-failure count and decide
+ * whether to cancel the session. A success resets the count; `cancel` becomes
+ * true once `missLimit` beats fail in a row (~missLimit x interval of silence),
+ * which the host uses to terminate a session whose lease it can no longer
+ * renew rather than racing a re-dispatch. Pure so the decision is unit-tested
+ * independently of the timer/fetch wiring.
+ */
+export function heartbeatTick(
+  failures: number,
+  ok: boolean,
+  missLimit: number = HEARTBEAT_MISS_LIMIT,
+): { failures: number; cancel: boolean } {
+  if (ok) return { failures: 0, cancel: false };
+  const next = failures + 1;
+  return { failures: next, cancel: next >= missLimit };
+}
diff --git a/src/mcp/server.ts b/src/mcp/server.ts
index 9f8c6ae..0b387f5 100644
--- a/src/mcp/server.ts
+++ b/src/mcp/server.ts
@@ -10,6 +10,7 @@ import {
   getIssue,
   updateIssue,
   claimIssue,
+  heartbeatClaim,
   SUMMARY_MAX_LENGTH,
 } from "../services/issues.js";
 import { nextTask, addDependency } from "../services/dependencies.js";
@@ -51,6 +52,12 @@ export function buildMcpServer(
   db: Db,
   actor: Actor,
   attachmentsDir: string = defaultAttachmentsDir(),
+  // SYD-210 Layer B: a connection-level lease token, extracted once by the /mcp
+  // endpoint from the X-Switchyard-Lease header (mirrors how the actor is baked
+  // into this closure). The host worker sets it for a container session so its
+  // claim-scoped tool calls carry the lease WITHOUT the token ever appearing in
+  // the LLM transcript. An explicit lease_token tool arg still wins when given.
+  connectionLeaseToken?: string,
 ): McpServer {
   const server = new McpServer({ name: "switchyard", version: "0.1.0" });
 
@@ -271,13 +278,28 @@ export function buildMcpServer(
             workerPreference: a.worker_preference,
             expectedHeadSha: a.expected_head_sha,
           },
-          { presented: a.lease_token, minted },
+          { presented: a.lease_token ?? connectionLeaseToken, minted },
         );
         return minted.token ? { ...issue, lease_token: minted.token } : issue;
       },
     ),
   );
 
+  server.registerTool(
+    "heartbeat",
+    {
+      description:
+        "Keep your claim's lease alive by renewing it. The supervising host worker calls this on a " +
+        "timer for container sessions — you normally do NOT need to call it yourself. Pass the " +
+        "lease_token returned by claim_issue.",
+      inputSchema: { ref: z.string(), lease_token: z.string().optional() },
+    },
+    guard(({ ref, lease_token }: { ref: string; lease_token?: string }) => {
+      const { expiresAt } = heartbeatClaim(db, actor, ref, lease_token ?? connectionLeaseToken);
+      return { ok: true, expires_at: expiresAt };
+    }),
+  );
+
   server.registerTool(
     "comment",
     {
@@ -319,7 +341,7 @@ export function buildMcpServer(
       inputSchema: { ref: z.string(), question: z.string(), lease_token: z.string().optional() },
     },
     guard(({ ref, question, lease_token }: { ref: string; question: string; lease_token?: string }) =>
-      requestHumanInput(db, actor, ref, question, lease_token),
+      requestHumanInput(db, actor, ref, question, lease_token ?? connectionLeaseToken),
     ),
   );
 
diff --git a/src/rest/api-routes.ts b/src/rest/api-routes.ts
index 80f0912..e019557 100644
--- a/src/rest/api-routes.ts
+++ b/src/rest/api-routes.ts
@@ -17,7 +17,7 @@ import { createLoginLink, getSessionActor } from "../services/auth.js";
 import { createProject, listProjects, updateProject } from "../services/projects.js";
 import { SESSION_COOKIE } from "./auth-routes.js";
 import type { Status } from "../db/schema.js";
-import { createIssue, getIssue, updateIssue, claimIssue } from "../services/issues.js";
+import { createIssue, getIssue, updateIssue, claimIssue, heartbeatClaim } from "../services/issues.js";
 import {
   addDependency,
   listBlockedIssueIds,
@@ -249,6 +249,10 @@ export function buildApiRoutes(db: Db, attachmentsDir: string = defaultAttachmen
     return c.json({ ...issue, leaseToken });
   });
 
+  app.post("/issues/:ref/heartbeat", (c) =>
+    c.json({ ok: true, ...heartbeatClaim(db, c.var.actor, c.req.param("ref"), c.var.leaseToken) }),
+  );
+
   app.post("/issues/:ref/comments", body(commentBody), (c) => {
     addComment(db, c.var.actor, c.req.param("ref"), c.req.valid("json").body);
     return c.json({ ok: true });
diff --git a/src/server.ts b/src/server.ts
index 98aa3ad..466d46c 100644
--- a/src/server.ts
+++ b/src/server.ts
@@ -75,7 +75,11 @@ export function createApp(db: Db) {
     }
     const { req, res } = toReqRes(c.req.raw);
     const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
-    const server = buildMcpServer(db, actor);
+    // SYD-210 Layer B: a host worker injects its container's claim lease as this
+    // header (mirrors REST's X-Switchyard-Lease); bake it into the tool closure
+    // so claim-scoped calls carry it without the token entering the transcript.
+    const leaseToken = c.req.header("x-switchyard-lease") ?? undefined;
+    const server = buildMcpServer(db, actor, undefined, leaseToken);
     res.on("close", () => {
       transport.close();
       server.close();
diff --git a/src/services/issues.ts b/src/services/issues.ts
index 0f0d46a..7eaecb3 100644
--- a/src/services/issues.ts
+++ b/src/services/issues.ts
@@ -17,7 +17,7 @@ import { recordEvent } from "./events.js";
 import { getOpenBlockers } from "./dependencies.js";
 import { getOpenPr } from "./pr-status.js";
 import { getSetting } from "./settings.js";
-import { mintLease, validateLease, invalidateLease, getActiveLease } from "./leases.js";
+import { mintLease, validateLease, invalidateLease, getActiveLease, heartbeatLease } from "./leases.js";
 
 export type Provenance = {
   sourceType: "session" | "todo" | "ci" | "manual";
@@ -487,6 +487,22 @@ export function updateIssue(
  */
 export type ClaimResult = { issue: IssueView; leaseToken: string };
 
+/**
+ * SYD-210 Layer B: renew the caller's claim lease on `ref` (resolves the ref,
+ * then heartbeatLease gates on the holder's token). Thin adapter-facing wrapper
+ * so the ref→issue lookup stays out of leases.ts (which must not import issues).
+ */
+export function heartbeatClaim(
+  db: Db,
+  actor: Actor,
+  ref: string,
+  leaseToken?: string,
+): { expiresAt: number } {
+  const issue = getIssue(db, ref);
+  const lease = heartbeatLease(db, issue.id, actor.id, leaseToken);
+  return { expiresAt: lease.expiresAt };
+}
+
 export function claimIssue(
   db: Db,
   actor: Actor,
diff --git a/src/services/leases.ts b/src/services/leases.ts
index f6dacc6..bd6acf4 100644
--- a/src/services/leases.ts
+++ b/src/services/leases.ts
@@ -4,6 +4,7 @@ import { claimLeases, issues } from "../db/schema.js";
 import { SwitchyardError } from "./errors.js";
 import { recordEvent } from "./events.js";
 import { hashToken, mintToken } from "./tokens.js";
+import { getSetting } from "./settings.js";
 
 export type ClaimLease = typeof claimLeases.$inferSelect;
 
@@ -84,6 +85,32 @@ export function validateLease(
   }
 }
 
+/**
+ * SYD-210 Layer B: renew a lease's liveness window. Validates the holder's
+ * token, then bumps last_beat_at and sets expires_at = now +
+ * claims.heartbeat_window_seconds. The window is SHORTER than the mint TTL, so
+ * the first heartbeat collapses a container claim's 8h fallback to ~10 min of
+ * honest liveness — a container that keeps beating stays alive, a dead one
+ * loses its lease within one window. Interactive claims never heartbeat and
+ * keep the long TTL.
+ */
+export function heartbeatLease(
+  db: DbOrTx,
+  issueId: number,
+  actorId: number,
+  token: string | undefined,
+): ClaimLease {
+  validateLease(db, issueId, actorId, token);
+  const active = getActiveLease(db, issueId)!;
+  const now = nowSeconds();
+  return db
+    .update(claimLeases)
+    .set({ lastBeatAt: now, expiresAt: now + getSetting(db as Db, "claims.heartbeat_window_seconds") })
+    .where(eq(claimLeases.id, active.id))
+    .returning()
+    .get();
+}
+
 /**
  * Marks the active lease of an issue invalidated (takeover / self-release /
  * human-answer release). No-op if there is no active lease. The REASON is
@@ -107,8 +134,24 @@ export function invalidateLease(tx: DbOrTx, issueId: number): void {
  * claim_released{reason:"lease_expired"}, and mark the lease invalidated (so it
  * leaves future sweeps). Replaces the 4h idle guess for leased claims.
  * Returns the number of issues released.
+ *
+ * SYD-210 Layer B server-uptime gate: a tracker redeploy is a correlated
+ * outage — every container's heartbeats fail at once during the ~5–15s
+ * restart. When `serverStartedAt` is given, the sweep is skipped entirely
+ * until the server has been continuously up for one full heartbeat window,
+ * giving every live container a chance to re-heartbeat before any expiry fires.
  */
-export function expireLeases(db: Db, now: number = nowSeconds()): number {
+export function expireLeases(
+  db: Db,
+  now: number = nowSeconds(),
+  serverStartedAt?: number,
+): number {
+  if (
+    serverStartedAt !== undefined &&
+    now - serverStartedAt < getSetting(db, "claims.heartbeat_window_seconds")
+  ) {
+    return 0;
+  }
   const expired = db
     .select()
     .from(claimLeases)
diff --git a/src/services/settings.ts b/src/services/settings.ts
index dbfce12..d7d5196 100644
--- a/src/services/settings.ts
+++ b/src/services/settings.ts
@@ -33,6 +33,12 @@ export const REGISTRY = {
   "claims.stale_seconds": { type: "number", default: 4 * 3600 },
   "claims.deviation_seconds": { type: "number", default: 3600 },
   "claims.lease_ttl_seconds": { type: "number", default: 8 * 3600 },
+  // SYD-210 Layer B: a heartbeat renews a lease to now + this window (= the
+  // host worker's N missed beats x interval, 10 x 60s). Shorter than the mint
+  // TTL, so a heartbeated (container) claim gets honest ~10-min liveness while
+  // an un-heartbeated (interactive) claim keeps the long lease_ttl_seconds.
+  // Also the server-uptime grace after a redeploy before expiry may resume.
+  "claims.heartbeat_window_seconds": { type: "number", default: 600 },
   "auth.login_link_ttl_seconds": { type: "number", default: 15 * 60 },
   "webhooks.suppressed_events": { type: "string[]", default: ["progress_note"] },
   "dispatch.max_concurrent": { type: "number", default: 1 },
diff --git a/src/services/webhook-dispatcher.ts b/src/services/webhook-dispatcher.ts
index 8fac13c..757a351 100644
--- a/src/services/webhook-dispatcher.ts
+++ b/src/services/webhook-dispatcher.ts
@@ -79,6 +79,10 @@ export async function dispatchPending(db: Db, fetchFn: typeof fetch = fetch): Pr
 }
 
 export function startWebhookDispatcher(db: Db, intervalMs = 2000): () => void {
+  // SYD-210 Layer B: capture process start once so lease expiry can gate on
+  // server uptime — a redeploy's correlated heartbeat outage must not
+  // mass-expire live leases before they re-heartbeat.
+  const serverStartedAt = Math.floor(Date.now() / 1000);
   const timer = setInterval(() => {
     try {
       emitProcessDeviations(db);
@@ -95,7 +99,7 @@ export function startWebhookDispatcher(db: Db, intervalMs = 2000): () => void {
       console.error("stale claim release:", err);
     }
     try {
-      expireLeases(db);
+      expireLeases(db, Math.floor(Date.now() / 1000), serverStartedAt);
     } catch (err) {
       console.error("lease expiry sweep:", err);
     }
diff --git a/tests/mcp/lease-tools.test.ts b/tests/mcp/lease-tools.test.ts
index 7f56430..bad4ac2 100644
--- a/tests/mcp/lease-tools.test.ts
+++ b/tests/mcp/lease-tools.test.ts
@@ -8,9 +8,9 @@ import { createIssue, updateIssue } from "../../src/services/issues.js";
 import { buildMcpServer } from "../../src/mcp/server.js";
 
 let db: Db, human: Actor, agent: Actor;
-async function connect(actor: Actor) {
+async function connect(actor: Actor, connectionLeaseToken?: string) {
   const [ct, st] = InMemoryTransport.createLinkedPair();
-  await buildMcpServer(db, actor).connect(st);
+  await buildMcpServer(db, actor, undefined, connectionLeaseToken).connect(st);
   const c = new Client({ name: "test", version: "0.0.0" });
   await c.connect(ct);
   return c;
@@ -67,6 +67,39 @@ describe("MCP lease enforcement", () => {
     expect(seized.lease_token).toMatch(/^lease_/);
   });
 
+  it("heartbeat by the holder renews the lease; a no-token call is rejected", async () => {
+    const c = await connect(agent);
+    const claim = JSON.parse(text(await c.callTool({ name: "claim_issue", arguments: { ref: "AIPI-1" } })));
+    const beat = await c.callTool({
+      name: "heartbeat",
+      arguments: { ref: "AIPI-1", lease_token: claim.lease_token },
+    });
+    expect(beat.isError).toBeFalsy();
+    expect(JSON.parse(text(beat)).ok).toBe(true);
+    const noToken = await c.callTool({ name: "heartbeat", arguments: { ref: "AIPI-1" } });
+    expect(noToken.isError).toBe(true);
+  });
+
+  it("a host-injected connection lease token satisfies claim-scoped calls with no per-call token", async () => {
+    // The host claims and mints the lease, then injects it as an MCP connection
+    // header — the container session mutates without ever seeing the token in
+    // its transcript (no lease_token tool arg).
+    const claimer = await connect(agent);
+    const claim = JSON.parse(
+      text(await claimer.callTool({ name: "claim_issue", arguments: { ref: "AIPI-1" } })),
+    );
+    const session = await connect(agent, claim.lease_token); // connection-level injection
+    const r = await session.callTool({
+      name: "update_issue",
+      arguments: { ref: "AIPI-1", status: "in_review" }, // no lease_token arg
+    });
+    expect(r.isError).toBeFalsy();
+    expect(JSON.parse(text(r)).status).toBe("in_review");
+    // heartbeat likewise works off the connection token
+    const beat = await session.callTool({ name: "heartbeat", arguments: { ref: "AIPI-1" } });
+    expect(beat.isError).toBeFalsy();
+  });
+
   it("exempt surfaces (comment) work without a lease", async () => {
     const a = await connect(agent);
     await a.callTool({ name: "claim_issue", arguments: { ref: "AIPI-1" } });
diff --git a/tests/rest/lease-header.test.ts b/tests/rest/lease-header.test.ts
index 2e364a3..80f3af5 100644
--- a/tests/rest/lease-header.test.ts
+++ b/tests/rest/lease-header.test.ts
@@ -48,4 +48,18 @@ describe("REST X-Switchyard-Lease", () => {
     expect(withHeader.status).toBe(200);
     expect((await withHeader.json()).status).toBe("in_review");
   });
+
+  it("POST /heartbeat renews with the lease header and rejects without it", async () => {
+    const claim = await (
+      await app.request("/issues/AIPI-1/claim", { method: "POST", headers: auth() })
+    ).json();
+    const beat = await app.request("/issues/AIPI-1/heartbeat", {
+      method: "POST",
+      headers: auth({ "X-Switchyard-Lease": claim.leaseToken }),
+    });
+    expect(beat.status).toBe(200);
+    expect((await beat.json()).ok).toBe(true);
+    const noHeader = await app.request("/issues/AIPI-1/heartbeat", { method: "POST", headers: auth() });
+    expect(noHeader.status).toBe(400);
+  });
 });
diff --git a/tests/scripts/agent-worker.test.ts b/tests/scripts/agent-worker.test.ts
index 3f4cd5d..64a0e8d 100644
--- a/tests/scripts/agent-worker.test.ts
+++ b/tests/scripts/agent-worker.test.ts
@@ -588,7 +588,9 @@ describe("host-side pre-claim before dispatch (SYD-122)", () => {
     spawnMock.mockReturnValue(child);
     const fetchMock = fetchRouter({
       "/api/issues?status=todo": { ok: true, body: [issue] },
-      [`/api/issues/${ref}/claim`]: { ok: true, body: {} },
+      // SYD-210: the host claim mints the lease and returns its token, which the
+      // worker threads to the session and heartbeats.
+      [`/api/issues/${ref}/claim`]: { ok: true, body: { leaseToken: "lease_test" } },
     });
     vi.stubGlobal("fetch", fetchMock);
 
diff --git a/tests/scripts/lease-heartbeat.test.ts b/tests/scripts/lease-heartbeat.test.ts
new file mode 100644
index 0000000..32604b4
--- /dev/null
+++ b/tests/scripts/lease-heartbeat.test.ts
@@ -0,0 +1,33 @@
+import { describe, it, expect } from "vitest";
+import {
+  heartbeatTick,
+  HEARTBEAT_MISS_LIMIT,
+  HEARTBEAT_INTERVAL_MS,
+} from "../../scripts/worker-select.js";
+
+describe("heartbeatTick (SYD-210 Layer B)", () => {
+  it("cancels only after missLimit consecutive failures", () => {
+    let failures = 0;
+    for (let i = 0; i < HEARTBEAT_MISS_LIMIT - 1; i++) {
+      const r = heartbeatTick(failures, false);
+      failures = r.failures;
+      expect(r.cancel).toBe(false);
+    }
+    const last = heartbeatTick(failures, false);
+    expect(last.failures).toBe(HEARTBEAT_MISS_LIMIT);
+    expect(last.cancel).toBe(true);
+  });
+
+  it("a success resets the streak so a single blip never cancels", () => {
+    expect(heartbeatTick(HEARTBEAT_MISS_LIMIT - 1, true)).toEqual({ failures: 0, cancel: false });
+  });
+
+  it("respects a custom missLimit", () => {
+    expect(heartbeatTick(1, false, 2)).toEqual({ failures: 2, cancel: true });
+  });
+
+  it("uses a 60s interval and N=10 window (~10 min)", () => {
+    expect(HEARTBEAT_INTERVAL_MS).toBe(60_000);
+    expect(HEARTBEAT_MISS_LIMIT).toBe(10);
+  });
+});
diff --git a/tests/services/lease-expiry.test.ts b/tests/services/lease-expiry.test.ts
index 49a2e49..99d5088 100644
--- a/tests/services/lease-expiry.test.ts
+++ b/tests/services/lease-expiry.test.ts
@@ -41,6 +41,18 @@ describe("expireLeases", () => {
     expect(expireLeases(db)).toBe(0); // idempotent — lease now invalidated
   });
 
+  it("does not sweep within the server-uptime grace window after a restart (SYD-210 Layer B)", () => {
+    const id = claimThenExpireLease();
+    const now = Math.floor(Date.now() / 1000);
+    // server just came up (within the 600s heartbeat window): a correlated
+    // redeploy outage must not mass-expire live leases before they re-heartbeat.
+    expect(expireLeases(db, now, now - 60)).toBe(0);
+    expect(getIssue(db, "AIPI-1").status).toBe("in_progress");
+    // once the server has been up longer than the window, expiry resumes.
+    expect(expireLeases(db, now, now - 601)).toBe(1);
+    expect(getIssue(db, "AIPI-1").status).toBe("todo");
+  });
+
   it("leaves a still-valid lease alone", () => {
     createIssue(db, human, { projectKey: "AIPI", title: "t" });
     updateIssue(db, human, "AIPI-1", { status: "todo" });
diff --git a/tests/services/lease-heartbeat.test.ts b/tests/services/lease-heartbeat.test.ts
new file mode 100644
index 0000000..dcb4aae
--- /dev/null
+++ b/tests/services/lease-heartbeat.test.ts
@@ -0,0 +1,48 @@
+import { describe, it, expect, beforeEach } from "vitest";
+import { openDb, type Db } from "../../src/db/index.js";
+import { createActor, type Actor } from "../../src/services/actors.js";
+import { createProject } from "../../src/services/projects.js";
+import { createIssue, updateIssue, claimIssue, getIssue } from "../../src/services/issues.js";
+import { getActiveLease, heartbeatLease } from "../../src/services/leases.js";
+import { getSetting } from "../../src/services/settings.js";
+
+let db: Db, human: Actor, agent: Actor;
+beforeEach(() => {
+  db = openDb(":memory:");
+  human = createActor(db, { name: "sean", type: "human" }).actor;
+  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
+  createProject(db, human, { key: "AIPI", name: "aipi" });
+  createIssue(db, human, { projectKey: "AIPI", title: "t" });
+  updateIssue(db, human, "AIPI-1", { status: "todo" });
+});
+
+describe("heartbeatLease", () => {
+  it("defaults heartbeat_window_seconds to 600 (= N x interval)", () => {
+    expect(getSetting(db, "claims.heartbeat_window_seconds")).toBe(600);
+  });
+
+  it("renews expires_at to now + heartbeat window (shorter than the 8h mint) and bumps last_beat_at", () => {
+    const { leaseToken } = claimIssue(db, agent, "AIPI-1");
+    const id = getIssue(db, "AIPI-1").id;
+    const minted = getActiveLease(db, id)!;
+    // the mint used the 8h interactive TTL
+    expect(minted.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 7 * 3600);
+
+    const beat = heartbeatLease(db, id, agent.id, leaseToken);
+    const window = getSetting(db, "claims.heartbeat_window_seconds");
+    const now = Math.floor(Date.now() / 1000);
+    // a heartbeat collapses the window to ~10 min of honest liveness
+    expect(beat.expiresAt).toBeLessThanOrEqual(now + window);
+    expect(beat.expiresAt).toBeGreaterThan(now + window - 5);
+    expect(beat.expiresAt).toBeLessThan(minted.expiresAt);
+    expect(beat.lastBeatAt).toBeGreaterThanOrEqual(minted.lastBeatAt);
+  });
+
+  it("rejects a wrong, absent, or non-holder token", () => {
+    const { leaseToken } = claimIssue(db, agent, "AIPI-1");
+    const id = getIssue(db, "AIPI-1").id;
+    expect(() => heartbeatLease(db, id, agent.id, "lease_wrong")).toThrow();
+    expect(() => heartbeatLease(db, id, agent.id, undefined)).toThrow();
+    expect(() => heartbeatLease(db, id, human.id, leaseToken)).toThrow(); // actor mismatch
+  });
+});
diff --git a/worker-sdk/sdk-runner.ts b/worker-sdk/sdk-runner.ts
index b8a4c79..a8f0f4f 100644
--- a/worker-sdk/sdk-runner.ts
+++ b/worker-sdk/sdk-runner.ts
@@ -21,10 +21,17 @@ export type SdkSessionOpts = {
   cwd: string;
   switchyardUrl: string;
   switchyardToken: string;
+  /** SYD-210 Layer B: the session-scoped claim lease, sent as the
+   * X-Switchyard-Lease MCP header so claim-scoped writes carry it — never in
+   * argv, never in the LLM transcript. Omitted for non-lease (answer) sessions. */
+  switchyardLeaseToken?: string;
   allowedTools: string[];
   logPath: string;
   /** Watchdog (SYD-115): abort the query if it runs longer than this. No timeout when omitted. */
   timeoutMs?: number;
+  /** SYD-210 Layer B: host-side cancellation — the worker aborts the query when
+   * its lease heartbeat has failed N times in a row. */
+  externalAbortSignal?: AbortSignal;
 };
 
 /** Run one issue's session to completion. Resolves to an exit-code-like
@@ -48,6 +55,12 @@ export async function runSdkSession(o: SdkSessionOpts): Promise<number> {
   // SDK's own cancellation mechanism — aborting stops the query and cleans
   // up its resources so the `finally` below always runs.
   const abortController = new AbortController();
+  // SYD-210 Layer B: fold the host's heartbeat-cancellation signal into the
+  // query's own abort so a lease the worker can no longer renew stops the run.
+  if (o.externalAbortSignal) {
+    if (o.externalAbortSignal.aborted) abortController.abort();
+    else o.externalAbortSignal.addEventListener("abort", () => abortController.abort());
+  }
   const watchdog =
     o.timeoutMs !== undefined
       ? setTimeout(() => {
@@ -55,6 +68,8 @@ export async function runSdkSession(o: SdkSessionOpts): Promise<number> {
           abortController.abort();
         }, o.timeoutMs)
       : null;
+  const headers: Record<string, string> = { Authorization: `Bearer ${o.switchyardToken}` };
+  if (o.switchyardLeaseToken) headers["X-Switchyard-Lease"] = o.switchyardLeaseToken;
   try {
     const stream = query({
       prompt: o.prompt,
@@ -67,7 +82,7 @@ export async function runSdkSession(o: SdkSessionOpts): Promise<number> {
           switchyard: {
             type: "http",
             url: `${o.switchyardUrl.replace(/\/$/, "")}/mcp`,
-            headers: { Authorization: `Bearer ${o.switchyardToken}` },
+            headers,
           },
         },
       },
```
