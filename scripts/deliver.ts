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

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDotEnv, validateWorkerConfig } from "./init-worker-lib.js";
import {
  projectKeyOf, newTickGate, runGated, withRetry, HttpStatusError, type WorkerConfig,
} from "./worker-select.js";
import {
  findDeliverableRefs,
  feedGap,
  parseCursorText,
  deliveryComment,
  deliveryFailureComment,
  verificationFailureComment,
  type DeliveryEventInput,
  type DeliveryFeedEvent,
} from "./delivery-lib.js";
import { findOpenAgentPr, mergeAgentPr, ensureCleanClone, runVerification, runDeploy } from "./delivery-exec.js";
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
  // Write-then-rename so a crash mid-write can never leave a truncated
  // cursor file for readCursor()/parseCursorText() to trip over.
  const tmpPath = `${cursorPath()}.tmp-${process.pid}`;
  writeFileSync(tmpPath, `${id}\n`);
  renameSync(tmpPath, cursorPath());
}

function cloneRootOf(config: WorkerConfig): string {
  return config.delivery?.cloneDir ?? path.join(os.homedir(), ".switchyard", "deliver-clones");
}

/** Retries the tracker write across a self-deploy restart (SYD-66: the
 * tracker is down ~5-15s during its own deploy, and a write landing in that
 * window used to be silently lost). Logs each retry and, if every attempt is
 * exhausted, logs the payload so it isn't lost silently before rethrowing —
 * callers keep their existing catch/log handling on top of that. */
async function postWithRetry(url: string, token: string, label: string, payload: unknown): Promise<void> {
  try {
    await withRetry(
      async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new HttpStatusError(res.status, `${label} failed: ${res.status} ${await res.text()}`);
      },
      {
        onRetry: (attempt, err, delayMs) =>
          console.error(`retrying ${label} (attempt ${attempt}, in ${delayMs}ms): ${(err as Error).message}`),
      }
    );
  } catch (err) {
    console.error(`giving up on ${label} after retries: ${(err as Error).message}\n  payload: ${JSON.stringify(payload)}`);
    throw err;
  }
}

async function postComment(config: WorkerConfig, token: string, ref: string, body: string): Promise<void> {
  const url = `${config.url.replace(/\/$/, "")}/api/issues/${ref}/comments`;
  await postWithRetry(url, token, `POST comment on ${ref}`, { body });
}

/** Records a structured delivery event (SYD-54) alongside the prose comment
 * so the issue UI can render a delivery strip without parsing text. */
async function postDeliveryEvent(
  config: WorkerConfig, token: string, ref: string, input: DeliveryEventInput
): Promise<void> {
  const url = `${config.url.replace(/\/$/, "")}/api/issues/${ref}/delivery-events`;
  await postWithRetry(url, token, `POST delivery-events on ${ref}`, input);
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

      if (config.delivery?.verify !== false) {
        const verify = await runVerification(cloneDir);
        if (!verify.ok) {
          console.error(`${ref}: post-merge verification FAILED — main is red, deploy skipped`);
          await postComment(config, token, ref, verificationFailureComment(prNumber, mergeSha, verify.tail));
          await postDeliveryEvent(config, token, ref, {
            type: "delivery_failed",
            message: `post-merge verification failed after merging PR #${prNumber} at ${mergeSha} — deploy skipped:\n${verify.tail}`,
          }).catch((e: Error) => console.error(`could not record delivery_failed event for ${ref}: ${e.message}`));
          return;
        }
      }

      deploy = await runDeploy(cloneDir);
      console.log(`${ref}: deploy ${deploy.ran ? (deploy.ok ? "succeeded" : "FAILED") : "skipped"}`);
    }
    await postComment(config, token, ref, deliveryComment({ prNumber, mergeSha, deploy }));
    await postDeliveryEvent(config, token, ref, { type: "delivered", prNumber, mergeSha, deploy }).catch((e: Error) =>
      console.error(`could not record delivered event for ${ref}: ${e.message}`)
    );
  } catch (err) {
    const message = (err as Error).message;
    console.error(`delivery failed for ${ref}: ${message}`);
    if (dryRun) return;
    await postComment(config, token, ref, deliveryFailureComment(ref, message)).catch((e: Error) =>
      console.error(`could not comment the failure on ${ref}: ${e.message}`)
    );
    await postDeliveryEvent(config, token, ref, { type: "delivery_failed", message }).catch((e: Error) =>
      console.error(`could not record delivery_failed event on ${ref}: ${e.message}`)
    );
  }
}

async function tick(config: WorkerConfig, token: string, gate: ReturnType<typeof newTickGate>, dryRun: boolean): Promise<void> {
  await runGated(gate, async () => {
    const url = `${config.url.replace(/\/$/, "")}/api/events?limit=500`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`GET /api/events failed: ${res.status} ${await res.text()}`);
    const feed = (await res.json()) as DeliveryFeedEvent[];

    const cursor = readCursor();
    const gap = feedGap(feed, cursor);
    if (gap) {
      console.error(
        `WARNING: event feed window no longer reaches the cursor — events ${gap.from}..${gap.to} were missed. ` +
        `Any done-stamps in that range were NOT delivered; check the board for stamped-but-unmerged issues.`
      );
    }
    const { refs, lastEventId } = findDeliverableRefs(feed, Object.keys(config.projects), cursor);
    for (const ref of refs) {
      // Sequential on purpose: deliveries deploy; two at once would race the clone.
      await deliver(ref, config, token, dryRun);
    }
    // Written after delivery so a crash mid-batch re-runs the refs — safe,
    // because a merged PR is no longer open and gets skipped on the retry.
    // Skipped under --dry-run: dry runs must be non-mutating, so a dry run
    // never consumes a real approval out from under the next real tick.
    if (!dryRun && lastEventId !== null && lastEventId !== cursor) writeCursor(lastEventId);
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

  // Dry runs are non-mutating (never merge/deploy/comment/advance the
  // cursor), so they're safe to overlap with a live worker or each other —
  // only a real run (looped or --once) needs exclusivity.
  const releaseLock = dryRun ? null : acquirePidLock(path.join(repoRoot(), ".superpowers", "deliver.pid"));

  if (once) {
    try {
      await tick(config, token, gate, dryRun);
    } finally {
      releaseLock?.();
    }
    return;
  }

  await tick(config, token, gate, dryRun);

  const pollSeconds = config.delivery?.pollSeconds ?? DEFAULT_POLL_SECONDS;
  console.log(`delivery worker polling every ${pollSeconds}s (projects: ${Object.keys(config.projects).join(", ")})`);
  const timer = setInterval(() => {
    tick(config, token, gate, dryRun).catch((err) => console.error(`delivery tick failed: ${(err as Error).message}`));
  }, pollSeconds * 1000);

  const stop = () => {
    clearInterval(timer);
    releaseLock?.();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("exit", () => releaseLock?.());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
