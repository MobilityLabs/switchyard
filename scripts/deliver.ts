// Delivery worker (SYD-49, SYD-208): triggers off the delivery-attempts ledger
// via GET /api/delivery-work instead of scanning the event feed with a cursor.
// A human moving an issue to done (agents can't — server-enforced), or clicking
// Retry, becomes a pending authorization; the worker starts one attempt per
// authorization (once-per-authorization enforced server-side), merges the open
// agent/<ref> PR, deploys from a dedicated clean clone (never a working tree),
// comments the merge SHA + deploy result, and finishes the attempt with an
// outcome. There is NO cursor file: an approval stamped while this worker is
// down is simply still pending on restart, because its authorization still has
// no attempt row. Crash resumption reads an attempt left open by a prior crash
// and consults the PR's LIVE GitHub state (never pr_state or the tracker) to
// decide whether the merge landed. Pin-less done-stamps are interactive work
// (no agent PR) and are never delivery authorizations — the server predicate
// excludes them entirely, so this worker never sees one to skip; redelivers
// always count, pin or no pin.
//
//   SWITCHYARD_TOKEN=... npx tsx scripts/deliver.ts            # loop forever
//   SWITCHYARD_TOKEN=... npx tsx scripts/deliver.ts --once     # single scan
//   SWITCHYARD_TOKEN=... npx tsx scripts/deliver.ts --dry-run  # print, don't merge
//
// Config: the `delivery` block of switchyard-worker.json (pollSeconds,
// cloneDir, deploy).

import { existsSync, readFileSync } from "node:fs";
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
  deliveryComment,
  deliveryFailureComment,
  verificationFailureComment,
  crashedAttemptComment,
  autoRebasedNote,
  autoRebaseConflictComment,
  autoRebaseVerifyFailedComment,
  shouldDispatchConflictResolution,
  conflictResolutionFailedComment,
  conflictResolvedNote,
  isQueueMode,
  shouldRetryQueueRebase,
  MAX_QUEUE_MERGE_ATTEMPTS,
  queueRebaseConflictComment,
  queueVerifyFailedComment,
  queueDeliveredNote,
  filterWorkToProjects,
  resumeActionFor,
  agentBranch,
  MAIN_BRANCH,
  type DeliveryEventInput,
  type DeliveryWork,
  type WorkAuthorization,
  type WorkAttempt,
  type WorkDeployRetry,
  type AttemptOutcome,
} from "./delivery-lib.js";
import {
  mergeAgentPr,
  ensureCleanClone,
  runVerification,
  runDeploy,
  attemptAutoRebase,
  dispatchConflictResolution,
  pollUntilMergeable,
  originOwnerRepo,
  prFreshness,
  prLiveState,
} from "./delivery-exec.js";
import { acquirePidLock } from "./pidfile.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const DEFAULT_POLL_SECONDS = 30;

/** Outcome of a merge flow, plus the post-rebase head (S1) when a rebase or
 * force-push produced the merged head — the caller PATCHes both onto the
 * attempt row. */
type DeliverOutcome = { outcome: AttemptOutcome; derivedHeadSha?: string };

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

function cloneRootOf(config: WorkerConfig): string {
  return config.delivery?.cloneDir ?? path.join(os.homedir(), ".switchyard", "deliver-clones");
}

function apiBase(config: WorkerConfig): string {
  return config.url.replace(/\/$/, "");
}

/** Retries the tracker write across a self-deploy restart (SYD-66: the
 * tracker is down ~5-15s during its own deploy, and a write landing in that
 * window used to be silently lost). Logs each retry and, if every attempt is
 * exhausted, logs the payload so it isn't lost silently before rethrowing —
 * callers keep their existing catch/log handling on top of that. */
async function sendWithRetry(
  url: string,
  token: string,
  method: "POST" | "PATCH",
  label: string,
  payload: unknown,
): Promise<void> {
  try {
    await withRetry(
      async () => {
        const res = await fetch(url, {
          method,
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

async function postWithRetry(
  url: string,
  token: string,
  label: string,
  payload: unknown,
): Promise<void> {
  await sendWithRetry(url, token, "POST", label, payload);
}

async function postComment(
  config: WorkerConfig,
  token: string,
  ref: string,
  body: string,
): Promise<void> {
  const url = `${apiBase(config)}/api/issues/${ref}/comments`;
  await postWithRetry(url, token, `POST comment on ${ref}`, { body });
}

/** Records a structured delivery event (SYD-54) alongside the prose comment
 * so the issue UI can render a delivery strip without parsing text. Names the
 * project's origin repo on every event (SYD-205) — best-effort, so a missing
 * origin remote can never drop the event itself. */
async function postDeliveryEvent(
  config: WorkerConfig,
  token: string,
  ref: string,
  input: DeliveryEventInput,
): Promise<void> {
  let event = input;
  const project = config.projects[projectKeyOf(ref)];
  if (!event.repo && project) {
    try {
      event = { ...event, repo: await originOwnerRepo(project.repo) };
    } catch (err) {
      console.error(`could not resolve origin repo for ${ref}: ${(err as Error).message}`);
    }
  }
  const url = `${apiBase(config)}/api/issues/${ref}/delivery-events`;
  await postWithRetry(url, token, `POST delivery-events on ${ref}`, event);
}

/** Opens a delivery attempt against an authorization (SYD-208) and returns its
 * id. Once-per-authorization is enforced server-side (a second start 400s), so
 * a duplicate tick can never double-deliver. Needs the response body (the id),
 * so it can't reuse postWithRetry's void wrapper. */
async function startAttempt(
  config: WorkerConfig,
  token: string,
  ref: string,
  body: { authorizationId: number; prNumber?: number; headSha?: string; deployRetry?: boolean },
): Promise<{ id: number }> {
  const url = `${apiBase(config)}/api/issues/${ref}/delivery-attempts`;
  return withRetry(
    async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok)
        throw new HttpStatusError(
          res.status,
          `POST delivery-attempt on ${ref} failed: ${res.status} ${await res.text()}`,
        );
      return (await res.json()) as { id: number };
    },
    {
      onRetry: (attempt, err, delayMs) =>
        console.error(
          `retrying POST delivery-attempt on ${ref} (attempt ${attempt}, in ${delayMs}ms): ${(err as Error).message}`,
        ),
    },
  );
}

/** Finishes an open attempt with its outcome (and, for a rebase/force-push
 * merge, the derived head S1). */
async function finishAttempt(
  config: WorkerConfig,
  token: string,
  attemptId: number,
  body: { outcome: AttemptOutcome; derivedHeadSha?: string },
): Promise<void> {
  const url = `${apiBase(config)}/api/delivery-attempts/${attemptId}`;
  await sendWithRetry(url, token, "PATCH", `PATCH delivery-attempt ${attemptId}`, body);
}

/**
 * Shared delivery tail (SYD-164): deploys from a clean clone (post-merge
 * verify as a backstop — redundant under queue mode's pre-merge gate, but
 * kept as defense in depth), then comments and records the `delivered`
 * event. Used by the legacy merge-first flow, the queue flow, crash
 * resumption, and deploy retries once each has a merge SHA in hand, so the
 * deploy/verify/comment behavior can't drift between them. `note`, if given,
 * is prepended to the delivered comment to say how the merge was reached.
 *
 * Returns `"merged_deploy_failed"` when the post-merge verify gate fails or
 * the deploy step fails (the merge already landed either way — the deploy-
 * retry query owns it), else `"merged_deployed"`.
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
): Promise<"merged_deployed" | "merged_deploy_failed"> {
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
        return "merged_deploy_failed";
      }
    }

    deploy = await runDeploy(cloneDir);
    console.log(`${ref}: deploy ${deploy.ran ? (deploy.ok ? "succeeded" : "FAILED") : "skipped"}`);
  }
  const commentBody = deliveryComment({ prNumber, mergeSha, deploy });
  await postComment(config, token, ref, note ? `${note}\n\n${commentBody}` : commentBody);
  // GitHub's own head/timestamp for the merged PR (SYD-206): the merge writer
  // of pr_state must never use a local clock. Best-effort — a failed lookup
  // never drops the delivered event.
  let freshness: { headSha: string; ghUpdatedAt: string } | undefined;
  try {
    freshness = await prFreshness(project.repo, prNumber);
  } catch (err) {
    console.error(`could not fetch PR freshness for ${ref} #${prNumber}: ${(err as Error).message}`);
  }
  await postDeliveryEvent(config, token, ref, {
    type: "delivered",
    prNumber,
    mergeSha,
    deploy,
    ...(freshness ?? {}),
  }).catch((e: Error) =>
    console.error(`could not record delivered event for ${ref}: ${e.message}`),
  );
  return deploy.ran && !deploy.ok ? "merged_deploy_failed" : "merged_deployed";
}

/**
 * Runs the delivery tail with post-merge failure protection (SYD-208): the
 * merge has already landed, so a failure in the deploy tail (verify, deploy,
 * or a comment/event POST that throws while the tracker is briefly down) must
 * NEVER be reported as `merge_failed` — that would tell the ledger the merge
 * never happened. It maps to `merged_deploy_failed`, which the deploy-retry
 * query then owns. A thrown post-merge failure is logged and swallowed into
 * that outcome rather than propagating to the outer per-ref handler (which
 * finishes attempts as merge_failed). Mirrors the SYD-174 concern in
 * deliverQueue: once main has the commit, re-running merge machinery is wrong.
 */
async function runDeliveryTail(
  ref: string,
  project: WorkerProject,
  config: WorkerConfig,
  token: string,
  cloneDir: string,
  prNumber: number,
  mergeSha: string,
  note: string | null,
): Promise<"merged_deployed" | "merged_deploy_failed"> {
  try {
    return await finishDelivery(ref, project, config, token, cloneDir, prNumber, mergeSha, note);
  } catch (err) {
    console.error(
      `${ref}: post-merge delivery tail failed after merging PR #${prNumber} at ${mergeSha}: ${(err as Error).message}`,
    );
    return "merged_deploy_failed";
  }
}

/**
 * Queue-mode per-ref flow (SYD-164): rebase agent/<ref> onto current
 * origin/main and verify the REBASED tree (typecheck + tests) *before* ever
 * attempting the merge. A conflict or a failing verify bounces the ref
 * (comment + delivery_failed) instead of repairing in place: main is never
 * touched. attemptAutoRebase already implements the rebase+verify+force-push
 * steps; this loop only adds the merge attempt and a bounded retry for the
 * rare case where main moves again between the force-push and the merge.
 * Returns the attempt outcome (and the rebased head S1 on success).
 */
export async function deliverQueue(
  ref: string,
  project: WorkerProject,
  config: WorkerConfig,
  token: string,
  cloneDir: string,
  prNumber: number,
): Promise<DeliverOutcome> {
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
      return { outcome: "conflict_bounced" };
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
      return { outcome: "verify_failed" };
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
    // Outside the retry catch (SYD-174): main already has the commit, so a
    // finishDelivery failure is a post-merge problem, not a lost merge — never
    // re-rebase it (that would hit "no branch found" against the now-deleted
    // branch) and never call it merge_failed. runDeliveryTail maps any
    // post-merge failure to merged_deploy_failed, which the deploy-retry query
    // owns (SYD-208, replacing the propagate-to-outer-handler of SYD-174).
    console.log(`${ref}: merged PR #${prNumber} at ${mergeSha} (queue mode)`);
    const outcome = await runDeliveryTail(
      ref,
      project,
      config,
      token,
      cloneDir,
      prNumber,
      mergeSha,
      queueDeliveredNote(ref),
    );
    return { outcome, derivedHeadSha: rebase.sha };
  }
}

/**
 * Legacy merge-first flow: try the merge, and only on failure attempt one
 * mechanical rebase (SYD-85) and, if that conflicts and the config allows, one
 * dispatched conflict-resolution session (SYD-100). Returns the attempt
 * outcome (and the derived head S1 when the merge only landed after a
 * rebase/resolution).
 */
async function deliverLegacy(
  ref: string,
  project: WorkerProject,
  config: WorkerConfig,
  token: string,
  cloneDir: string,
  prNumber: number,
): Promise<DeliverOutcome> {
  let mergeSha: string;
  let derivedHeadSha: string | undefined;
  let rebased = false;
  let resolvedConflict = false;
  try {
    // Poll before the very first merge attempt too (SYD-152): a PR pushed or
    // force-pushed moments earlier can still read mergeable=UNKNOWN here, and
    // `gh pr merge` against UNKNOWN fails with a false "not mergeable".
    const mergeable = await pollUntilMergeable(project.repo, prNumber);
    console.log(`${ref}: PR #${prNumber} mergeability=${mergeable}`);
    mergeSha = await mergeAgentPr(project.repo, prNumber);
  } catch (mergeErr) {
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
        return { outcome: "conflict_bounced" };
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
        return { outcome: "conflict_bounced" };
      }
      console.log(
        `${ref}: conflict-resolution session resolved and pushed at ${resolution.sha}, retrying merge`,
      );
      const mergeable = await pollUntilMergeable(project.repo, prNumber);
      console.log(`${ref}: post-force-push mergeability=${mergeable}`);
      mergeSha = await mergeAgentPr(project.repo, prNumber);
      resolvedConflict = true;
      derivedHeadSha = resolution.sha;
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
      return { outcome: "verify_failed" };
    } else {
      console.log(`${ref}: auto-rebased onto main at ${rebase.sha}, retrying merge`);
      const mergeable = await pollUntilMergeable(project.repo, prNumber);
      console.log(`${ref}: post-force-push mergeability=${mergeable}`);
      mergeSha = await mergeAgentPr(project.repo, prNumber);
      rebased = true;
      derivedHeadSha = rebase.sha;
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
  const outcome = await runDeliveryTail(ref, project, config, token, cloneDir, prNumber, mergeSha, note);
  return { outcome, derivedHeadSha };
}

/**
 * Delivers one pending authorization: starts an attempt, checks the pinned
 * PR's LIVE GitHub state, and either runs the deploy tail (already MERGED —
 * never re-merge), bounces (CLOSED unmerged), or runs the OPEN merge flow.
 * The outer catch finishes a started-but-unfinished attempt as merge_failed
 * (a genuine pre-merge failure) and posts the usual failure comment/event.
 */
async function deliverPending(
  auth: WorkAuthorization,
  config: WorkerConfig,
  token: string,
  dryRun: boolean,
): Promise<void> {
  const ref = auth.ref;
  const project = config.projects[projectKeyOf(ref)];
  if (!project) return;

  if (dryRun) {
    console.log(
      `[dry-run] would deliver ${ref} (authorization ${auth.authorizationId}, ` +
        `${auth.pin ? `PR #${auth.pin.prNumber}` : "no PR pinned"})`,
    );
    return;
  }

  const cloneDir = path.join(cloneRootOf(config), projectKeyOf(ref));
  // Kept live only while the attempt is unfinished, so the outer catch can
  // stamp merge_failed on a genuine pre-merge failure. Nulled right before
  // every terminal finishAttempt: if that finish then throws (tracker down),
  // the attempt is left unfinished on purpose — crash resumption re-drives it
  // against live GitHub next tick rather than the catch mislabeling it.
  let attemptId: number | null = null;
  try {
    if (auth.pin === null) {
      // Defensive only (SYD-208 final review): the server predicate
      // (listPendingDeliveryAuthorizations) now requires a pin on the
      // status_changed arm, so a pin-less done_stamp authorization is never
      // emitted any more — pin-less done-stamps are interactive work (no
      // agent PR), not delivery authorizations, and are skipped silently.
      // This branch should be unreachable; if it's ever hit anyway (a stale
      // server, a future regression) it must stay a quiet skip rather than
      // starting an attempt and posting a false "Delivery FAILED" comment on
      // an ordinary interactive issue.
      console.log(`${ref}: authorization ${auth.authorizationId} carries no PR pin — skipping`);
      return;
    }

    const started = await startAttempt(config, token, ref, {
      authorizationId: auth.authorizationId,
      prNumber: auth.pin.prNumber,
      headSha: auth.pin.headSha ?? undefined,
    });
    attemptId = started.id;
    const live = await prLiveState(project.repo, auth.pin.prNumber);

    if (live.state === "MERGED") {
      // Already merged — deploy tail only, NEVER mergeAgentPr (no re-merge).
      const outcome = await runDeliveryTail(
        ref,
        project,
        config,
        token,
        cloneDir,
        auth.pin.prNumber,
        live.mergeCommit ?? auth.pin.headSha ?? "unknown",
        null,
      );
      const id = attemptId;
      attemptId = null;
      await finishAttempt(config, token, id, { outcome });
      return;
    }

    if (live.state === "CLOSED") {
      const id = attemptId;
      attemptId = null;
      await finishAttempt(config, token, id, { outcome: "merge_failed" });
      const message = `PR #${auth.pin.prNumber} was closed unmerged`;
      await postComment(config, token, ref, deliveryFailureComment(ref, message)).catch((e: Error) =>
        console.error(`could not comment the failure on ${ref}: ${e.message}`),
      );
      await postDeliveryEvent(config, token, ref, { type: "delivery_failed", message }).catch(
        (e: Error) =>
          console.error(`could not record delivery_failed event on ${ref}: ${e.message}`),
      );
      return;
    }

    // OPEN → the existing merge flow, against the pinned PR number.
    const result = isQueueMode(config)
      ? await deliverQueue(ref, project, config, token, cloneDir, auth.pin.prNumber)
      : await deliverLegacy(ref, project, config, token, cloneDir, auth.pin.prNumber);
    const id = attemptId;
    attemptId = null;
    await finishAttempt(config, token, id, {
      outcome: result.outcome,
      derivedHeadSha: result.derivedHeadSha,
    });
  } catch (err) {
    const message = (err as Error).message;
    console.error(`delivery failed for ${ref}: ${message}`);
    if (attemptId !== null) {
      await finishAttempt(config, token, attemptId, { outcome: "merge_failed" }).catch((e: Error) =>
        console.error(`could not finish delivery attempt for ${ref}: ${e.message}`),
      );
    }
    await postComment(config, token, ref, deliveryFailureComment(ref, message)).catch((e: Error) =>
      console.error(`could not comment the failure on ${ref}: ${e.message}`),
    );
    await postDeliveryEvent(config, token, ref, { type: "delivery_failed", message }).catch(
      (e: Error) => console.error(`could not record delivery_failed event on ${ref}: ${e.message}`),
    );
  }
}

/**
 * Resumes an attempt a prior crash left unfinished (SYD-208). Consults the
 * PR's LIVE GitHub state — never pr_state or the tracker — because only GitHub
 * knows whether the merge landed. MERGED → run the deploy tail and finish it;
 * OPEN/CLOSED (or no PR pinned) → the merge never landed, so finish
 * merge_failed and post the crash comment/event for a human to re-authorize.
 */
async function resumeAttempt(
  attempt: WorkAttempt,
  config: WorkerConfig,
  token: string,
  dryRun: boolean,
): Promise<void> {
  const ref = attempt.issueRef;
  const project = config.projects[projectKeyOf(ref)];
  if (!project) return;

  if (dryRun) {
    console.log(`[dry-run] would resume crashed delivery attempt ${attempt.id} for ${ref}`);
    return;
  }

  const cloneDir = path.join(cloneRootOf(config), projectKeyOf(ref));
  try {
    if (attempt.prNumber === null) {
      await finishAttempt(config, token, attempt.id, { outcome: "merge_failed" });
      await postComment(config, token, ref, crashedAttemptComment(ref, null)).catch((e: Error) =>
        console.error(`could not comment the crash on ${ref}: ${e.message}`),
      );
      await postDeliveryEvent(config, token, ref, {
        type: "delivery_failed",
        message: "crashed mid-attempt with no PR pinned",
      }).catch((e: Error) =>
        console.error(`could not record delivery_failed event on ${ref}: ${e.message}`),
      );
      return;
    }

    const live = await prLiveState(project.repo, attempt.prNumber);
    if (resumeActionFor(live.state) === "finish-delivery") {
      console.log(`${ref}: resuming crashed attempt ${attempt.id} — PR #${attempt.prNumber} is MERGED`);
      const outcome = await runDeliveryTail(
        ref,
        project,
        config,
        token,
        cloneDir,
        attempt.prNumber,
        live.mergeCommit ?? attempt.headSha ?? "unknown",
        null,
      );
      await finishAttempt(config, token, attempt.id, { outcome });
    } else {
      await finishAttempt(config, token, attempt.id, { outcome: "merge_failed" });
      await postComment(config, token, ref, crashedAttemptComment(ref, attempt.prNumber)).catch(
        (e: Error) => console.error(`could not comment the crash on ${ref}: ${e.message}`),
      );
      await postDeliveryEvent(config, token, ref, {
        type: "delivery_failed",
        message: `crashed mid-attempt; PR #${attempt.prNumber} is live ${live.state} — the merge never landed`,
      }).catch((e: Error) =>
        console.error(`could not record delivery_failed event on ${ref}: ${e.message}`),
      );
    }
  } catch (err) {
    console.error(
      `could not resume crashed attempt ${attempt.id} for ${ref}: ${(err as Error).message}`,
    );
  }
}

/**
 * Runs a deploy-only retry (SYD-208): the merge already landed but a prior
 * attempt's deploy step failed. Deploy tail only — NEVER any rebase/merge
 * machinery. The merge SHA comes from the PR's live merge commit.
 */
async function runDeployRetry(
  retry: WorkDeployRetry,
  config: WorkerConfig,
  token: string,
  dryRun: boolean,
): Promise<void> {
  const ref = retry.ref;
  const project = config.projects[projectKeyOf(ref)];
  if (!project) return;

  if (dryRun) {
    console.log(`[dry-run] would run deploy retry ${retry.retryNumber} for ${ref}`);
    return;
  }

  const cloneDir = path.join(cloneRootOf(config), projectKeyOf(ref));
  let attemptId: number | null = null;
  try {
    const started = await startAttempt(config, token, ref, {
      authorizationId: retry.authorizationId,
      prNumber: retry.prNumber ?? undefined,
      headSha: retry.headSha ?? undefined,
      deployRetry: true,
    });
    attemptId = started.id;
    const live = retry.prNumber !== null ? await prLiveState(project.repo, retry.prNumber) : null;
    const mergeSha = live?.mergeCommit ?? retry.headSha ?? "unknown";
    const outcome = await runDeliveryTail(
      ref,
      project,
      config,
      token,
      cloneDir,
      retry.prNumber ?? 0,
      mergeSha,
      null,
    );
    const id = attemptId;
    attemptId = null;
    await finishAttempt(config, token, id, { outcome });
  } catch (err) {
    const message = (err as Error).message;
    console.error(`deploy retry failed for ${ref}: ${message}`);
    // The merge already landed for a deploy retry, so a failure here is a
    // deploy problem, never merge_failed.
    if (attemptId !== null) {
      await finishAttempt(config, token, attemptId, { outcome: "merged_deploy_failed" }).catch(
        (e: Error) => console.error(`could not finish deploy retry for ${ref}: ${e.message}`),
      );
    }
  }
}

async function tick(
  config: WorkerConfig,
  token: string,
  gate: ReturnType<typeof newTickGate>,
  dryRun: boolean,
): Promise<void> {
  await runGated(gate, async () => {
    const url = `${apiBase(config)}/api/delivery-work`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`GET /api/delivery-work failed: ${res.status} ${await res.text()}`);
    const work = filterWorkToProjects(
      (await res.json()) as DeliveryWork,
      Object.keys(config.projects),
    );

    // Crash resumption first: reconcile any attempt a prior crash left open
    // against live GitHub before starting anything new. Sequential on purpose
    // (like the loops below): deliveries deploy; two at once would race the clone.
    for (const attempt of work.unfinished) {
      await resumeAttempt(attempt, config, token, dryRun);
    }
    for (const auth of work.pending) {
      await deliverPending(auth, config, token, dryRun);
    }
    for (const retry of work.deployRetries) {
      await runDeployRetry(retry, config, token, dryRun);
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

  // Dry runs are non-mutating (never start/finish an attempt, merge, deploy,
  // or comment), so they're safe to overlap with a live worker or each other —
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

export { tick };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
