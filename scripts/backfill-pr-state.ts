// One-time pr_state cutover backfill (SYD-207, spec: docs/2026-07-12-sync-
// simplification-assessment.md "Cutover backfill"). Enumerates agent/* PRs
// per linked repo — `gh pr list --state all` with a high limit, plus targeted
// per-branch lookups when the window hit its limit (a beyond-window PR, the
// SYD-179 shape) — and posts each as a pull_request observation to
// POST /api/github-events, exactly like the poller. The backfill is a fifth
// caller of upsertPrState, NOT an exempt data-load: it rides the same
// webhook-shaped ingestion, so repo-bound attribution applies (an
// out-of-project agent/SYD-1 PR is refused at backfill exactly as in live
// ingestion) and headSha/ghUpdatedAt are GitHub's own — never cutover
// wall-clock, which would out-rank every later genuine `synchronize` under
// the monotonic guard and freeze headSha at the backfilled value.
//
// Runs the SYD-207 preflight FIRST and refuses to backfill while any
// worker-configured project's repo is unlinked or not project-bound: cutting
// the claim gate over against a table missing rows (or attributing none)
// makes every in-flight agent PR claimable with auto-dispatch live — the
// SYD-93/177 class, fleet-wide, on deploy day.
//
//   SWITCHYARD_TOKEN=... npx tsx scripts/backfill-pr-state.ts            # backfill
//   SWITCHYARD_TOKEN=... npx tsx scripts/backfill-pr-state.ts --dry-run  # print, don't POST
//
// SWITCHYARD_TOKEN must belong to a human-type actor (SYD-107), same as the
// poller — POST /api/github-events rejects agent actors.

import { observeRepoState, selectBackfillWork, type GhPr } from "./github-poll-lib.js";
import {
  listPullRequests,
  listPullRequestsForBranch,
  resolveConfiguredRepos,
} from "./github-poll-exec.js";
import {
  loadDotEnv,
  loadConfig,
  fetchLinkedRepos,
  fetchProjects,
  postGithubEvent,
} from "./github-poll.js";
import { preflightRepoBindings } from "./github-poll-lib.js";
import { resolvePollerToken } from "./delivery-lib.js";

// High enough to cover any repo this tracker has driven so far; when a repo
// genuinely has this many PRs, the per-branch lookups cover the tail.
const WINDOW_LIMIT = 1000;

async function fetchIssueRefs(url: string, token: string, projectKey: string): Promise<string[]> {
  const res = await fetch(
    `${url.replace(/\/$/, "")}/api/issues?project=${encodeURIComponent(projectKey)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok)
    throw new Error(
      `GET /api/issues?project=${projectKey} failed: ${res.status} ${await res.text()}`,
    );
  return ((await res.json()) as { ref: string }[]).map((r) => r.ref);
}

async function backfillRepo(
  fullName: string,
  boundProjectKeys: string[],
  url: string,
  token: string,
  dryRun: boolean,
): Promise<{ posted: number; duplicates: number }> {
  const windowPrs = await listPullRequests(fullName, WINDOW_LIMIT);
  const issueRefs = (
    await Promise.all(boundProjectKeys.map((key) => fetchIssueRefs(url, token, key)))
  ).flat();
  const { agentPrs, lookupBranches } = selectBackfillWork(windowPrs, WINDOW_LIMIT, issueRefs);

  const prs: GhPr[] = [...agentPrs];
  if (lookupBranches.length > 0) {
    console.log(
      `${fullName}: window hit its ${WINDOW_LIMIT} limit — ${lookupBranches.length} targeted branch lookups for beyond-window PRs`,
    );
    for (const branch of lookupBranches) {
      prs.push(...(await listPullRequestsForBranch(fullName, branch)));
    }
  }

  // Empty runs map + empty prior state: one pull_request observation per PR
  // (terminal PRs included — the never-saw-open heal), no check_suite noise.
  const { events } = observeRepoState(prs, new Map(), {});
  let posted = 0;
  let duplicates = 0;
  for (const ev of events) {
    if (dryRun) {
      console.log(`[dry-run] ${fullName}: would POST ${ev.event} — ${JSON.stringify(ev.payload)}`);
      continue;
    }
    const outcome = await postGithubEvent(url, token, ev, fullName);
    if (outcome.duplicate) duplicates++;
    else posted++;
  }
  console.log(
    dryRun
      ? `${fullName}: ${events.length} agent-PR observations (dry run)`
      : `${fullName}: ${events.length} agent-PR observations — ${posted} recorded, ${duplicates} already known`,
  );
  return { posted, duplicates };
}

async function main(): Promise<void> {
  const dryRun = process.argv.slice(2).includes("--dry-run");

  loadDotEnv();
  const token = resolvePollerToken();
  if (!token) {
    console.error("SWITCHYARD_TOKEN is required (set it in the environment or the repo .env)");
    process.exit(1);
  }
  const config = loadConfig();

  const linked = await fetchLinkedRepos(config.url, token);
  const serverProjects = await fetchProjects(config.url, token);
  const { configured, problems } = await resolveConfiguredRepos(config.projects);
  problems.push(...preflightRepoBindings(configured, linked, serverProjects));
  if (problems.length > 0) {
    console.error("PREFLIGHT FAILED — refusing to backfill (cutover blocked):");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`preflight OK: ${configured.length} configured project(s) linked and project-bound`);

  const keysByProjectId = new Map<number, string[]>();
  for (const p of serverProjects) {
    keysByProjectId.set(p.id, [...(keysByProjectId.get(p.id) ?? []), p.key]);
  }
  let posted = 0;
  let duplicates = 0;
  for (const repo of linked) {
    const boundKeys = repo.projectId !== null ? (keysByProjectId.get(repo.projectId) ?? []) : [];
    try {
      const r = await backfillRepo(repo.fullName, boundKeys, config.url, token, dryRun);
      posted += r.posted;
      duplicates += r.duplicates;
    } catch (err) {
      console.error(`backfill failed for ${repo.fullName}: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }
  if (!dryRun) console.log(`backfill done: ${posted} recorded, ${duplicates} already known`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
