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
// of waiting for the next full tick.
//
// Config: switchyard-worker.json at the repo root (copy switchyard-worker.example.json).
// Safety model: the "auto" label (or whatever `label` is set to) is the human control
// point — nothing is dispatched unless a human labels the issue. maxConcurrent caps
// how many headless sessions can be running at once. Dispatched sessions still go
// through claim -> in_review -> human review; they can never reach `done` themselves.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, openSync, closeSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  selectDispatchable,
  filterRetryCapped,
  recordAttempt,
  findResumeRefs,
  projectKeyOf,
  buildDockerArgs,
  type WorkerConfig,
  type WorkerIssue,
  type RetryState,
  type FeedEvent,
} from "./worker-select.js";

type ApiIssue = WorkerIssue & { title: string };

const DEFAULT_EVENT_POLL_SECONDS = 15;

const active = new Map<string, ChildProcess>();
const retryState = new Map<string, RetryState>();
// Refs whose escalation was just answered — their next dispatch gets a prompt
// primed to read the answer. Populated by the event poll, consumed by tick().
const resumeRefs = new Set<string>();
let eventCursor: number | null = null;
let tickInFlight = false;

function defaultConfigPath(): string {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(scriptDir, "..", "switchyard-worker.json");
}

function loadConfig(configPath: string): WorkerConfig {
  if (!existsSync(configPath)) {
    throw new Error(
      `Missing ${configPath} — copy switchyard-worker.example.json to switchyard-worker.json and edit it.`
    );
  }
  return JSON.parse(readFileSync(configPath, "utf8")) as WorkerConfig;
}

async function fetchReadyIssues(config: WorkerConfig, token: string): Promise<ApiIssue[]> {
  const url = `${config.url.replace(/\/$/, "")}/api/issues?status=todo`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`GET /api/issues?status=todo failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as ApiIssue[];
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

function dispatch(issue: ApiIssue, config: WorkerConfig, opts: { resumed?: boolean } = {}): void {
  const project = config.projects[projectKeyOf(issue.ref)];
  const logDir = path.join(project.repo, ".superpowers", "worker-logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${issue.ref}.log`);
  const fd = openSync(logPath, "a");

  let child: ChildProcess;
  try {
    if (config.containerized) {
      // The container is the sandbox: it clones the repo internally, works on
      // a branch, and pushes it back out — it never touches this host
      // filesystem beyond the /origin mount. See scripts/container-entry.sh.
      const dockerArgs = buildDockerArgs(issue, project, config, process.env);
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
    console.log(`${issue.ref} exited with code ${code}`);
    try {
      appendFileSync(logPath, `\n[worker] exited with code ${code}\n`);
    } catch (err) {
      console.error(`could not append exit code to ${logPath}: ${(err as Error).message}`);
    }
  });

  child.on("error", (err) => {
    active.delete(issue.ref);
    console.error(`failed to spawn claude for ${issue.ref}: ${err.message}`);
  });
}

async function tick(config: WorkerConfig, token: string, opts: { dryRun: boolean }): Promise<void> {
  // The event poll can trigger a tick while the interval tick is mid-fetch;
  // never let two ticks select (and double-dispatch) concurrently.
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    let issues: ApiIssue[];
    try {
      issues = await fetchReadyIssues(config, token);
    } catch (err) {
      console.error(`poll failed: ${(err as Error).message}`);
      return;
    }

    const eligible = filterRetryCapped(issues, retryState);
    const selected = selectDispatchable(eligible, config, active.keys());
    if (selected.length === 0) return;

    for (const issue of selected) {
      recordAttempt(retryState, issue.ref, issue.updatedAt);
      const resumed = resumeRefs.delete(issue.ref);
      if (opts.dryRun) {
        console.log(`[dry-run] would dispatch ${issue.ref}${resumed ? " (resumed)" : ""}: ${issue.title}`);
      } else {
        dispatch(issue, config, { resumed });
      }
    }
  } finally {
    tickInFlight = false;
  }
}

/**
 * Fast, cheap scan of the global event feed for answered escalations
 * (needs_input_cleared). The server releases the claim when the answer lands,
 * so the issue is already back in `todo` — this poll just collapses the wait
 * for the next full tick from `intervalSeconds` down to `eventPollSeconds`,
 * and primes the resumed session's prompt to read the answer.
 */
async function pollEvents(config: WorkerConfig, token: string, opts: { dryRun: boolean }): Promise<void> {
  const url = `${config.url.replace(/\/$/, "")}/api/events?limit=100`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`GET /api/events failed: ${res.status} ${await res.text()}`);
  }
  const feed = (await res.json()) as FeedEvent[];
  const { refs, lastEventId } = findResumeRefs(feed, config, eventCursor);
  eventCursor = lastEventId;
  if (refs.length === 0) return;

  for (const ref of refs) resumeRefs.add(ref);
  console.log(`escalation answered on ${refs.join(", ")} — dispatching now`);
  await tick(config, token, opts);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const once = args.includes("--once");
  const dryRun = args.includes("--dry-run");

  const token = process.env.SWITCHYARD_TOKEN;
  if (!token) {
    console.error("SWITCHYARD_TOKEN is required");
    process.exit(1);
  }

  const config = loadConfig(defaultConfigPath());

  await tick(config, token, { dryRun });
  if (once) return;

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
    process.exit(0);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
