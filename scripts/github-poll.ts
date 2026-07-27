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
// The token (SWITCHYARD_SERVICE_TOKEN, else SWITCHYARD_TOKEN) must belong to a
// `service` or `human` actor, NOT an agent (SYD-107/213): POST
// /api/github-events rejects agent actors, since any dispatched agent holding a
// bearer token could otherwise forge pull_request/check_suite events. Provision
// a least-privilege identity with `add-actor <name> service` rather than a
// human login — a service token can post events but nothing human-only.
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
  observeRepoState,
  selectRefreshCandidates,
  parsePollStateText,
  preflightRepoBindings,
  type PollStateFile,
  type PollEvent,
  type RepoPollState,
} from "./github-poll-lib.js";
import {
  listPullRequests,
  latestRun,
  viewPullRequest,
  resolveConfiguredRepos,
} from "./github-poll-exec.js";
import { acquirePidLock } from "./pidfile.js";
import { resolvePollerToken } from "./delivery-lib.js";

const DEFAULT_POLL_SECONDS = 120;

// Targeted-refresh cadence (SYD-206): an open pr_state row that fell out of
// the 50-window gets its own `gh pr view` at most this often — it burns a
// GitHub API call per PR, so it runs slower than the tick.
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
// Consecutive targeted-refresh failures before the staleness alarm: the row
// may be blocking the claim gate forever (repo renamed/unlinked, PR
// transferred), and silence is the failure mode the spec forbids.
const STALE_REFRESH_THRESHOLD = 3;

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function loadDotEnv(): void {
  const envPath = path.join(repoRoot(), ".env");
  if (!existsSync(envPath)) return;
  for (const [key, value] of Object.entries(parseDotEnv(readFileSync(envPath, "utf8")))) {
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function loadConfig(): WorkerConfig {
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

type LinkedRepo = { id: number; fullName: string; projectId: number | null };

export async function fetchLinkedRepos(url: string, token: string): Promise<LinkedRepo[]> {
  const res = await fetch(`${url.replace(/\/$/, "")}/api/github-repos`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET /api/github-repos failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as LinkedRepo[];
}

export async function fetchProjects(
  url: string,
  token: string,
): Promise<{ id: number; key: string }[]> {
  const res = await fetch(`${url.replace(/\/$/, "")}/api/projects`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET /api/projects failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: number; key: string }[];
}

type GithubEventOutcome = { duplicate?: boolean };

export async function postGithubEvent(
  url: string,
  token: string,
  ev: PollEvent,
  repo: string,
): Promise<GithubEventOutcome> {
  const res = await fetch(`${url.replace(/\/$/, "")}/api/github-events`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    // repo rides top-level (SYD-205): the derived payloads have no
    // repository.full_name, and the server should never have to infer.
    body: JSON.stringify({ ...ev, repo }),
  });
  if (!res.ok) throw new Error(`POST /api/github-events failed: ${res.status} ${await res.text()}`);
  return (await res.json().catch(() => ({}))) as GithubEventOutcome;
}

/** Open pr_state rows for a repo, from GET /api/pr-state — the refresh
 * work-list. Tolerant of an older server without the endpoint (deploy skew)
 * and of transport errors: no list just means no targeted refresh this
 * tick. */
async function fetchOpenPrNumbers(url: string, token: string, repo: string): Promise<number[]> {
  try {
    const res = await fetch(
      `${url.replace(/\/$/, "")}/api/pr-state?repo=${encodeURIComponent(repo)}&status=open`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return [];
    const rows: unknown = await res.json();
    if (!Array.isArray(rows)) return [];
    return rows
      .map((r) => Number((r as { prNumber?: unknown }).prNumber))
      .filter((n) => Number.isInteger(n));
  } catch {
    return [];
  }
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
  const repoState: RepoPollState = state[fullName] ?? {};

  // Targeted refresh (SYD-206): open pr_state rows outside the poll window
  // still get observed, on a slower cadence, so "absence is not evidence"
  // has a live producer behind it. Failures never transition anything — they
  // count toward the staleness alarm and get retried next interval.
  const openRows = await fetchOpenPrNumbers(config.url, token, fullName);
  const candidates = selectRefreshCandidates(
    openRows,
    new Set(prs.map((pr) => pr.number)),
    repoState,
    Date.now(),
    REFRESH_INTERVAL_MS,
  );
  for (const prNumber of candidates) {
    const entry = (repoState[prNumber] ??= { state: "OPEN", lastRunConclusion: null });
    entry.lastRefreshAt = Date.now();
    try {
      prs.push(await viewPullRequest(fullName, prNumber));
      entry.refreshFailures = 0;
    } catch (err) {
      entry.refreshFailures = (entry.refreshFailures ?? 0) + 1;
      const detail = `targeted refresh of ${fullName}#${prNumber} failed (${entry.refreshFailures} consecutive): ${(err as Error).message}`;
      console.error(
        entry.refreshFailures >= STALE_REFRESH_THRESHOLD
          ? `github-poll: STALE open pr_state row — ${detail} — the row may be blocking the claim gate; check whether the repo was renamed/unlinked or the PR transferred`
          : `github-poll: ${detail}`,
      );
    }
  }

  const runs = new Map(
    await Promise.all(
      prs
        .filter((pr) => pr.state === "OPEN")
        .map(async (pr) => [pr.number, await latestRun(fullName, pr.headRefName)] as const),
    ),
  );
  const { events, next } = observeRepoState(prs, runs, repoState);

  for (const ev of events) {
    if (dryRun) {
      console.log(`[dry-run] ${fullName}: would POST ${ev.event} — ${JSON.stringify(ev.payload)}`);
      continue;
    }
    const outcome = await postGithubEvent(config.url, token, ev, fullName);
    // Steady-state re-observation (SYD-177/206) is absorbed server-side every
    // tick; only log events the server actually recorded.
    if (!outcome.duplicate) console.log(`${fullName}: posted ${ev.event}`);
  }

  // Advance the persisted state only after every event landed (SYD-177): a
  // failed POST leaves the old state in place, so the next tick re-observes
  // and re-emits — the server's dedupe drops anything that did make it
  // through.
  state[fullName] = next;
}

/** Periodic repo-binding check (SYD-207): the cutover preflight's assertion,
 * re-run every tick so a post-cutover unbinding is caught, not just a
 * day-one one. Never blocks the poll — an unbound repo is exactly when
 * observations matter most for the operator to see the problem. */
async function warnOnBrokenBindings(
  config: WorkerConfig,
  token: string,
  repos: LinkedRepo[],
): Promise<void> {
  try {
    const { configured, problems } = await resolveConfiguredRepos(config.projects);
    const serverProjects = await fetchProjects(config.url, token);
    problems.push(...preflightRepoBindings(configured, repos, serverProjects));
    for (const p of problems) {
      console.error(
        `github-poll: BROKEN REPO BINDING — ${p} — agent PRs on this repo are display-only and the claim gate is blind to them`,
      );
    }
  } catch (err) {
    console.error(`github-poll: repo-binding check failed: ${(err as Error).message}`);
  }
}

async function tick(config: WorkerConfig, token: string, dryRun: boolean): Promise<void> {
  const repos = await fetchLinkedRepos(config.url, token);
  await warnOnBrokenBindings(config, token, repos);
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
  const token = resolvePollerToken();
  if (!token) {
    console.error(
      "SWITCHYARD_GITHUB_POLLER_TOKEN is required (set it in the environment or the repo .env). " +
        "It must belong to a `service` actor — the poller posts observations, never board state. " +
        "Legacy SWITCHYARD_SERVICE_TOKEN / SWITCHYARD_TOKEN are still read for back-compat.",
    );
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
