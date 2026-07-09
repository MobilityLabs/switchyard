// Delivery worker (SYD-49): watches the event feed for a HUMAN stamping an
// issue done (agents can't — server-enforced) and delivers the matching agent
// work: merges the open agent/<ref> PR, deploys from a dedicated clean clone
// (never a working tree), and comments the merge SHA + deploy result on the
// issue. Issues without an open agent PR (interactive work) are skipped.
//
//   SWITCHYARD_TOKEN=... npx tsx scripts/deliver.ts            # loop forever
//   SWITCHYARD_TOKEN=... npx tsx scripts/deliver.ts --once     # single scan
//   SWITCHYARD_TOKEN=... npx tsx scripts/deliver.ts --dry-run  # print, don't merge
//
// Config: the `delivery` block of switchyard-worker.json (pollSeconds,
// cloneDir, deploy). The event cursor persists in .superpowers/deliver-cursor
// so approvals stamped while this worker is down are delivered on restart.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDotEnv, validateWorkerConfig } from "./init-worker-lib.js";
import { projectKeyOf, newTickGate, runGated, type WorkerConfig } from "./worker-select.js";
import {
  findDeliverableRefs,
  parseCursorText,
  deliveryComment,
  deliveryFailureComment,
  type DeliveryFeedEvent,
} from "./delivery-lib.js";
import { findOpenAgentPr, mergeAgentPr, ensureCleanClone, runDeploy } from "./delivery-exec.js";
import { acquirePidLock } from "./pidfile.js";

const DEFAULT_POLL_SECONDS = 30;

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
  if (problems.length > 0) throw new Error(`invalid ${configPath}:\n  - ${problems.join("\n  - ")}`);
  return raw as WorkerConfig;
}

const cursorPath = () => path.join(repoRoot(), ".superpowers", "deliver-cursor");

function readCursor(): number | null {
  try {
    return parseCursorText(readFileSync(cursorPath(), "utf8"));
  } catch {
    return null;
  }
}

function writeCursor(id: number): void {
  mkdirSync(path.dirname(cursorPath()), { recursive: true });
  writeFileSync(cursorPath(), `${id}\n`);
}

function cloneRootOf(config: WorkerConfig): string {
  return config.delivery?.cloneDir ?? path.join(os.homedir(), ".switchyard", "deliver-clones");
}

async function postComment(config: WorkerConfig, token: string, ref: string, body: string): Promise<void> {
  const url = `${config.url.replace(/\/$/, "")}/api/issues/${ref}/comments`;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`POST comment on ${ref} failed: ${res.status} ${await res.text()}`);
}

async function deliver(ref: string, config: WorkerConfig, token: string, dryRun: boolean): Promise<void> {
  const project = config.projects[projectKeyOf(ref)];
  if (!project) return;

  // The whole per-ref flow (including the PR lookup, which shells out to gh
  // and can throw on auth/network trouble) sits inside the guard so one
  // failing ref never blocks its batch siblings or the cursor advance.
  try {
    const prNumber = await findOpenAgentPr(project.repo, ref);
    if (prNumber === null) {
      console.log(`${ref} stamped done but has no open agent PR — interactive work, skipping`);
      return;
    }
    if (dryRun) {
      console.log(`[dry-run] would merge PR #${prNumber} for ${ref}, deploy from a clean clone, and comment`);
      return;
    }

    const mergeSha = await mergeAgentPr(project.repo, prNumber);
    console.log(`${ref}: merged PR #${prNumber} at ${mergeSha}`);
    let deploy: Awaited<ReturnType<typeof runDeploy>> = { ran: false };
    if (config.delivery?.deploy !== false) {
      const cloneDir = path.join(cloneRootOf(config), projectKeyOf(ref));
      await ensureCleanClone(project.repo, cloneDir);
      deploy = await runDeploy(cloneDir);
      console.log(`${ref}: deploy ${deploy.ran ? (deploy.ok ? "succeeded" : "FAILED") : "skipped"}`);
    }
    await postComment(config, token, ref, deliveryComment({ prNumber, mergeSha, deploy }));
  } catch (err) {
    const message = (err as Error).message;
    console.error(`delivery failed for ${ref}: ${message}`);
    await postComment(config, token, ref, deliveryFailureComment(ref, message)).catch((e: Error) =>
      console.error(`could not comment the failure on ${ref}: ${e.message}`)
    );
  }
}

async function tick(config: WorkerConfig, token: string, gate: ReturnType<typeof newTickGate>, dryRun: boolean): Promise<void> {
  await runGated(gate, async () => {
    const url = `${config.url.replace(/\/$/, "")}/api/events?limit=200`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`GET /api/events failed: ${res.status} ${await res.text()}`);
    const feed = (await res.json()) as DeliveryFeedEvent[];

    const cursor = readCursor();
    const { refs, lastEventId } = findDeliverableRefs(feed, Object.keys(config.projects), cursor);
    for (const ref of refs) {
      // Sequential on purpose: deliveries deploy; two at once would race the clone.
      await deliver(ref, config, token, dryRun);
    }
    // Written after delivery so a crash mid-batch re-runs the refs — safe,
    // because a merged PR is no longer open and gets skipped on the retry.
    if (lastEventId !== null && lastEventId !== cursor) writeCursor(lastEventId);
  });
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
  const gate = newTickGate();

  if (once) {
    await tick(config, token, gate, dryRun);
    return;
  }

  const releaseLock = acquirePidLock(path.join(repoRoot(), ".superpowers", "deliver.pid"));
  await tick(config, token, gate, dryRun);

  const pollSeconds = config.delivery?.pollSeconds ?? DEFAULT_POLL_SECONDS;
  console.log(`delivery worker polling every ${pollSeconds}s (projects: ${Object.keys(config.projects).join(", ")})`);
  const timer = setInterval(() => {
    tick(config, token, gate, dryRun).catch((err) => console.error(`delivery tick failed: ${(err as Error).message}`));
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
