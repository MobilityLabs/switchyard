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
  projectKeyOf,
  newTickGate,
  runGated,
  withRetry,
  HttpStatusError,
  egressMode,
  ensureEgressGuard,
  type WorkerConfig,
  type WorkerProject,
} from "./worker-select.js";
import {
  findDeliverableRefs,
  findRedeliverRefs,
  feedGap,
  parseCursorText,
  deliveryComment,
  deliveryFailureComment,
  verificationFailureComment,
  autoRebasedNote,
  autoRebaseConflictComment,
  autoRebaseVerifyFailedComment,
  selectReconcilableRefs,
  reconciledComment,
  shouldDispatchConflictResolution,
  conflictResolutionFailedComment,
  conflictResolvedNote,
  isQueueMode,
  shouldRetryQueueRebase,
  MAX_QUEUE_MERGE_ATTEMPTS,
  queueRebaseConflictComment,
  queueVerifyFailedComment,
  queueDeliveredNote,
  agentBranch,
  MAIN_BRANCH,
  type DeliveryEventInput,
  type DeliveryFeedEvent,
  type AttentionIssueRow,
} from "./delivery-lib.js";
import {
  findOpenAgentPr,
  mergeAgentPr,
  ensureCleanClone,
  runVerification,
  runDeploy,
  attemptAutoRebase,
  findMergedAgentPr,
  dispatchConflictResolution,
  pollUntilMergeable,
} from "./delivery-exec.js";
import { acquirePidLock } from "./pidfile.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

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
  if (problems.length > 0)
    throw new Error(`invalid ${configPath}:\n  - ${problems.join("\n  - ")}`);
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
async function postWithRetry(
  url: string,
  token: string,
  label: string,
  payload: unknown,
): Promise<void> {
  try {
    await withRetry(
      async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(payload),
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
      `giving up on ${label} after retries: ${(err as Error).message}\n  payload: ${JSON.stringify(payload)}`,
    );
    throw err;
  }
}

async function postComment(
  config: WorkerConfig,
  token: string,
  ref: string,
  body: string,
): Promise<void> {
  const url = `${config.url.replace(/\/$/, "")}/api/issues/${ref}/comments`;
  await postWithRetry(url, token, `POST comment on ${ref}`, { body });
}

/** Records a structured delivery event (SYD-54) alongside the prose comment
 * so the issue UI can render a delivery strip without parsing text. */
async function postDeliveryEvent(
  config: WorkerConfig,
  token: string,
  ref: string,
  input: DeliveryEventInput,
): Promise<void> {
  const url = `${config.url.replace(/\/$/, "")}/api/issues/${ref}/delivery-events`;
  await postWithRetry(url, token, `POST delivery-events on ${ref}`, input);
}

/**
 * Shared delivery tail (SYD-164): deploys from a clean clone (post-merge
 * verify as a backstop — redundant under queue mode's pre-merge gate, but
 * kept as defense in depth), then comments and records the `delivered`
 * event. Used by both the legacy merge-first flow and the queue flow below
 * once each has a merge SHA in hand, so the deploy/verify/comment behavior
 * can't drift between them. `note`, if given, is prepended to the delivered
 * comment to say how the merge was reached (auto-rebased, conflict-resolved,
 * or queue mode).
 */
async function finishDelivery(
  ref: string,
  project: WorkerProject,
  config: WorkerConfig,
  token: string,
  cloneDir: string,
  prNumber: number,
  mergeSha: string,
  note: string | null,
): Promise<void> {
  let deploy: Awaited<ReturnType<typeof runDeploy>> = { ran: false };
  if (config.delivery?.deploy !== false) {
    await ensureCleanClone(project.repo, cloneDir);

    if (config.delivery?.verify !== false) {
      const verify = await runVerification(cloneDir);
      if (!verify.ok) {
        console.error(`${ref}: post-merge verification FAILED — main is red, deploy skipped`);
        await postComment(
          config,
          token,
          ref,
          verificationFailureComment(prNumber, mergeSha, verify.tail),
        );
        await postDeliveryEvent(config, token, ref, {
          type: "delivery_failed",
          message: `post-merge verification failed after merging PR #${prNumber} at ${mergeSha} — deploy skipped:\n${verify.tail}`,
        }).catch((e: Error) =>
          console.error(`could not record delivery_failed event for ${ref}: ${e.message}`),
        );
        return;
      }
    }

    deploy = await runDeploy(cloneDir);
    console.log(`${ref}: deploy ${deploy.ran ? (deploy.ok ? "succeeded" : "FAILED") : "skipped"}`);
  }
  const commentBody = deliveryComment({ prNumber, mergeSha, deploy });
  await postComment(config, token, ref, note ? `${note}\n\n${commentBody}` : commentBody);
  await postDeliveryEvent(config, token, ref, {
    type: "delivered",
    prNumber,
    mergeSha,
    deploy,
  }).catch((e: Error) =>
    console.error(`could not record delivered event for ${ref}: ${e.message}`),
  );
}

/**
 * Queue-mode per-ref flow (SYD-164): rebase agent/<ref> onto current
 * origin/main and verify the REBASED tree (typecheck + tests) *before* ever
 * attempting the merge — turning what the legacy flow would land and only
 * catch via the post-merge verify gate (SYD-78) into a pre-merge rejection.
 * A conflict or a failing verify bounces the ref (comment + delivery_failed)
 * instead of repairing in place: main is never touched, and no
 * conflict-resolution session is dispatched (SYD-100 stays a legacy-only
 * tier). attemptAutoRebase already implements the rebase+verify+force-push
 * steps; this loop only adds the merge attempt and a bounded retry for the
 * rare case where main moves again in the window between the force-push and
 * the merge (e.g. a human merges something else by hand) — each retry redoes
 * the full cycle against the newer main rather than retrying a merge that
 * was only verified against a now-stale one.
 */
export async function deliverQueue(
  ref: string,
  project: WorkerProject,
  config: WorkerConfig,
  token: string,
  cloneDir: string,
  prNumber: number,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const rebase = await attemptAutoRebase(project.repo, cloneDir, ref);
    if (rebase.status === "no-branch") {
      throw new Error(
        `queue mode: no ${agentBranch(ref)} branch found to rebase for PR #${prNumber}`,
      );
    }
    if (rebase.status === "conflict") {
      console.log(
        `${ref}: queue-mode rebase hit conflicts in ${rebase.files.join(", ") || "(unknown files)"}`,
      );
      await postComment(config, token, ref, queueRebaseConflictComment(ref, rebase.files));
      await postDeliveryEvent(config, token, ref, {
        type: "delivery_failed",
        message: `queue-mode rebase onto ${MAIN_BRANCH} hit real conflicts`,
      }).catch((e: Error) =>
        console.error(`could not record delivery_failed event on ${ref}: ${e.message}`),
      );
      return;
    }
    if (rebase.status === "verify-failed") {
      console.log(
        `${ref}: queue-mode rebase applied cleanly but the post-rebase verify gate failed`,
      );
      await postComment(config, token, ref, queueVerifyFailedComment(ref, rebase.tail));
      await postDeliveryEvent(config, token, ref, {
        type: "delivery_failed",
        message: "queue-mode rebase applied cleanly but the post-rebase verify gate failed",
      }).catch((e: Error) =>
        console.error(`could not record delivery_failed event on ${ref}: ${e.message}`),
      );
      return;
    }

    console.log(
      `${ref}: queue-mode rebased onto ${MAIN_BRANCH} at ${rebase.sha} (attempt ${attempt}/${MAX_QUEUE_MERGE_ATTEMPTS})`,
    );
    const mergeable = await pollUntilMergeable(project.repo, prNumber);
    console.log(`${ref}: post-rebase mergeability=${mergeable}`);
    let mergeSha: string;
    try {
      mergeSha = await mergeAgentPr(project.repo, prNumber);
    } catch (mergeErr) {
      if (!shouldRetryQueueRebase(attempt)) throw mergeErr;
      console.log(
        `${ref}: queue-mode merge failed after rebase (${(mergeErr as Error).message}) — ` +
          `${MAIN_BRANCH} moved again, re-rebasing`,
      );
      continue;
    }
    // Outside the retry catch (SYD-174): main already has the commit at this
    // point, so a finishDelivery failure (deploy, comment, or event POST) is a
    // post-merge problem, not a lost merge race — re-rebasing here would only
    // hit "no branch found" against the PR's now-deleted branch. Let it
    // propagate to deliver()'s outer per-ref handler, which logs and moves on;
    // the reconciliation pass (SYD-94) clears the flag once things settle.
    console.log(`${ref}: merged PR #${prNumber} at ${mergeSha} (queue mode)`);
    await finishDelivery(
      ref,
      project,
      config,
      token,
      cloneDir,
      prNumber,
      mergeSha,
      queueDeliveredNote(ref),
    );
    return;
  }
}

async function deliver(
  ref: string,
  config: WorkerConfig,
  token: string,
  dryRun: boolean,
): Promise<void> {
  const project = config.projects[projectKeyOf(ref)];
  if (!project) return;

  // The whole per-ref flow (including the PR lookup, which shells out to gh
  // and can throw on auth/network trouble) sits inside the guard so one
  // failing ref never blocks its batch siblings or the cursor advance.
  try {
    const prNumber = await findOpenAgentPr(project.repo, ref);
    if (prNumber === null) {
      console.log(`${ref} has no open agent PR — interactive work, skipping`);
      return;
    }
    const queueMode = isQueueMode(config);
    if (dryRun) {
      console.log(
        `[dry-run] would ${queueMode ? "rebase onto main, verify, and merge" : "merge"} PR #${prNumber} for ${ref}, ` +
          "deploy from a clean clone, and comment",
      );
      return;
    }

    const cloneDir = path.join(cloneRootOf(config), projectKeyOf(ref));

    if (queueMode) {
      await deliverQueue(ref, project, config, token, cloneDir, prNumber);
      return;
    }

    let mergeSha: string;
    let rebased = false;
    let resolvedConflict = false;
    try {
      // Poll before the very first merge attempt too (SYD-152): a PR pushed
      // or force-pushed moments earlier (e.g. by publishAgentBranch, or by an
      // auto-rebase from a prior delivery attempt on this same ref) can still
      // read `mergeable=UNKNOWN` here, and `gh pr merge` against UNKNOWN fails
      // with a false "not mergeable" delivery_failed even though the PR is
      // actually clean. Same advisory poll already used before the
      // post-rebase retry merges below — it never gates the merge attempt,
      // it just gives GitHub's async mergeability recompute a chance to
      // settle first.
      const mergeable = await pollUntilMergeable(project.repo, prNumber);
      console.log(`${ref}: PR #${prNumber} mergeability=${mergeable}`);
      mergeSha = await mergeAgentPr(project.repo, prNumber);
    } catch (mergeErr) {
      // Merge-failure is the steady state under batch stamping (N parallel
      // agent branches, aging main) — try one mechanical rebase before
      // escalating. A failed post-rebase verify gate stops here and gets
      // reported; conflict hunks get one dispatched resolution attempt
      // (SYD-100) when eligible before escalating. Only a clean or resolved,
      // verified rebase retries the merge, and only once per done-stamp
      // (neither attemptAutoRebase nor the resolution dispatch loops).
      if (config.delivery?.autoRebase === false) throw mergeErr;
      const originalMessage = (mergeErr as Error).message;
      console.log(`${ref}: merge failed (${originalMessage}); attempting auto-rebase onto main`);
      const rebase = await attemptAutoRebase(project.repo, cloneDir, ref);
      if (rebase.status === "no-branch") throw mergeErr;
      if (rebase.status === "conflict") {
        console.log(
          `${ref}: auto-rebase hit conflicts in ${rebase.files.join(", ") || "(unknown files)"}`,
        );
        if (!shouldDispatchConflictResolution(config)) {
          await postComment(
            config,
            token,
            ref,
            autoRebaseConflictComment(ref, originalMessage, rebase.files),
          );
          await postDeliveryEvent(config, token, ref, {
            type: "delivery_failed",
            message: originalMessage,
          }).catch((e: Error) =>
            console.error(`could not record delivery_failed event on ${ref}: ${e.message}`),
          );
          return;
        }
        console.log(`${ref}: dispatching a conflict-resolution worker session`);
        const resolution = await dispatchConflictResolution(
          cloneDir,
          ref,
          rebase.files,
          project,
          config,
        );
        if (resolution.status !== "resolved") {
          console.log(`${ref}: conflict-resolution session did not produce a mergeable branch`);
          await postComment(
            config,
            token,
            ref,
            conflictResolutionFailedComment(ref, originalMessage, rebase.files, resolution.tail),
          );
          await postDeliveryEvent(config, token, ref, {
            type: "delivery_failed",
            message: originalMessage,
          }).catch((e: Error) =>
            console.error(`could not record delivery_failed event on ${ref}: ${e.message}`),
          );
          return;
        }
        console.log(
          `${ref}: conflict-resolution session resolved and pushed at ${resolution.sha}, retrying merge`,
        );
        const mergeable = await pollUntilMergeable(project.repo, prNumber);
        console.log(`${ref}: post-force-push mergeability=${mergeable}`);
        mergeSha = await mergeAgentPr(project.repo, prNumber);
        resolvedConflict = true;
        console.log(`${ref}: merged PR #${prNumber} at ${mergeSha} (after conflict resolution)`);
      } else if (rebase.status === "verify-failed") {
        console.log(`${ref}: auto-rebase applied cleanly but the post-rebase verify gate failed`);
        await postComment(config, token, ref, autoRebaseVerifyFailedComment(ref, rebase.tail));
        await postDeliveryEvent(config, token, ref, {
          type: "delivery_failed",
          message: "auto-rebase applied cleanly but the post-rebase verify gate failed",
        }).catch((e: Error) =>
          console.error(`could not record delivery_failed event on ${ref}: ${e.message}`),
        );
        return;
      } else {
        console.log(`${ref}: auto-rebased onto main at ${rebase.sha}, retrying merge`);
        const mergeable = await pollUntilMergeable(project.repo, prNumber);
        console.log(`${ref}: post-force-push mergeability=${mergeable}`);
        mergeSha = await mergeAgentPr(project.repo, prNumber);
        rebased = true;
      }
    }
    if (!resolvedConflict) {
      console.log(
        `${ref}: merged PR #${prNumber} at ${mergeSha}${rebased ? " (after auto-rebase)" : ""}`,
      );
    }
    const note = resolvedConflict
      ? conflictResolvedNote(ref)
      : rebased
        ? autoRebasedNote(ref)
        : null;
    await finishDelivery(ref, project, config, token, cloneDir, prNumber, mergeSha, note);
  } catch (err) {
    const message = (err as Error).message;
    console.error(`delivery failed for ${ref}: ${message}`);
    if (dryRun) return;
    await postComment(config, token, ref, deliveryFailureComment(ref, message)).catch((e: Error) =>
      console.error(`could not comment the failure on ${ref}: ${e.message}`),
    );
    await postDeliveryEvent(config, token, ref, { type: "delivery_failed", message }).catch(
      (e: Error) => console.error(`could not record delivery_failed event on ${ref}: ${e.message}`),
    );
  }
}

/** Fetches the issues currently flagged `delivery_failed` (SYD-84's attention
 * derivation), restricted server-side via `?attention=` so this stays cheap
 * in steady state (zero flagged issues ⇒ one small response, no gh calls). */
async function fetchAttentionFlaggedIssues(
  config: WorkerConfig,
  token: string,
): Promise<AttentionIssueRow[]> {
  const url = `${config.url.replace(/\/$/, "")}/api/issues?attention=delivery_failed`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok)
    throw new Error(
      `GET /api/issues?attention=delivery_failed failed: ${res.status} ${await res.text()}`,
    );
  return (await res.json()) as AttentionIssueRow[];
}

/**
 * Reconciliation pass (SYD-94): a delivery_failed issue's badge stays red
 * forever if a human merges the agent PR by hand instead of re-stamping done
 * (deliver.ts only ever records `delivered` from its own merge). For each
 * flagged ref, ask GitHub whether agent/<ref> was actually merged; if so,
 * record a `delivered` event (deploy never runs here — reconciliation only
 * clears the stale flag, it never ships anything) so the badge clears.
 * Left alone if the PR is still open or was closed unmerged — those are
 * genuinely unresolved.
 */
async function reconcile(
  ref: string,
  config: WorkerConfig,
  token: string,
  dryRun: boolean,
): Promise<void> {
  const project = config.projects[projectKeyOf(ref)];
  if (!project) return;
  try {
    const merged = await findMergedAgentPr(project.repo, ref);
    if (!merged) return;
    if (dryRun) {
      console.log(
        `[dry-run] would reconcile ${ref}: PR #${merged.prNumber} merged manually at ${merged.mergeSha}`,
      );
      return;
    }
    console.log(
      `${ref}: reconciling — PR #${merged.prNumber} was merged manually at ${merged.mergeSha}`,
    );
    await postComment(config, token, ref, reconciledComment(merged.prNumber, merged.mergeSha));
    await postDeliveryEvent(config, token, ref, {
      type: "delivered",
      prNumber: merged.prNumber,
      mergeSha: merged.mergeSha,
      deploy: { ran: false },
    });
  } catch (err) {
    console.error(`reconciliation failed for ${ref}: ${(err as Error).message}`);
  }
}

async function tick(
  config: WorkerConfig,
  token: string,
  gate: ReturnType<typeof newTickGate>,
  dryRun: boolean,
): Promise<void> {
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
          `Any done-stamps in that range were NOT delivered; check the board for stamped-but-unmerged issues.`,
      );
    }
    const { refs: doneRefs, lastEventId } = findDeliverableRefs(
      feed,
      Object.keys(config.projects),
      cursor,
    );
    const { refs: redeliverRefs } = findRedeliverRefs(feed, Object.keys(config.projects), cursor);
    const refs = [...new Set([...doneRefs, ...redeliverRefs])];
    for (const ref of refs) {
      // Sequential on purpose: deliveries deploy; two at once would race the clone.
      await deliver(ref, config, token, dryRun);
    }
    // Written after delivery so a crash mid-batch re-runs the refs — safe,
    // because a merged PR is no longer open and gets skipped on the retry.
    // Skipped under --dry-run: dry runs must be non-mutating, so a dry run
    // never consumes a real approval out from under the next real tick.
    if (!dryRun && lastEventId !== null && lastEventId !== cursor) writeCursor(lastEventId);

    if (config.delivery?.reconcile !== false) {
      const flagged = await fetchAttentionFlaggedIssues(config, token);
      const reconcilable = selectReconcilableRefs(flagged, Object.keys(config.projects));
      for (const ref of reconcilable) {
        await reconcile(ref, config, token, dryRun);
      }
    }
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

  // SYD-110: conflict-resolution dispatches are containers too — make sure
  // the egress guard exists before any might launch. Best-effort here (unlike
  // agent-worker's hard fail): merges/deploys must keep working even if
  // docker or the proxy image is unavailable; a conflict dispatch would then
  // fail visibly through the SYD-100 escalation path.
  if (egressMode(config) === "proxy" && !dryRun) {
    await ensureEgressGuard(config, async (cmd, cmdArgs) => execFileP(cmd, cmdArgs), process.env).catch(
      (err: Error) =>
        console.error(
          `WARNING: egress guard setup failed (SYD-110): ${err.message} — ` +
            "conflict-resolution dispatches will fail until `npm run build:worker-image` " +
            'has built the proxy image (or egress: "open" explicitly opts out)',
        ),
    );
  }

  // Dry runs are non-mutating (never merge/deploy/comment/advance the
  // cursor), so they're safe to overlap with a live worker or each other —
  // only a real run (looped or --once) needs exclusivity.
  const releaseLock = dryRun
    ? null
    : acquirePidLock(path.join(repoRoot(), ".superpowers", "deliver.pid"));

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
  console.log(
    `delivery worker polling every ${pollSeconds}s (projects: ${Object.keys(config.projects).join(", ")})`,
  );
  const timer = setInterval(() => {
    tick(config, token, gate, dryRun).catch((err) =>
      console.error(`delivery tick failed: ${(err as Error).message}`),
    );
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
