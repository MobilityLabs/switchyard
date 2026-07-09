// Local-machine poller that dispatches ready Switchyard work to headless Claude
// Code sessions. Meant to run on Sean's Mac, one process, long-lived.
//
//   SWITCHYARD_TOKEN=... npx tsx scripts/agent-worker.ts            # loop forever
//   SWITCHYARD_TOKEN=... npx tsx scripts/agent-worker.ts --once     # single tick
//   SWITCHYARD_TOKEN=... npx tsx scripts/agent-worker.ts --dry-run  # print, don't spawn
//
// Besides the main issue poll (intervalSeconds), a lightweight event-feed poll
// (eventPollSeconds, default 15s) watches for needs_input_cleared — a human
// answering an escalation — and re-dispatches that issue within seconds instead
// of waiting for the next full tick. The same poll also watches for
// agent_question (SYD-56: a human comment leading with `@agent`) and dispatches
// a read-only answerer-mode session — it reads the issue/repo and posts a
// comment, never claims or transitions the issue, and runs on any status
// (including triage, since answering doesn't bypass the triage gate).
//
// The event poll's agent_question trigger is the fast path, not the guarantee: a
// question that lands while all maxConcurrent slots are busy would otherwise be
// silently dropped (SYD-60). The real guarantee is drainUnansweredQuestions, which
// derives "unanswered" from the event log (GET /api/unanswered-questions — an
// agent_question with no later agent-actor comment on the same issue) rather than
// in-memory state, so it's restart-proof. It runs on every full tick and whenever a
// session slot frees (work or answer session exit), re-dispatching anything still
// unclaimed and under maxAnswersPerIssue.
//
// Config: switchyard-worker.json at the repo root (copy switchyard-worker.example.json).
// Safety model: the "auto" label (or whatever `label` is set to) is the human control
// point — nothing is dispatched unless a human labels the issue. maxConcurrent caps
// how many headless sessions can be running at once (shared with answerer-mode
// sessions); maxAnswersPerIssue additionally caps answer sessions per issue.
// Dispatched sessions still go through claim -> in_review -> human review; they
// can never reach `done` themselves.

import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync, readFileSync, mkdirSync, openSync, closeSync, appendFileSync,
} from "node:fs";
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
  type WorkerConfig,
  type WorkerIssue,
  type RetryState,
  type FeedEvent,
  type AnswerState,
} from "./worker-select.js";
import { acquirePidLock } from "./pidfile.js";
import { publishAgentBranch } from "./delivery-exec.js";
import { agentBranch, formatPublishOutcome, type DeliveryEventInput } from "./delivery-lib.js";

type ApiIssue = WorkerIssue & { title: string };

const DEFAULT_EVENT_POLL_SECONDS = 15;

// Ref -> running session. CLI dispatches hold their ChildProcess; SDK
// dispatches run in-process, so a marker is enough — the map only feeds
// maxConcurrent accounting and duplicate suppression.
const active = new Map<string, ChildProcess | "sdk">();
const retryState = new Map<string, RetryState>();
// Refs whose escalation was just answered — their next dispatch gets a prompt
// primed to read the answer. Populated by the event poll, consumed by tick().
const resumeRefs = new Set<string>();
let eventCursor: number | null = null;
const tickGate = newTickGate();
// Answerer mode (SYD-56): count of answer sessions dispatched per ref, kept
// separate from `active`'s work-session key so an answer and a work session
// can run concurrently on the same issue.
const answerState: AnswerState = new Map();

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
      `Missing ${configPath} — copy switchyard-worker.example.json to switchyard-worker.json and edit it.`
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
 * delivery strip — see src/services/delivery-events.ts for the server side. */
async function postDeliveryEvent(
  config: WorkerConfig, token: string, ref: string, input: DeliveryEventInput
): Promise<void> {
  const url = `${config.url.replace(/\/$/, "")}/api/issues/${ref}/delivery-events`;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`POST delivery-events on ${ref} failed: ${res.status} ${await res.text()}`);
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

export function buildPrompt(ref: string, opts: { resumed?: boolean } = {}): string {
  const resumedPreamble = opts.resumed
    ? `You previously escalated a question on Switchyard issue ${ref} and a human ` +
      `has now answered it. Call get_issue first and read the activity feed for ` +
      `the answer, then continue the work from where the escalation left off. `
    : "";
  return (
    resumedPreamble +
    `Work Switchyard issue ${ref} using the switchyard MCP tools. ` +
    `Call claim_issue first. Implement the work with tests. Comment verification ` +
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
    console.error(`unanswered-questions drain failed: ${err.message}`)
  );
}

function dispatch(issue: ApiIssue, config: WorkerConfig, token: string, opts: { resumed?: boolean } = {}): void {
  const project = config.projects[projectKeyOf(issue.ref)];
  const logDir = path.join(project.repo, ".superpowers", "worker-logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${issue.ref}.log`);

  if ((config.runner ?? "cli") === "sdk") {
    dispatchSdk(issue, project.repo, config, token, logPath, opts);
    return;
  }

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
      const allowedTools =
        config.allowedTools ??
        ["mcp__switchyard__*", "Bash", "Read", "Edit", "Write", "Grep", "Glob"];
      child = spawn(
        "claude",
        ["-p", buildPrompt(issue.ref, opts), "--permission-mode", "acceptEdits",
         "--allowedTools", allowedTools.join(",")],
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
  console.log(`dispatched ${issue.ref} (pid ${child.pid}) -> ${logPath}`);

  child.on("exit", (code) => {
    active.delete(issue.ref);
    triggerUnansweredDrain(config, token);
    console.log(`${issue.ref} exited with code ${code}`);
    const logLine = (text: string) => {
      try {
        appendFileSync(logPath, text);
      } catch (err) {
        console.error(`could not append to ${logPath}: ${(err as Error).message}`);
      }
    };
    logLine(`\n[worker] exited with code ${code}\n`);
    // Delivery gate (SYD-49): a containerized session that pushed agent/<ref>
    // gets its branch published to GitHub as a PR, host-side (gh + git auth
    // live here, never in the container). Merging still waits for a human
    // done-stamp via scripts/deliver.ts.
    if (config.containerized && config.delivery && config.delivery.openPrs !== false) {
      publishAgentBranch(project.repo, issue.ref, issue.title, config.url)
        .then((outcome) => {
          const line = formatPublishOutcome(agentBranch(issue.ref), outcome);
          console.log(`${issue.ref}: ${line}`);
          logLine(`[worker] ${line}\n`);
          if ((outcome.status === "opened" || outcome.status === "already-open") && outcome.prNumber !== null) {
            postDeliveryEvent(config, token, issue.ref, {
              type: "pr_opened", prNumber: outcome.prNumber, url: outcome.url,
            }).catch((err: Error) => {
              console.error(`could not record pr_opened event for ${issue.ref}: ${err.message}`);
              logLine(`[worker] could not record pr_opened event: ${err.message}\n`);
            });
          }
        })
        .catch((err: Error) => {
          console.error(`publish failed for ${issue.ref}: ${err.message}`);
          logLine(`[worker] publish failed: ${err.message}\n`);
        });
    }
  });

  child.on("error", (err) => {
    active.delete(issue.ref);
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
  logPath: string,
  opts: { resumed?: boolean },
): void {
  const allowedTools =
    config.allowedTools ?? ["mcp__switchyard__*", "Bash", "Read", "Edit", "Write", "Grep", "Glob"];
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
      }),
    )
    .then(
      (code) => {
        console.log(`${issue.ref} sdk session finished with code ${code}`);
        safeAppend(`[worker] exited with code ${code}\n`);
      },
      (err: Error) => {
        console.error(`sdk dispatch failed for ${issue.ref}: ${err.message}`);
        safeAppend(
          `[worker] sdk dispatch failed: ${err.message}\n` +
          `[worker] is worker-sdk installed? run: npm install --prefix worker-sdk\n`,
        );
      },
    )
    .catch((err: Error) => console.error(`sdk dispatch cleanup error for ${issue.ref}: ${err.message}`))
    .finally(() => {
      active.delete(issue.ref);
      triggerUnansweredDrain(config, token);
    });
}

/**
 * Dispatches a read-only answerer-mode session (SYD-56) for `ref`: same
 * maxConcurrent pool as work dispatch (shared cost control) plus a
 * per-issue answer cap, restricted to ANSWER_ALLOWED_TOOLS so it cannot
 * claim, transition, or edit anything — it can only read and post a
 * comment. Runs bare-host (never containerized): read-only work doesn't
 * need the branch/push sandbox containerized mode exists for.
 */
function dispatchAnswer(ref: string, config: WorkerConfig, token: string, opts: { dryRun: boolean }): void {
  const key = answerKey(ref);
  if (active.has(key)) return;
  if (active.size >= config.maxConcurrent) {
    console.log(`answer session for ${ref} deferred: at maxConcurrent capacity`);
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

  recordAnswerAttempt(answerState, ref);
  const logDir = path.join(project.repo, ".superpowers", "worker-logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${ref}.answer.log`);

  if ((config.runner ?? "cli") === "sdk") {
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
  console.log(`dispatched answer session for ${ref} (pid ${child.pid}) -> ${logPath}`);

  child.on("exit", (code) => {
    active.delete(key);
    triggerUnansweredDrain(config, token);
    console.log(`answer session for ${ref} exited with code ${code}`);
  });
  child.on("error", (err) => {
    active.delete(key);
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
    .catch((err: Error) => console.error(`sdk answer dispatch cleanup error for ${ref}: ${err.message}`))
    .finally(() => {
      active.delete(key);
      triggerUnansweredDrain(config, token);
    });
}

/**
 * Restart-proof backstop for answerer mode (SYD-60): re-derives unanswered
 * @agent questions from the event log via GET /api/unanswered-questions
 * (rather than trusting in-memory state) and dispatches an answer session
 * for each one still eligible. Called on every tick and whenever a session
 * slot frees, so a question deferred at maxConcurrent capacity — or asked
 * while the worker was down or mid-restart — still gets serviced once
 * capacity exists, without depending on the event-poll fast path (pollEvents
 * / findAnswerRefs) having caught the original agent_question event.
 */
async function drainUnansweredQuestions(config: WorkerConfig, token: string, opts: { dryRun: boolean }): Promise<void> {
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

async function tick(config: WorkerConfig, token: string, opts: { dryRun: boolean }): Promise<void> {
  // The event poll can trigger a tick while the interval tick is mid-fetch;
  // never let two ticks select (and double-dispatch) concurrently. runGated
  // queues rather than drops a call that arrives mid-tick, so a resume
  // triggered mid-tick still gets dispatched within seconds via an immediate
  // re-run instead of waiting for the next periodic tick.
  await runGated(tickGate, async () => {
    try {
      const issues = await fetchReadyIssues(config, token);
      const eligible = filterRetryCapped(issues, retryState);
      const selected = selectDispatchable(eligible, config, active.keys());

      for (const issue of selected) {
        recordAttempt(retryState, issue.ref, issue.updatedAt);
        const resumed = resumeRefs.delete(issue.ref);
        if (opts.dryRun) {
          console.log(`[dry-run] would dispatch ${issue.ref}${resumed ? " (resumed)" : ""}: ${issue.title}`);
        } else {
          dispatch(issue, config, token, { resumed });
        }
      }
    } catch (err) {
      console.error(`poll failed: ${(err as Error).message}`);
    }
    // The recheck runs every tick regardless of whether work dispatch above
    // found anything or failed — it's an independent guarantee, not a
    // continuation of the ready-issues poll.
    await drainUnansweredQuestions(config, token, opts);
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
 * gate — see dispatchAnswer).
 */
async function pollEvents(config: WorkerConfig, token: string, opts: { dryRun: boolean }): Promise<void> {
  const url = `${config.url.replace(/\/$/, "")}/api/events?limit=100`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`GET /api/events failed: ${res.status} ${await res.text()}`);
  }
  const feed = (await res.json()) as FeedEvent[];
  const { refs, lastEventId } = findResumeRefs(feed, config, eventCursor);
  const { refs: answerRefs } = findAnswerRefs(feed, config, eventCursor);
  eventCursor = lastEventId;

  for (const ref of answerRefs) {
    console.log(`question addressed to an agent on ${ref} — dispatching an answer session`);
    dispatchAnswer(ref, config, token, opts);
  }

  if (refs.length === 0) return;
  for (const ref of refs) resumeRefs.add(ref);
  console.log(`escalation answered on ${refs.join(", ")} — dispatching now`);
  await tick(config, token, opts);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const once = args.includes("--once");
  const dryRun = args.includes("--dry-run");

  loadDotEnv();
  const token = process.env.SWITCHYARD_TOKEN;
  if (!token) {
    console.error("SWITCHYARD_TOKEN is required (set it in the environment or the repo .env)");
    process.exit(1);
  }

  const config = loadConfig(defaultConfigPath());

  if (once) {
    // Single ticks (incl. init-worker's --self-test) may run alongside a live
    // loop — only the loop takes the single-instance lock.
    await tick(config, token, { dryRun });
    return;
  }

  const releaseLock = acquirePidLock(
    path.join(repoRoot(), ".superpowers", "worker.pid"),
    "stop it first (launchctl unload ~/Library/LaunchAgents/com.switchyard.worker.plist, or kill the pid)"
  );
  await tick(config, token, { dryRun });

  const eventPollSeconds = config.eventPollSeconds ?? DEFAULT_EVENT_POLL_SECONDS;
  console.log(
    `polling every ${config.intervalSeconds}s, event feed every ${eventPollSeconds}s ` +
    `(maxConcurrent=${config.maxConcurrent}, label="${config.label}")`
  );
  const timer = setInterval(() => {
    tick(config, token, { dryRun }).catch((err) => console.error(`tick failed: ${(err as Error).message}`));
  }, config.intervalSeconds * 1000);
  const eventTimer = setInterval(() => {
    pollEvents(config, token, { dryRun }).catch((err) => console.error(`event poll failed: ${(err as Error).message}`));
  }, eventPollSeconds * 1000);

  process.on("SIGINT", () => {
    clearInterval(timer);
    clearInterval(eventTimer);
    releaseLock();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    clearInterval(timer);
    clearInterval(eventTimer);
    releaseLock();
    process.exit(0);
  });
  process.on("exit", releaseLock);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
