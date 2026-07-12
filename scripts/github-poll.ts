// GitHub polling fallback (SYD-71): for repos where a webhook can't be
// installed (no admin access, org policy, etc.), watches each linked repo's
// pull requests and workflow runs via `gh` instead of waiting for a GitHub
// delivery, and drives the exact same pull_request/check_suite handling
// src/services/github-webhook.ts (SYD-64) already has by POSTing to
// POST /api/github-events. Repos to poll come from GET /api/github-repos
// (SYD-72's linked-repo table) — a repo only needs to be linked there, not
// have a real GitHub webhook configured, to get inbound visibility.
//
//   SWITCHYARD_TOKEN=... npx tsx scripts/github-poll.ts            # loop forever
//   SWITCHYARD_TOKEN=... npx tsx scripts/github-poll.ts --once     # single scan
//   SWITCHYARD_TOKEN=... npx tsx scripts/github-poll.ts --dry-run  # print, don't POST
//
// SWITCHYARD_TOKEN must belong to a human-type actor (SYD-107): POST
// /api/github-events rejects agent actors, since any dispatched agent
// holding a bearer token could otherwise forge pull_request/check_suite
// events. `add-actor <name> human` + `mint-login <name>` to provision a
// dedicated poller identity rather than reusing a person's own login.
//
// Config: the `githubPoll` block of switchyard-worker.json (pollSeconds,
// default 120s — kept well above deliver.ts's 30s since this burns GitHub
// API rate limit per linked repo, not just a Switchyard event-feed request).
// Per-repo/per-PR state persists in .superpowers/github-poll-state.json so
// close/merge transitions and check conclusions fire once per change. Note
// "opened" is NOT state-gated (SYD-177): it re-emits for every open PR each
// tick and relies on the server's per-(issue, prNumber) dedupe, so a lost
// pr_opened/gh_pr_opened heals within one tick instead of leaving the SYD-99
// claim gate blind to an in-flight PR.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDotEnv, validateWorkerConfig } from "./init-worker-lib.js";
import type { WorkerConfig } from "./worker-select.js";
import {
  diffRepoState,
  parsePollStateText,
  type PollStateFile,
  type PollEvent,
} from "./github-poll-lib.js";
import { listPullRequests, latestRun } from "./github-poll-exec.js";
import { acquirePidLock } from "./pidfile.js";

const DEFAULT_POLL_SECONDS = 120;

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function loadDotEnv(): void {
  const envPath = path.join(repoRoot(), ".env");
  if (!existsSync(envPath)) return;
  for (const [key, value] of Object.entries(parseDotEnv(readFileSync(envPath, "utf8")))) {
    if (!(key in process.env)) process.env[key] = value;
  }
}

function loadConfig(): WorkerConfig {
  const configPath = path.join(repoRoot(), "switchyard-worker.json");
  if (!existsSync(configPath)) {
    throw new Error(`Missing ${configPath} — copy switchyard-worker.example.json and edit it.`);
  }
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  const problems = validateWorkerConfig(raw);
  if (problems.length > 0)
    throw new Error(`invalid ${configPath}:\n  - ${problems.join("\n  - ")}`);
  return raw as WorkerConfig;
}

const statePath = () => path.join(repoRoot(), ".superpowers", "github-poll-state.json");

function readState(): PollStateFile {
  try {
    return parsePollStateText(readFileSync(statePath(), "utf8"));
  } catch {
    return {};
  }
}

function writeState(state: PollStateFile): void {
  mkdirSync(path.dirname(statePath()), { recursive: true });
  writeFileSync(statePath(), JSON.stringify(state, null, 2) + "\n");
}

type LinkedRepo = { id: number; fullName: string };

async function fetchLinkedRepos(url: string, token: string): Promise<LinkedRepo[]> {
  const res = await fetch(`${url.replace(/\/$/, "")}/api/github-repos`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET /api/github-repos failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as LinkedRepo[];
}

type GithubEventOutcome = { duplicate?: boolean };

async function postGithubEvent(
  url: string,
  token: string,
  ev: PollEvent,
): Promise<GithubEventOutcome> {
  const res = await fetch(`${url.replace(/\/$/, "")}/api/github-events`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(ev),
  });
  if (!res.ok) throw new Error(`POST /api/github-events failed: ${res.status} ${await res.text()}`);
  return (await res.json().catch(() => ({}))) as GithubEventOutcome;
}

// Exported for tests (SYD-177): the state-persistence ordering below is what
// keeps a failed POST from permanently swallowing a PR's events.
export async function pollRepo(
  fullName: string,
  config: WorkerConfig,
  token: string,
  state: PollStateFile,
  dryRun: boolean,
): Promise<void> {
  const prs = await listPullRequests(fullName);
  const runs = new Map(
    await Promise.all(
      prs
        .filter((pr) => pr.state === "OPEN")
        .map(async (pr) => [pr.number, await latestRun(fullName, pr.headRefName)] as const),
    ),
  );
  const { events, next } = diffRepoState(prs, runs, state[fullName] ?? {});

  for (const ev of events) {
    if (dryRun) {
      console.log(`[dry-run] ${fullName}: would POST ${ev.event} — ${JSON.stringify(ev.payload)}`);
      continue;
    }
    const outcome = await postGithubEvent(config.url, token, ev);
    // Steady-state "opened" reconciliation (SYD-177) is deduped server-side
    // every tick; only log events the server actually recorded.
    if (!outcome.duplicate) console.log(`${fullName}: posted ${ev.event}`);
  }

  // Advance the persisted state only after every event landed (SYD-177): a
  // failed POST leaves the old state in place, so the next tick re-diffs and
  // re-emits — the server's dedupe drops anything that did make it through.
  state[fullName] = next;
}

async function tick(config: WorkerConfig, token: string, dryRun: boolean): Promise<void> {
  const repos = await fetchLinkedRepos(config.url, token);
  if (repos.length === 0) return;
  const state = readState();
  // Sequential on purpose: keeps `gh` API usage predictable and the state
  // file write a single pass, same posture as deliver.ts's per-ref loop.
  for (const repo of repos) {
    try {
      await pollRepo(repo.fullName, config, token, state, dryRun);
    } catch (err) {
      console.error(`github-poll: ${repo.fullName} failed: ${(err as Error).message}`);
    }
  }
  if (!dryRun) writeState(state);
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
  const config = loadConfig();

  if (once) {
    await tick(config, token, dryRun);
    return;
  }

  const releaseLock = acquirePidLock(path.join(repoRoot(), ".superpowers", "github-poll.pid"));
  await tick(config, token, dryRun);

  const pollSeconds = config.githubPoll?.pollSeconds ?? DEFAULT_POLL_SECONDS;
  console.log(`github-poll worker polling every ${pollSeconds}s`);
  const timer = setInterval(() => {
    tick(config, token, dryRun).catch((err) =>
      console.error(`github-poll tick failed: ${(err as Error).message}`),
    );
  }, pollSeconds * 1000);

  const stop = () => {
    clearInterval(timer);
    releaseLock();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("exit", releaseLock);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
