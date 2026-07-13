// Local-machine poller that dispatches ready Switchyard work to headless Claude
// Code sessions. Meant to run on Sean's Mac, one process, long-lived.
//
//   SWITCHYARD_TOKEN=... npx tsx scripts/agent-worker.ts                 # loop forever, both roles
//   SWITCHYARD_TOKEN=... npx tsx scripts/agent-worker.ts --role code     # dispatch todo issues only
//   SWITCHYARD_TOKEN=... npx tsx scripts/agent-worker.ts --role answer   # answer @agent questions only
//   SWITCHYARD_TOKEN=... npx tsx scripts/agent-worker.ts --once          # single tick
//   SWITCHYARD_TOKEN=... npx tsx scripts/agent-worker.ts --dry-run       # print, don't spawn
//
// Role split (SYD-67): "code" and "answer" are independently enableable — the
// answerer is cheap, read-only, and safe to leave running everywhere; the code
// role spawns containers that produce PRs and consume real capacity. Each role
// takes its own pidfile lock (worker.pid / worker-code.pid / worker-answer.pid)
// so "code" and "answer" can run side by side, but neither can double-run
// itself, and an "all" worker refuses to start while either single-role worker
// is running (and vice versa) — see checkRoleLockConflict.
//
// Besides the main issue poll (intervalSeconds), a lightweight event-feed poll
// (eventPollSeconds, default 15s) watches for needs_input_cleared — a human
// answering an escalation — and re-dispatches that issue within seconds instead
// of waiting for the next full tick (code role only). The same poll also
// watches for agent_question (SYD-56: a human comment leading with `@agent`)
// and dispatches a read-only answerer-mode session (answer role only) — it
// reads the issue/repo and posts a comment, never claims or transitions the
// issue, and runs on any status (including triage, since answering doesn't
// bypass the triage gate).
//
// The event poll's agent_question trigger is the fast path, not the guarantee: a
// question that lands while all maxAnswerConcurrent slots are busy would otherwise
// be silently dropped (SYD-60). The real guarantee is drainUnansweredQuestions, which
// derives "unanswered" from the event log (GET /api/unanswered-questions — an
// agent_question with no later agent-actor comment on the same issue) rather than
// in-memory state, so it's restart-proof. It runs on every full tick (answer role)
// and whenever an answer session slot frees, re-dispatching anything still
// unclaimed and under maxAnswersPerIssue.
//
// Config: switchyard-worker.json at the repo root (copy switchyard-worker.example.json).
// Safety model: the "auto" label (or whatever `label` is set to) is the human control
// point — nothing is dispatched unless a human labels the issue. maxConcurrent caps
// how many code-dispatch sessions can be running at once; maxAnswerConcurrent caps
// how many answer sessions can be running at once (its own pool, SYD-67 — the two no
// longer compete for the same slots); maxAnswersPerIssue additionally caps answer
// sessions per issue. Dispatched sessions still go through claim -> in_review ->
// human review; they can never reach `done` themselves.

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, mkdirSync, openSync, closeSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDotEnv, validateWorkerConfig } from "./init-worker-lib.js";
import {
  selectDispatchable,
  filterRetryCapped,
  recordAttempt,
  findResumeRefs,
  findAnswerRefs,
  filterAnswerCapped,
  recordAnswerAttempt,
  buildAnswerPrompt,
  ANSWER_ALLOWED_TOOLS,
  projectKeyOf,
  buildDockerArgs,
  newTickGate,
  runGated,
  answerKey,
  selectAnswerable,
  parseRole,
  configPathFromArgs,
  roleRunsCode,
  roleRunsAnswer,
  checkRoleLockConflict,
  workerPidFileName,
  remainingAnswerCapacity,
  DEFAULT_MAX_ANSWER_CONCURRENT,
  sessionTimeoutMs,
  withRetry,
  HttpStatusError,
  applyDispatchPolicy,
  containerNameFor,
  partitionContainerSessions,
  egressMode,
  ensureEgressGuard,
  type WorkerConfig,
  type WorkerProject,
  type WorkerIssue,
  type RetryState,
  type FeedEvent,
  type AnswerState,
  type WorkerRole,
  type DispatchPolicy,
  type RunningContainerSessionRow,
} from "./worker-select.js";
import { acquirePidLock, isLocked } from "./pidfile.js";
import { publishAgentBranch } from "./delivery-exec.js";
import { agentBranch, formatPublishOutcome, type DeliveryEventInput } from "./delivery-lib.js";

type ApiIssue = WorkerIssue & { title: string };

const DEFAULT_EVENT_POLL_SECONDS = 15;

// Ref -> running session. CLI dispatches hold their ChildProcess; SDK
// dispatches run in-process, so a marker is enough — the map only feeds
// maxConcurrent / maxAnswerConcurrent accounting (split by key suffix, see
// answerKey) and duplicate suppression.
export const active = new Map<string, ChildProcess | "sdk">();
// Per-ref dispatch mode, tracked alongside `active` (SYD-121): shutdown needs
// to know whether a tracked child is a bare host process it should kill, or a
// containerized session that's meant to survive a worker restart (it's the
// actual sandbox; killing it on every restart — including the automatic
// self-deploy restart, SYD-66 — would destroy in-flight work). "sdk" sessions
// run in-process and need no entry here: the worker exiting kills them for
// free.
export const activeMode = new Map<string, "cli" | "container">();
const retryState = new Map<string, RetryState>();
// Refs whose escalation was just answered — their next dispatch gets a prompt
// primed to read the answer. Populated by the event poll, consumed by tick().
const resumeRefs = new Set<string>();
let eventCursor: number | null = null;
const tickGate = newTickGate();
// Answerer mode (SYD-56): count of answer sessions dispatched per ref, kept
// separate from `active`'s work-session key so an answer and a work session
// can run concurrently on the same issue.
export const answerState: AnswerState = new Map();

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function defaultConfigPath(): string {
  return path.join(repoRoot(), "switchyard-worker.json");
}

/**
 * Fill missing process.env keys from the repo .env (0600). The worker reads
 * it directly — no shell sourcing — so launchd can exec tsx with no shell and
 * no secret ever appears in the plist or argv. Real environment wins.
 */
function loadDotEnv(): void {
  const envPath = path.join(repoRoot(), ".env");
  if (!existsSync(envPath)) return;
  for (const [key, value] of Object.entries(parseDotEnv(readFileSync(envPath, "utf8")))) {
    if (!(key in process.env)) process.env[key] = value;
  }
}

function loadConfig(configPath: string): WorkerConfig {
  if (!existsSync(configPath)) {
    throw new Error(
      `Missing ${configPath} — copy switchyard-worker.example.json to switchyard-worker.json and edit it.`,
    );
  }
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  // Refuse to start on a bad config rather than silently degrade — e.g.
  // runner:"sdk" + containerized:true would otherwise drop the Docker sandbox
  // the user thought they configured.
  const problems = validateWorkerConfig(raw);
  if (problems.length > 0) {
    throw new Error(`invalid ${configPath}:\n  - ${problems.join("\n  - ")}`);
  }
  return raw as WorkerConfig;
}

/** Records a structured delivery event (SYD-54) so the issue UI can render a
 * delivery strip — see src/services/delivery-events.ts for the server side.
 * Retries across a self-deploy restart (SYD-66: the tracker is down ~5-15s
 * during its own deploy, and a write landing in that window used to be
 * silently lost) and logs the payload if every attempt is exhausted, so the
 * caller's own catch/log (e.g. the pr_opened handler in dispatch()) still
 * has the error to report but nothing is lost silently before that. */
async function postDeliveryEvent(
  config: WorkerConfig,
  token: string,
  ref: string,
  input: DeliveryEventInput,
): Promise<void> {
  const url = `${config.url.replace(/\/$/, "")}/api/issues/${ref}/delivery-events`;
  const label = `POST delivery-events on ${ref}`;
  try {
    await withRetry(
      async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!res.ok)
          throw new HttpStatusError(
            res.status,
            `${label} failed: ${res.status} ${await res.text()}`,
          );
      },
      {
        onRetry: (attempt, err, delayMs) =>
          console.error(
            `retrying ${label} (attempt ${attempt}, in ${delayMs}ms): ${(err as Error).message}`,
          ),
      },
    );
  } catch (err) {
    console.error(
      `giving up on ${label} after retries: ${(err as Error).message}\n  payload: ${JSON.stringify(input)}`,
    );
    throw err;
  }
}

/** Session-lifecycle reporting (SYD-43): tells the tracker a session started
 * so the UI can show a live Agents panel. Best-effort — visibility must never
 * break dispatch — so every failure resolves to null after logging.
 * `onError`, when given, additionally mirrors the failure to the caller's
 * per-issue worker log (SYD-105) — console.error alone is easy to miss since
 * dispatched sessions' stdout/stderr already goes to that same log file. */
export async function reportSessionStart(
  config: WorkerConfig,
  token: string,
  input: { ref: string; mode: "cli" | "container" | "sdk"; pid: number | null },
  onError?: (message: string) => void,
): Promise<number | null> {
  const url = `${config.url.replace(/\/$/, "")}/api/agent-sessions`;
  try {
    return await withRetry(async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          `POST agent-sessions for ${input.ref} failed: ${res.status} ${await res.text()}`,
        );
      }
      return ((await res.json()) as { id: number }).id;
    });
  } catch (err) {
    const message = `could not report session start for ${input.ref}: ${(err as Error).message}`;
    console.error(message);
    onError?.(message);
    return null;
  }
}

/** Closes out a session started by reportSessionStart. Takes the id as a
 * promise so callers can wire it straight from the (unawaited) start call;
 * a null id (start never landed) is a silent no-op. Never rejects. See
 * reportSessionStart for the `onError` mirroring contract. */
export async function reportSessionEnd(
  config: WorkerConfig,
  token: string,
  sessionId: Promise<number | null>,
  exitCode: number | null,
  onError?: (message: string) => void,
): Promise<void> {
  const id = await sessionId;
  if (id === null) return;
  const url = `${config.url.replace(/\/$/, "")}/api/agent-sessions/${id}`;
  try {
    await withRetry(async () => {
      const res = await fetch(url, {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ exitCode }),
      });
      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          `PATCH agent-sessions/${id} failed: ${res.status} ${await res.text()}`,
        );
      }
    });
  } catch (err) {
    const message = `could not report session end ${id}: ${(err as Error).message}`;
    console.error(message);
    onError?.(message);
  }
}

async function fetchReadyIssues(config: WorkerConfig, token: string): Promise<ApiIssue[]> {
  const url = `${config.url.replace(/\/$/, "")}/api/issues?status=todo`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`GET /api/issues?status=todo failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as ApiIssue[];
}

async function fetchUnansweredQuestions(config: WorkerConfig, token: string): Promise<string[]> {
  const url = `${config.url.replace(/\/$/, "")}/api/unanswered-questions`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`GET /api/unanswered-questions failed: ${res.status} ${await res.text()}`);
  }
  const rows = (await res.json()) as { ref: string }[];
  return rows.map((r) => r.ref);
}

/**
 * Fetches the dispatch.* policy group (SYD-155) and overlays it onto `config`
 * in place — called at startup and before each main poll tick, so a human's
 * edit in the Settings UI takes effect within one poll interval, no launchd
 * restart. On fetch failure this logs and leaves `config` untouched: the
 * worker keeps running on the last-known values (the file's own values, on
 * the very first call).
 */
export async function refreshDispatchPolicy(config: WorkerConfig, token: string): Promise<void> {
  const url = `${config.url.replace(/\/$/, "")}/api/dispatch-policy`;
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new HttpStatusError(res.status, await res.text());
    applyDispatchPolicy(config, (await res.json()) as DispatchPolicy);
  } catch (err) {
    console.error(
      `could not fetch dispatch policy, keeping last-known values: ${(err as Error).message}`,
    );
  }
}

/**
 * Pre-claims `ref` on the tracker host-side, before dispatch (SYD-122):
 * closes the cross-machine race where two workers (or a worker and a
 * coordinating human session) both select the same unassigned todo and spin
 * up sessions before either calls claim_issue — selection and claim are now
 * atomic from this worker's side, not just from the dispatched session's.
 * The session still calls claim_issue itself per the prompt, but that just
 * reclaims the same actor's own issue at that point (a no-op check) since
 * the session authenticates with this same worker's token.
 *
 * A refusal (already claimed, now blocked) means another actor won the race
 * — logged and treated as "skip this ref", not an error: it needs no retry
 * bookkeeping here, since the issue's assigneeId will be non-null on the
 * next poll and selectDispatchable naturally stops offering it. Network/5xx
 * failures still retry across a self-deploy restart via withRetry, same as
 * the other tracker writes.
 */
async function claimIssueHost(config: WorkerConfig, token: string, ref: string): Promise<boolean> {
  const url = `${config.url.replace(/\/$/, "")}/api/issues/${ref}/claim`;
  try {
    await withRetry(async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new HttpStatusError(res.status, await res.text());
    });
    return true;
  } catch (err) {
    if (err instanceof HttpStatusError && err.status < 500) {
      console.log(`skipping ${ref}: lost the claim race (${err.message})`);
    } else {
      console.error(`could not claim ${ref} before dispatch: ${(err as Error).message}`);
    }
    return false;
  }
}

export function buildPrompt(ref: string, opts: { resumed?: boolean } = {}): string {
  const resumedPreamble = opts.resumed
    ? `You previously escalated a question on Switchyard issue ${ref} and a human ` +
      `has now answered it. Call get_issue first and read the activity feed for ` +
      `the answer, then continue the work from where the escalation left off. `
    : "";
  return (
    resumedPreamble +
    `Work Switchyard issue ${ref} using the switchyard MCP tools. ` +
    `Call claim_issue first. ` +
    `Record a one-line note with the progress_note tool each time you start a new ` +
    `step (reading code, writing tests, implementing, verifying) so humans can ` +
    `watch progress live. ` +
    `Implement the work with tests. Comment verification ` +
    `evidence describing what you did and how you verified it, then move the issue ` +
    `to in_review. Never move it to done — a human or review step does that. ` +
    `If you are blocked on a decision only a human can make, call request_human_input ` +
    `with your question and stop.`
  );
}

/** Fire-and-forget trigger for the unanswered-questions backstop (SYD-60), used from
 * the slot-freeing callbacks below — none of them are awaited, so errors are caught
 * and logged here rather than becoming an unhandled rejection. */
function triggerUnansweredDrain(config: WorkerConfig, token: string): void {
  drainUnansweredQuestions(config, token, { dryRun: false }).catch((err: Error) =>
    console.error(`unanswered-questions drain failed: ${err.message}`),
  );
}

const SIGKILL_GRACE_MS = 10_000;

/**
 * Kills a dispatched CLI session's process on watchdog timeout (SYD-115):
 * SIGTERM first, escalating to SIGKILL after a grace period if it's still
 * alive. `containerName` is the deterministic `syd-<ref>` name buildDockerArgs
 * gives a containerized dispatch — it's `docker kill`ed directly rather than
 * relying on the local `docker run` client process to notice its own SIGTERM
 * and stop the container it's attached to.
 */
function killSession(child: ChildProcess, containerName: string | null): void {
  if (containerName) {
    spawn("docker", ["kill", containerName], { stdio: "ignore" }).on("error", () => {});
  }
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, SIGKILL_GRACE_MS);
}

/**
 * Shared session-finished bookkeeping: reports the exit to the tracker and,
 * for a containerized session, publishes the pushed agent/<ref> branch as a
 * PR (SYD-49). Factored out of `dispatch`'s `child.on("exit", ...)` so the
 * SYD-121 startup reconciler's adopted sessions (see `adoptContainerSession`)
 * get the exact same delivery wiring a live dispatch would have — a session
 * that survives a worker restart still needs its exit reported and its
 * branch published, not just silently forgotten.
 */
function finishSessionExit(
  ref: string,
  issueTitle: string,
  project: WorkerProject,
  config: WorkerConfig,
  token: string,
  sessionId: Promise<number | null>,
  exitCode: number | null,
  logLine: (text: string) => void,
): void {
  void reportSessionEnd(config, token, sessionId, exitCode, (message) =>
    logLine(`[worker] ${message}\n`),
  );
  console.log(`${ref} exited with code ${exitCode}`);
  logLine(`\n[worker] exited with code ${exitCode}\n`);
  // Delivery gate (SYD-49): a containerized session that pushed agent/<ref>
  // gets its branch published to GitHub as a PR, host-side (gh + git auth
  // live here, never in the container). Merging still waits for a human
  // done-stamp via scripts/deliver.ts. Publish fires on commit count alone,
  // independent of a clean exit (SYD-118) — an errored/killed session that
  // still committed partial work opens a PR too, so `exitCode` is passed
  // through to mark the PR body when it isn't a clean exit.
  if (config.containerized && config.delivery && config.delivery.openPrs !== false) {
    publishAgentBranch(project.repo, ref, issueTitle, config.url, exitCode)
      .then((outcome) => {
        const line = formatPublishOutcome(agentBranch(ref), outcome);
        console.log(`${ref}: ${line}`);
        logLine(`[worker] ${line}\n`);
        if (
          (outcome.status === "opened" || outcome.status === "already-open") &&
          outcome.prNumber !== null
        ) {
          postDeliveryEvent(config, token, ref, {
            type: "pr_opened",
            prNumber: outcome.prNumber,
            url: outcome.url,
          }).catch((err: Error) => {
            console.error(`could not record pr_opened event for ${ref}: ${err.message}`);
            logLine(`[worker] could not record pr_opened event: ${err.message}\n`);
          });
        }
      })
      .catch((err: Error) => {
        console.error(`publish failed for ${ref}: ${err.message}`);
        logLine(`[worker] publish failed: ${err.message}\n`);
      });
  }
}

// Exported for tests (SYD-105): lets the session-reporting integration test
// below drive dispatch() end to end (spawn -> reportSessionStart, exit ->
// reportSessionEnd) rather than only exercising the two helpers in isolation.
export function dispatch(
  issue: ApiIssue,
  config: WorkerConfig,
  token: string,
  role: WorkerRole,
  opts: { resumed?: boolean } = {},
): void {
  const project = config.projects[projectKeyOf(issue.ref)];
  const logDir = path.join(project.repo, ".superpowers", "worker-logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${issue.ref}.log`);

  if ((config.runner ?? "cli") === "sdk") {
    dispatchSdk(issue, project.repo, config, token, role, logPath, opts);
    return;
  }

  const logLine = (text: string) => {
    try {
      appendFileSync(logPath, text);
    } catch (err) {
      console.error(`could not append to ${logPath}: ${(err as Error).message}`);
    }
  };

  const fd = openSync(logPath, "a");

  let child: ChildProcess;
  try {
    if (config.containerized) {
      // The container is the sandbox: it clones the repo internally, works on
      // a branch, and pushes it back out — it never touches this host
      // filesystem beyond the /origin mount. See scripts/container-entry.sh.
      const dockerArgs = buildDockerArgs(issue, project, config, process.env, opts);
      child = spawn("docker", dockerArgs, {
        detached: true,
        stdio: ["ignore", fd, fd],
      });
    } else {
      // Headless sessions can't answer permission prompts — grant the tools the
      // work needs up front. The "auto" label is the human's consent for this.
      const allowedTools = config.allowedTools ?? [
        "mcp__switchyard__*",
        "Bash",
        "Read",
        "Edit",
        "Write",
        "Grep",
        "Glob",
      ];
      child = spawn(
        "claude",
        [
          "-p",
          buildPrompt(issue.ref, opts),
          "--permission-mode",
          "acceptEdits",
          "--allowedTools",
          allowedTools.join(","),
        ],
        {
          cwd: project.repo,
          detached: true,
          stdio: ["ignore", fd, fd],
        },
      );
    }
  } catch (err) {
    console.error(`failed to dispatch ${issue.ref}: ${(err as Error).message}`);
    return;
  } finally {
    closeSync(fd);
  }

  active.set(issue.ref, child);
  activeMode.set(issue.ref, config.containerized ? "container" : "cli");
  console.log(`dispatched ${issue.ref} (pid ${child.pid}) -> ${logPath}`);

  // Watchdog (SYD-115): a hung `claude -p` or stuck `docker run` would
  // otherwise hold this maxConcurrent slot forever. Cleared on exit/error
  // below so a session that finishes normally never gets killed late.
  const timeoutMs = sessionTimeoutMs(config);
  const watchdog = setTimeout(() => {
    console.error(`${issue.ref}: session exceeded ${timeoutMs / 1000}s watchdog timeout — killing`);
    logLine(`[worker] session exceeded ${timeoutMs / 1000}s watchdog timeout — killing\n`);
    killSession(child, config.containerized ? `syd-${issue.ref}` : null);
  }, timeoutMs);

  // 'spawn' only fires once the OS actually launched the process (see the
  // SYD-74 note in dispatchAnswer) — a failed spawn never creates a session.
  let sessionId: Promise<number | null> = Promise.resolve(null);
  child.on("spawn", () => {
    sessionId = reportSessionStart(
      config,
      token,
      {
        ref: issue.ref,
        mode: config.containerized ? "container" : "cli",
        pid: child.pid ?? null,
      },
      (message) => logLine(`[worker] ${message}\n`),
    );
  });

  child.on("exit", (code) => {
    clearTimeout(watchdog);
    active.delete(issue.ref);
    activeMode.delete(issue.ref);
    if (roleRunsAnswer(role)) triggerUnansweredDrain(config, token);
    finishSessionExit(issue.ref, issue.title, project, config, token, sessionId, code, logLine);
  });

  child.on("error", (err) => {
    clearTimeout(watchdog);
    active.delete(issue.ref);
    activeMode.delete(issue.ref);
    // 'error' can fire after a successful 'spawn' with no 'exit' to follow —
    // close the session (no-op when spawn never happened: sessionId is null).
    void reportSessionEnd(config, token, sessionId, null, (message) =>
      logLine(`[worker] ${message}\n`),
    );
    console.error(`failed to spawn claude for ${issue.ref}: ${err.message}`);
  });
}

/**
 * In-process dispatch through the Claude Agent SDK (runner: "sdk"). The
 * runner module is imported via a runtime-computed path so machines running
 * CLI mode — and the main `tsc` pass / server Docker image — never depend on
 * worker-sdk/ being installed.
 */
function dispatchSdk(
  issue: ApiIssue,
  repo: string,
  config: WorkerConfig,
  token: string,
  role: WorkerRole,
  logPath: string,
  opts: { resumed?: boolean },
): void {
  const allowedTools = config.allowedTools ?? [
    "mcp__switchyard__*",
    "Bash",
    "Read",
    "Edit",
    "Write",
    "Grep",
    "Glob",
  ];
  // A log-write failure (dir deleted, disk full) must never leak the active
  // slot or reject the chain — one bad append would otherwise crash the whole
  // worker via an unhandled rejection.
  const safeAppend = (text: string) => {
    try {
      appendFileSync(logPath, text);
    } catch (err) {
      console.error(`could not write ${logPath}: ${(err as Error).message}`);
    }
  };
  active.set(issue.ref, "sdk");
  console.log(`dispatched ${issue.ref} (sdk session) -> ${logPath}`);
  safeAppend(`[worker] sdk session starting for ${issue.ref}\n`);
  const sessionId = reportSessionStart(
    config,
    token,
    { ref: issue.ref, mode: "sdk", pid: null },
    (message) => safeAppend(`[worker] ${message}\n`),
  );

  const runnerPath = path.join(repoRoot(), "worker-sdk", "sdk-runner.ts");
  import(runnerPath)
    .then((mod: { runSdkSession: (o: object) => Promise<number> }) =>
      mod.runSdkSession({
        prompt: buildPrompt(issue.ref, opts),
        cwd: repo,
        switchyardUrl: config.url,
        switchyardToken: token,
        allowedTools,
        logPath,
        timeoutMs: sessionTimeoutMs(config),
      }),
    )
    .then(
      (code) => {
        console.log(`${issue.ref} sdk session finished with code ${code}`);
        safeAppend(`[worker] exited with code ${code}\n`);
        void reportSessionEnd(config, token, sessionId, code, (message) =>
          safeAppend(`[worker] ${message}\n`),
        );
      },
      (err: Error) => {
        console.error(`sdk dispatch failed for ${issue.ref}: ${err.message}`);
        safeAppend(
          `[worker] sdk dispatch failed: ${err.message}\n` +
            `[worker] is worker-sdk installed? run: npm install --prefix worker-sdk\n`,
        );
        void reportSessionEnd(config, token, sessionId, null, (message) =>
          safeAppend(`[worker] ${message}\n`),
        );
      },
    )
    .catch((err: Error) =>
      console.error(`sdk dispatch cleanup error for ${issue.ref}: ${err.message}`),
    )
    .finally(() => {
      active.delete(issue.ref);
      if (roleRunsAnswer(role)) triggerUnansweredDrain(config, token);
    });
}

/**
 * Dispatches a read-only answerer-mode session (SYD-56) for `ref`: its own
 * maxAnswerConcurrent pool, independent of work dispatch's maxConcurrent
 * (SYD-67), plus a per-issue answer cap, restricted to ANSWER_ALLOWED_TOOLS
 * so it cannot claim, transition, or edit anything — it can only read and
 * post a comment. Runs bare-host (never containerized): read-only work
 * doesn't need the branch/push sandbox containerized mode exists for.
 */
export function dispatchAnswer(
  ref: string,
  config: WorkerConfig,
  token: string,
  opts: { dryRun: boolean },
): void {
  const key = answerKey(ref);
  if (active.has(key)) return;
  if (remainingAnswerCapacity(config, active.keys()) <= 0) {
    console.log(`answer session for ${ref} deferred: at maxAnswerConcurrent capacity`);
    return;
  }
  if (filterAnswerCapped([ref], answerState, config.maxAnswersPerIssue).length === 0) {
    console.log(`answer session for ${ref} skipped: answers-per-issue cap reached`);
    return;
  }

  const project = config.projects[projectKeyOf(ref)];
  if (!project) return; // findAnswerRefs already filters to configured projects

  if (opts.dryRun) {
    console.log(`[dry-run] would dispatch answer session for ${ref}`);
    return;
  }

  const logDir = path.join(project.repo, ".superpowers", "worker-logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${ref}.answer.log`);

  if ((config.runner ?? "cli") === "sdk") {
    recordAnswerAttempt(answerState, ref);
    dispatchAnswerSdk(ref, project.repo, config, token, logPath);
    return;
  }

  const fd = openSync(logPath, "a");
  let child: ChildProcess;
  try {
    child = spawn(
      "claude",
      ["-p", buildAnswerPrompt(ref), "--allowedTools", ANSWER_ALLOWED_TOOLS.join(",")],
      { cwd: project.repo, detached: true, stdio: ["ignore", fd, fd] },
    );
  } catch (err) {
    console.error(`failed to dispatch answer session for ${ref}: ${(err as Error).message}`);
    return;
  } finally {
    closeSync(fd);
  }

  active.set(key, child);
  activeMode.set(key, "cli");

  // Watchdog (SYD-115): answer sessions share the same hung-process risk as
  // work dispatch and would otherwise hold a maxAnswerConcurrent slot
  // forever. Never containerized (see the module comment above), so there's
  // no container name to kill.
  const timeoutMs = sessionTimeoutMs(config);
  const watchdog = setTimeout(() => {
    console.error(
      `answer session for ${ref} exceeded ${timeoutMs / 1000}s watchdog timeout — killing`,
    );
    killSession(child, null);
  }, timeoutMs);

  // `child.pid` is only populated once the OS has actually spawned the
  // process; reading it synchronously here printed `pid undefined` on a
  // spawn failure (e.g. ENOENT for a bare `claude` not on launchd's PATH —
  // SYD-74), since the 'error' event fires on a later tick. Waiting for
  // 'spawn' also means a failed spawn never reaches recordAnswerAttempt, so
  // environment errors can't eat the answers-per-issue cap.
  child.on("spawn", () => {
    recordAnswerAttempt(answerState, ref);
    console.log(`dispatched answer session for ${ref} (pid ${child.pid}) -> ${logPath}`);
  });

  child.on("exit", (code) => {
    clearTimeout(watchdog);
    active.delete(key);
    activeMode.delete(key);
    triggerUnansweredDrain(config, token);
    console.log(`answer session for ${ref} exited with code ${code}`);
  });
  child.on("error", (err) => {
    clearTimeout(watchdog);
    active.delete(key);
    activeMode.delete(key);
    console.error(`failed to spawn answer session for ${ref}: ${err.message}`);
  });
}

/** In-process SDK dispatch for answerer mode — mirrors `dispatchSdk`, restricted to ANSWER_ALLOWED_TOOLS. */
function dispatchAnswerSdk(
  ref: string,
  repo: string,
  config: WorkerConfig,
  token: string,
  logPath: string,
): void {
  const key = answerKey(ref);
  const safeAppend = (text: string) => {
    try {
      appendFileSync(logPath, text);
    } catch (err) {
      console.error(`could not write ${logPath}: ${(err as Error).message}`);
    }
  };
  active.set(key, "sdk");
  console.log(`dispatched answer session for ${ref} (sdk session) -> ${logPath}`);
  safeAppend(`[worker] sdk answer session starting for ${ref}\n`);

  const runnerPath = path.join(repoRoot(), "worker-sdk", "sdk-runner.ts");
  import(runnerPath)
    .then((mod: { runSdkSession: (o: object) => Promise<number> }) =>
      mod.runSdkSession({
        prompt: buildAnswerPrompt(ref),
        cwd: repo,
        switchyardUrl: config.url,
        switchyardToken: token,
        allowedTools: ANSWER_ALLOWED_TOOLS,
        logPath,
        timeoutMs: sessionTimeoutMs(config),
      }),
    )
    .then(
      (code) => {
        console.log(`answer session for ${ref} finished with code ${code}`);
        safeAppend(`[worker] exited with code ${code}\n`);
      },
      (err: Error) => {
        console.error(`sdk answer dispatch failed for ${ref}: ${err.message}`);
        safeAppend(`[worker] sdk answer dispatch failed: ${err.message}\n`);
      },
    )
    .catch((err: Error) =>
      console.error(`sdk answer dispatch cleanup error for ${ref}: ${err.message}`),
    )
    .finally(() => {
      active.delete(key);
      triggerUnansweredDrain(config, token);
    });
}

/**
 * Restart-proof backstop for answerer mode (SYD-60): re-derives unanswered
 * @agent questions from the event log via GET /api/unanswered-questions
 * (rather than trusting in-memory state) and dispatches an answer session
 * for each one still eligible. Called on every tick and whenever an answer
 * session slot frees, so a question deferred at maxAnswerConcurrent capacity
 * — or asked while the worker was down or mid-restart — still gets serviced once
 * capacity exists, without depending on the event-poll fast path (pollEvents
 * / findAnswerRefs) having caught the original agent_question event.
 */
async function drainUnansweredQuestions(
  config: WorkerConfig,
  token: string,
  opts: { dryRun: boolean },
): Promise<void> {
  let refs: string[];
  try {
    refs = await fetchUnansweredQuestions(config, token);
  } catch (err) {
    console.error(`unanswered-questions poll failed: ${(err as Error).message}`);
    return;
  }
  const selected = selectAnswerable(refs, config, active.keys(), answerState);
  for (const ref of selected) {
    console.log(`unanswered question on ${ref} — dispatching an answer session`);
    dispatchAnswer(ref, config, token, opts);
  }
}

/**
 * The periodic poll, filtered by `role` (SYD-67): the code half (fetch
 * ready issues, dispatch work sessions) only runs for "code"/"all"; the
 * unanswered-questions recheck only runs for "answer"/"all". A single tick
 * gate still serializes the whole thing so an event-poll-triggered tick
 * never races the interval tick, regardless of which halves are active.
 * Each selected issue is claimed host-side (claimIssueHost, SYD-122) right
 * before dispatch — a claim refusal means another actor won the race, so
 * that ref is skipped rather than dispatched.
 */
export async function runTick(
  config: WorkerConfig,
  token: string,
  role: WorkerRole,
  opts: { dryRun: boolean },
): Promise<void> {
  await runGated(tickGate, async () => {
    if (roleRunsCode(role)) {
      try {
        const issues = await fetchReadyIssues(config, token);
        const eligible = filterRetryCapped(issues, retryState);
        const selected = selectDispatchable(eligible, config, active.keys());

        for (const issue of selected) {
          if (opts.dryRun) {
            recordAttempt(retryState, issue.ref, issue.updatedAt);
            const resumed = resumeRefs.delete(issue.ref);
            console.log(
              `[dry-run] would dispatch ${issue.ref}${resumed ? " (resumed)" : ""}: ${issue.title}`,
            );
            continue;
          }
          if (!(await claimIssueHost(config, token, issue.ref))) continue;
          recordAttempt(retryState, issue.ref, issue.updatedAt);
          const resumed = resumeRefs.delete(issue.ref);
          dispatch(issue, config, token, role, { resumed });
        }
      } catch (err) {
        console.error(`poll failed: ${(err as Error).message}`);
      }
    }
    // The recheck runs every tick regardless of whether work dispatch above
    // found anything or failed — it's an independent guarantee, not a
    // continuation of the ready-issues poll.
    if (roleRunsAnswer(role)) {
      await drainUnansweredQuestions(config, token, opts);
    }
  });
}

/**
 * Fast, cheap scan of the global event feed for answered escalations
 * (needs_input_cleared) and questions addressed to agents (agent_question,
 * SYD-56). The server releases the claim when an escalation is answered, so
 * that issue is already back in `todo` — this poll just collapses the wait
 * for the next full tick from `intervalSeconds` down to `eventPollSeconds`,
 * and primes the resumed session's prompt to read the answer. An
 * agent_question dispatches a read-only answerer-mode session immediately,
 * independent of the issue's status (answering doesn't touch the triage
 * gate — see dispatchAnswer). `role` (SYD-67) gates which half acts: a
 * "code"-only worker never dispatches answer sessions; an "answer"-only
 * worker never resumes work dispatch. Both scans always run regardless of
 * role so the shared eventCursor still advances correctly either way.
 */
async function pollEvents(
  config: WorkerConfig,
  token: string,
  role: WorkerRole,
  opts: { dryRun: boolean },
): Promise<void> {
  const url = `${config.url.replace(/\/$/, "")}/api/events?limit=100`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`GET /api/events failed: ${res.status} ${await res.text()}`);
  }
  const feed = (await res.json()) as FeedEvent[];
  const { refs, lastEventId } = findResumeRefs(feed, config, eventCursor);
  const { refs: answerRefs } = findAnswerRefs(feed, config, eventCursor);
  eventCursor = lastEventId;

  if (roleRunsAnswer(role)) {
    for (const ref of answerRefs) {
      console.log(`question addressed to an agent on ${ref} — dispatching an answer session`);
      dispatchAnswer(ref, config, token, opts);
    }
  }

  if (roleRunsCode(role) && refs.length > 0) {
    for (const ref of refs) resumeRefs.add(ref);
    console.log(`escalation answered on ${refs.join(", ")} — dispatching now`);
    await runTick(config, token, role, opts);
  }
}

const SHUTDOWN_GRACE_MS = 5000;

/**
 * Best-effort teardown for tracked children on worker shutdown (SYD-121):
 * children are spawned `detached: true` so a bare `process.exit()` leaves
 * them running as orphans. For a bare-host `claude -p` session (mode "cli")
 * there's no way to reconnect to it later, so this sends SIGTERM to its whole
 * process group (detached spawn makes `pid` its own pgid, so `-pid` reaches
 * any children it spawned too), waits up to `graceMs`, and escalates to
 * SIGKILL if it's still alive. A containerized session (mode "container") is
 * deliberately left alone — it's the actual sandbox executing the work, and
 * the next startup's `reconcileContainerSessions` re-adopts it rather than
 * losing the work to a restart. "sdk" sessions run in-process and need no
 * signal at all. `killFn` is injectable so tests don't need a real process
 * group to signal.
 */
export async function killActiveSessions(
  active: ReadonlyMap<string, ChildProcess | "sdk">,
  activeMode: ReadonlyMap<string, "cli" | "container">,
  opts: { killFn?: (pid: number, signal: NodeJS.Signals) => void; graceMs?: number } = {},
): Promise<void> {
  const killFn = opts.killFn ?? ((pid, signal) => process.kill(pid, signal));
  const graceMs = opts.graceMs ?? SHUTDOWN_GRACE_MS;

  const waits: Promise<void>[] = [];
  for (const [key, child] of active) {
    if (child === "sdk") continue;
    if (activeMode.get(key) === "container") continue;
    const pid = child.pid;
    if (pid === undefined || child.exitCode !== null) continue;
    try {
      killFn(-pid, "SIGTERM");
    } catch {
      continue; // already gone
    }
    waits.push(
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            killFn(-pid, "SIGKILL");
          } catch {
            // already gone
          }
          resolve();
        }, graceMs);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      }),
    );
  }
  await Promise.all(waits);
}

const execFileP = promisify(execFile);

/**
 * Names of currently-running Docker containers this worker could plausibly
 * own (SYD-121) — every containerized dispatch names its container via
 * `containerNameFor`, so filtering on that prefix scopes the query away from
 * unrelated containers on the same host.
 */
async function listLiveContainerNames(): Promise<Set<string>> {
  const { stdout } = await execFileP("docker", [
    "ps",
    "--filter",
    "name=syd-",
    "--format",
    "{{.Names}}",
  ]);
  return new Set(
    stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

async function fetchRunningContainerSessions(
  config: WorkerConfig,
  token: string,
): Promise<RunningContainerSessionRow[]> {
  const url = `${config.url.replace(/\/$/, "")}/api/agent-sessions?active=true`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(
      `GET /api/agent-sessions?active=true failed: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as RunningContainerSessionRow[];
}

/**
 * Re-attaches a still-running containerized session's exit handling after a
 * worker restart (SYD-121). `docker wait <name>` blocks until the container
 * stops and prints its exit code on stdout — treating that as the child
 * process feeds the exact same `finishSessionExit` flow (report the exit,
 * publish the branch as a PR) a live dispatch uses, and keeps the ref in
 * `active` so the next tick won't try to dispatch it again (which would
 * collide on the still-in-use container name).
 */
export function adoptContainerSession(
  session: RunningContainerSessionRow,
  config: WorkerConfig,
  token: string,
): void {
  const project = config.projects[projectKeyOf(session.ref)];
  if (!project) return;

  const logDir = path.join(project.repo, ".superpowers", "worker-logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${session.ref}.log`);
  const logLine = (text: string) => {
    try {
      appendFileSync(logPath, text);
    } catch (err) {
      console.error(`could not append to ${logPath}: ${(err as Error).message}`);
    }
  };

  const child = spawn("docker", ["wait", containerNameFor(session.ref)], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  active.set(session.ref, child);
  activeMode.set(session.ref, "container");
  console.log(`adopted ${session.ref}: still-running container from before the restart`);
  logLine(`[worker] adopted running container after a worker restart\n`);

  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  child.on("exit", () => {
    active.delete(session.ref);
    activeMode.delete(session.ref);
    const parsed = Number.parseInt(output.trim(), 10);
    const exitCode = Number.isFinite(parsed) ? parsed : null;
    finishSessionExit(
      session.ref,
      session.issueTitle,
      project,
      config,
      token,
      Promise.resolve(session.id),
      exitCode,
      logLine,
    );
  });
  child.on("error", (err) => {
    active.delete(session.ref);
    activeMode.delete(session.ref);
    console.error(`failed to adopt container session for ${session.ref}: ${err.message}`);
  });
}

/**
 * Startup reconciliation (SYD-121): a containerized session survives its
 * worker process dying (see `killActiveSessions`), but a freshly-started
 * process has no record of it in `active` — nobody would dedupe against it
 * (docker `--name` collision on re-dispatch) or ever report its exit (a
 * session stuck "running" forever in the Agents panel, with its branch never
 * published). Diffs the tracker's recorded-running container sessions
 * against `docker ps`: a session whose container is still alive gets adopted
 * (see `adoptContainerSession`); one whose container is gone already exited
 * with nobody around to report it, so it's closed out now rather than left
 * for the server's time-based `sweepOrphanedAgentSessions` (default 12h) to
 * eventually catch. Only meaningful when this worker runs containerized
 * dispatch at all. Best-effort: a docker or tracker failure here must never
 * block the worker from starting its normal poll loop.
 *
 * `deps.listLiveContainerNames`/`deps.adopt` default to the real docker/adopt
 * implementations; tests inject fakes so they don't need a real Docker daemon.
 */
export async function reconcileContainerSessions(
  config: WorkerConfig,
  token: string,
  deps: {
    listLiveContainerNames?: () => Promise<Set<string>>;
    adopt?: (session: RunningContainerSessionRow, config: WorkerConfig, token: string) => void;
  } = {},
): Promise<void> {
  if (!config.containerized) return;
  const listNames = deps.listLiveContainerNames ?? listLiveContainerNames;
  const adopt = deps.adopt ?? adoptContainerSession;

  let liveNames: Set<string>;
  try {
    liveNames = await listNames();
  } catch (err) {
    console.error(`startup reconciliation: docker ps failed, skipping: ${(err as Error).message}`);
    return;
  }

  let sessions: RunningContainerSessionRow[];
  try {
    sessions = await fetchRunningContainerSessions(config, token);
  } catch (err) {
    console.error(
      `startup reconciliation: fetching agent sessions failed, skipping: ${(err as Error).message}`,
    );
    return;
  }

  const { orphaned, live } = partitionContainerSessions(sessions, liveNames);
  for (const session of orphaned) {
    console.log(
      `reconcile: ${session.ref} has no running container — closing stuck session ${session.id}`,
    );
    await reportSessionEnd(config, token, Promise.resolve(session.id), null);
  }
  for (const session of live) {
    adopt(session, config, token);
  }
}

/**
 * Acquires the single-instance pidfile lock for `role` (SYD-67): each role
 * gets its own pidfile (worker.pid / worker-code.pid / worker-answer.pid) so
 * "code" and "answer" workers can run side by side, but an "all" worker and
 * any single-role worker refuse to start together — see
 * checkRoleLockConflict for the exclusion rule.
 */
function acquireRoleLock(role: WorkerRole): () => void {
  const dir = path.join(repoRoot(), ".superpowers");
  const paths = {
    all: path.join(dir, workerPidFileName("all")),
    code: path.join(dir, workerPidFileName("code")),
    answer: path.join(dir, workerPidFileName("answer")),
  };
  const conflict = checkRoleLockConflict(role, {
    all: isLocked(paths.all),
    code: isLocked(paths.code),
    answer: isLocked(paths.answer),
  });
  if (conflict) throw new Error(conflict);
  const target = role === "all" ? paths.all : role === "code" ? paths.code : paths.answer;
  return acquirePidLock(
    target,
    "stop it first (launchctl unload the matching com.switchyard.worker* LaunchAgent, or kill the pid)",
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const once = args.includes("--once");
  const dryRun = args.includes("--dry-run");
  const role = parseRole(args);

  loadDotEnv();

  // Load config first so a second worker process (`--config
  // switchyard-worker.codex.json`) can name its own token env var (`token:
  // "SWITCHYARD_CODEX_TOKEN"`) — the secret stays in .env, never in the plist.
  const config = loadConfig(configPathFromArgs(args, defaultConfigPath(), repoRoot()));
  const tokenVar = config.token ?? "SWITCHYARD_TOKEN";
  const token = process.env[tokenVar];
  if (!token) {
    console.error(`${tokenVar} is required (set it in the environment or the repo .env)`);
    process.exit(1);
  }
  await refreshDispatchPolicy(config, token);

  // SYD-110: containerized sessions only run behind the egress allowlist.
  // Refusing to start beats silently dispatching with full egress — the
  // explicit opt-out is `egress: "open"` in switchyard-worker.json.
  if (config.containerized && egressMode(config) === "proxy") {
    try {
      await ensureEgressGuard(config, async (cmd, cmdArgs) => execFileP(cmd, cmdArgs), process.env);
    } catch (err) {
      console.error(
        `FATAL: could not set up the egress guard (SYD-110): ${(err as Error).message}\n` +
          "Build the proxy image with `npm run build:worker-image`, or set egress: \"open\" " +
          "in switchyard-worker.json to explicitly opt out of the allowlist.",
      );
      process.exit(1);
    }
  }

  if (once) {
    // Single ticks (incl. init-worker's --self-test) may run alongside a live
    // loop — only the loop takes the single-instance lock.
    await runTick(config, token, role, { dryRun });
    return;
  }

  const releaseLock = acquireRoleLock(role);
  if (!dryRun) {
    await reconcileContainerSessions(config, token).catch((err: Error) =>
      console.error(`startup reconciliation failed: ${err.message}`),
    );
  }
  await runTick(config, token, role, { dryRun });

  console.log(
    `role=${role} polling every ${config.intervalSeconds}s, event feed every ${config.eventPollSeconds ?? DEFAULT_EVENT_POLL_SECONDS}s ` +
      `(maxConcurrent=${config.maxConcurrent}, maxAnswerConcurrent=${config.maxAnswerConcurrent ?? DEFAULT_MAX_ANSWER_CONCURRENT}, label="${config.label}")`,
  );

  // Self-rescheduling setTimeout loops (rather than setInterval) so that a
  // dispatch-policy fetch changing config.intervalSeconds/eventPollSeconds
  // mid-run actually changes the cadence of the *next* fire, not just next
  // process start.
  let stopped = false;
  let tickTimer: NodeJS.Timeout;
  let eventTimer: NodeJS.Timeout;

  const scheduleTick = () => {
    if (stopped) return;
    tickTimer = setTimeout(async () => {
      await refreshDispatchPolicy(config, token);
      try {
        await runTick(config, token, role, { dryRun });
      } catch (err) {
        console.error(`tick failed: ${(err as Error).message}`);
      }
      scheduleTick();
    }, config.intervalSeconds * 1000);
  };
  const scheduleEventPoll = () => {
    if (stopped) return;
    eventTimer = setTimeout(
      async () => {
        try {
          await pollEvents(config, token, role, { dryRun });
        } catch (err) {
          console.error(`event poll failed: ${(err as Error).message}`);
        }
        scheduleEventPoll();
      },
      (config.eventPollSeconds ?? DEFAULT_EVENT_POLL_SECONDS) * 1000,
    );
  };
  scheduleTick();
  scheduleEventPoll();

  // Kills tracked children before releasing the lock and exiting (SYD-121) —
  // see killActiveSessions for what "kill" means per session mode. Async, so
  // the signal handler awaits it before actually exiting the process.
  const shutdown = async (): Promise<void> => {
    stopped = true;
    clearTimeout(tickTimer);
    clearTimeout(eventTimer);
    await killActiveSessions(active, activeMode);
    releaseLock();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("exit", releaseLock);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
