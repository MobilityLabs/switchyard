// Local-machine poller that dispatches ready Switchyard work to headless Claude
// Code sessions. Meant to run on Sean's Mac, one process, long-lived.
//
//   SWITCHYARD_TOKEN=... npx tsx scripts/agent-worker.ts            # loop forever
//   SWITCHYARD_TOKEN=... npx tsx scripts/agent-worker.ts --once     # single tick
//   SWITCHYARD_TOKEN=... npx tsx scripts/agent-worker.ts --dry-run  # print, don't spawn
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
  projectKeyOf,
  type WorkerConfig,
  type WorkerIssue,
  type RetryState,
} from "./worker-select.js";

type ApiIssue = WorkerIssue & { title: string };

const active = new Map<string, ChildProcess>();
const retryState = new Map<string, RetryState>();

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

function buildPrompt(ref: string): string {
  return (
    `Work Switchyard issue ${ref} using the switchyard MCP tools. ` +
    `Call claim_issue first. Implement the work with tests. Comment verification ` +
    `evidence describing what you did and how you verified it, then move the issue ` +
    `to in_review. Never move it to done — a human or review step does that. ` +
    `If you are blocked on a decision only a human can make, call request_human_input ` +
    `with your question and stop.`
  );
}

function dispatch(issue: ApiIssue, config: WorkerConfig): void {
  const project = config.projects[projectKeyOf(issue.ref)];
  const logDir = path.join(project.repo, ".superpowers", "worker-logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${issue.ref}.log`);
  const fd = openSync(logPath, "a");

  let child: ChildProcess;
  try {
    child = spawn("claude", ["-p", buildPrompt(issue.ref)], {
      cwd: project.repo,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
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
    if (opts.dryRun) {
      console.log(`[dry-run] would dispatch ${issue.ref}: ${issue.title}`);
    } else {
      dispatch(issue, config);
    }
  }
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

  console.log(`polling every ${config.intervalSeconds}s (maxConcurrent=${config.maxConcurrent}, label="${config.label}")`);
  const timer = setInterval(() => {
    tick(config, token, { dryRun }).catch((err) => console.error(`tick failed: ${(err as Error).message}`));
  }, config.intervalSeconds * 1000);

  process.on("SIGINT", () => {
    clearInterval(timer);
    process.exit(0);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
