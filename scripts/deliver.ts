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
  type WorkerConfig,
  type WorkerProject,
} from "./worker-select.js";
import {
  deliveryComment,
  deliveryFailureComment,
  crashedAttemptComment,
  shouldRetryQueueRebase,
  MAX_QUEUE_MERGE_ATTEMPTS,
  queueRebaseConflictComment,
  queueDeliveredNote,
  checksFailedComment,
  checksTimeoutComment,
  shaChainDisarmedComment,
  filterWorkToProjects,
  resumeActionFor,
  agentBranch,
  resolveInfraToken,
  shouldRefuseUnprotectedMain,
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
  runDeploy,
  attemptAutoRebase,
  pollUntilMergeable,
  waitForChecks,
  checkBranchProtection,
  originOwnerRepo,
  prFreshness,
  prLiveState,
} from "./delivery-exec.js";
import { acquirePidLock } from "./pidfile.js";

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

/** Persists the post-rebase head S1 onto the OPEN attempt right after the
 * force-push (SYD-209), so a crash before the merge re-anchors on S1 instead
 * of disarming. Does not finish the attempt. */
async function recordDerivedHead(
  config: WorkerConfig,
  token: string,
  attemptId: number,
  derivedHeadSha: string,
): Promise<void> {
  const url = `${apiBase(config)}/api/delivery-attempts/${attemptId}/derived-head`;
  await sendWithRetry(url, token, "PATCH", `PATCH derived-head ${attemptId}`, { derivedHeadSha });
}

/**
 * Shared delivery tail (SYD-164): deploys from a clean clone, then comments
 * and records the `delivered` event. Used by the merge orchestrator, crash
 * resumption, and deploy retries once each has a merge SHA in hand, so the
 * deploy/comment behavior can't drift between them. `note`, if given, is
 * prepended to the delivered comment to say how the merge was reached.
 *
 * The old post-merge verify backstop (a second clean-clone typecheck/build/
 * test after the merge) is gone under SYD-209: CI is the sole check authority
 * and already gated the merge on green checks for the exact merged head, so
 * re-running the suite here is pure duplication.
 *
 * Returns `"merged_deploy_failed"` when the deploy step fails (the merge
 * already landed — the deploy-retry query owns it), else `"merged_deployed"`.
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
 * SYD-209 merge orchestrator (the sole OPEN-PR delivery path; the legacy
 * merge-first flow + SYD-100 conflict-resolution dispatch were retired). For
 * one open agent PR:
 *   1. Rebase agent/<ref> onto origin/main and force-push → S1, after
 *      asserting the fetched remote head is one the worker authorized (S0, the
 *      human-stamped head, on the first pass; a prior S1 on a retry or crash
 *      resume). A third-party push breaks the chain → disarm.
 *   2. Persist S1 on the attempt row (so a crash before the merge re-anchors).
 *   3. Wait for GitHub's required checks to conclude on S1 and read the verdict
 *      LIVE — CI is the sole check authority; there is no client-side verify.
 *   4. Merge with the head pinned (gh pr merge --match-head-commit S1).
 * A rebase conflict, a broken chain, a red check, or a check timeout bounces
 * the ref (comment + delivery_failed, main untouched). The bounded main-moved
 * retry re-runs the whole cycle against the newer main.
 *
 * `acceptedHeads` seeds the SHA-chain anchor: [S0] for a fresh delivery,
 * [S0, S1] on crash resumption so the worker recognizes its own prior rebase.
 * Returns the attempt outcome (and the rebased head S1 whenever one was
 * produced, so the caller records derivedHeadSha even on a bounce).
 */
export async function deliverQueue(
  ref: string,
  project: WorkerProject,
  config: WorkerConfig,
  token: string,
  cloneDir: string,
  prNumber: number,
  acceptedHeads: string[],
  attemptId: number,
): Promise<DeliverOutcome> {
  let accepted = acceptedHeads;
  for (let attempt = 1; ; attempt++) {
    const rebase = await attemptAutoRebase(project.repo, cloneDir, ref, accepted);
    if (rebase.status === "no-branch") {
      throw new Error(`no ${agentBranch(ref)} branch found to rebase for PR #${prNumber}`);
    }
    if (rebase.status === "head-moved") {
      console.log(
        `${ref}: SHA chain broken — branch head ${rebase.observed} is not an authorized head`,
      );
      await postComment(config, token, ref, shaChainDisarmedComment(ref, accepted[0], rebase.observed));
      await postDeliveryEvent(config, token, ref, {
        type: "delivery_failed",
        message: `a commit landed on ${agentBranch(ref)} after the delivery was authorized — disarmed`,
      }).catch((e: Error) =>
        console.error(`could not record delivery_failed event on ${ref}: ${e.message}`),
      );
      return { outcome: "sha_chain_disarmed" };
    }
    if (rebase.status === "conflict") {
      console.log(`${ref}: rebase hit conflicts in ${rebase.files.join(", ") || "(unknown files)"}`);
      await postComment(config, token, ref, queueRebaseConflictComment(ref, rebase.files));
      await postDeliveryEvent(config, token, ref, {
        type: "delivery_failed",
        message: `rebase onto main hit real conflicts`,
      }).catch((e: Error) =>
        console.error(`could not record delivery_failed event on ${ref}: ${e.message}`),
      );
      return { outcome: "conflict_bounced" };
    }

    // Rebased cleanly → S1. Persist it before the wait so a crash re-anchors
    // on our own rebase instead of disarming, and accept it as our own head on
    // any subsequent retry.
    const s1 = rebase.sha;
    accepted = [s1];
    console.log(
      `${ref}: rebased onto main at ${s1} (attempt ${attempt}/${MAX_QUEUE_MERGE_ATTEMPTS})`,
    );
    await recordDerivedHead(config, token, attemptId, s1).catch((e: Error) =>
      console.error(`could not persist derived head for ${ref}: ${e.message}`),
    );

    // CI is the check authority: wait for the required checks to conclude on
    // S1, read the verdict live.
    const checks = await waitForChecks(project.repo, prNumber, s1);
    console.log(`${ref}: required checks on ${s1} → ${checks}`);
    if (checks === "head-moved") {
      const live = await prLiveState(project.repo, prNumber).catch(() => null);
      await postComment(
        config,
        token,
        ref,
        shaChainDisarmedComment(ref, s1, live?.headRefOid ?? "unknown"),
      );
      await postDeliveryEvent(config, token, ref, {
        type: "delivery_failed",
        message: `a commit landed on ${agentBranch(ref)} after its checks started — disarmed`,
      }).catch((e: Error) =>
        console.error(`could not record delivery_failed event on ${ref}: ${e.message}`),
      );
      return { outcome: "sha_chain_disarmed", derivedHeadSha: s1 };
    }
    if (checks === "failing") {
      await postComment(config, token, ref, checksFailedComment(ref));
      await postDeliveryEvent(config, token, ref, {
        type: "delivery_failed",
        message: `required GitHub checks failed on the rebased head ${s1}`,
      }).catch((e: Error) =>
        console.error(`could not record delivery_failed event on ${ref}: ${e.message}`),
      );
      return { outcome: "verify_failed", derivedHeadSha: s1 };
    }
    if (checks === "pending") {
      // shouldKeepWaitingForChecks returned false while still pending → the
      // wait budget elapsed.
      await postComment(config, token, ref, checksTimeoutComment(ref));
      await postDeliveryEvent(config, token, ref, {
        type: "delivery_failed",
        message: `required GitHub checks did not conclude within the wait window on ${s1}`,
      }).catch((e: Error) =>
        console.error(`could not record delivery_failed event on ${ref}: ${e.message}`),
      );
      return { outcome: "checks_timeout", derivedHeadSha: s1 };
    }

    // checks === "passing": CI is green live on S1. Merge with the head pinned
    // so a push in this window can't slot in (gh refuses; the merge throws and
    // the retry re-anchors).
    const mergeable = await pollUntilMergeable(project.repo, prNumber);
    console.log(`${ref}: pre-merge mergeability=${mergeable}`);
    let mergeSha: string;
    try {
      mergeSha = await mergeAgentPr(project.repo, prNumber, s1);
    } catch (mergeErr) {
      if (!shouldRetryQueueRebase(attempt)) throw mergeErr;
      console.log(
        `${ref}: merge failed after green-on-${s1} (${(mergeErr as Error).message}) — main moved, re-rebasing`,
      );
      continue;
    }
    // Outside the retry catch (SYD-174): main already has the commit, so a
    // finishDelivery failure is a post-merge problem, not a lost merge — never
    // re-rebase it and never call it merge_failed. runDeliveryTail maps any
    // post-merge failure to merged_deploy_failed, which the deploy-retry query
    // owns.
    console.log(`${ref}: merged PR #${prNumber} at ${mergeSha}`);
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
    return { outcome, derivedHeadSha: s1 };
  }
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

    // OPEN → the SHA-chain merge orchestrator. S0 (the head the human
    // authorized at stamp time) anchors the chain; without it we can't tell
    // whether the branch was pushed after the stamp, so we disarm rather than
    // merge an unanchored head.
    if (!auth.pin.headSha) {
      const id = attemptId;
      attemptId = null;
      await finishAttempt(config, token, id, { outcome: "sha_chain_disarmed" });
      const message = `no authorized head was pinned for PR #${auth.pin.prNumber} — cannot anchor the SHA chain`;
      await postComment(
        config,
        token,
        ref,
        shaChainDisarmedComment(ref, "(none recorded)", live.headRefOid),
      ).catch((e: Error) => console.error(`could not comment the disarm on ${ref}: ${e.message}`));
      await postDeliveryEvent(config, token, ref, { type: "delivery_failed", message }).catch(
        (e: Error) => console.error(`could not record delivery_failed event on ${ref}: ${e.message}`),
      );
      return;
    }

    // Keep attemptId live across the orchestrator so a thrown pre-merge failure
    // (no branch, merge-retry exhausted) is still stamped merge_failed by the
    // outer catch; the orchestrator persists S1 to this same attempt id.
    // SYD-231: anchor the SHA chain on S0 (the human-stamped head) AND every
    // rebased head the worker itself force-pushed on prior attempts for this PR.
    // A prior bounced attempt can leave the branch at its own S1; without this,
    // a re-stamp (still pinned to S0) would see that head as "moved" and disarm
    // instead of re-rebasing it. Only the worker's own recorded outputs are
    // trusted here, so a genuine third-party push still breaks the chain.
    const acceptedHeads = [...new Set([auth.pin.headSha, ...(auth.priorHeads ?? [])])];
    const result = await deliverQueue(
      ref,
      project,
      config,
      token,
      cloneDir,
      auth.pin.prNumber,
      acceptedHeads,
      attemptId,
    );
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

    let isMerged = false;
    if (auth.pin !== null) {
      try {
        const live = await prLiveState(project.repo, auth.pin.prNumber);
        if (live.state === "MERGED") {
          isMerged = true;
        }
      } catch (liveErr) {
        console.error(
          `could not fetch live PR state in outer catch for ${ref}: ${(liveErr as Error).message}`,
        );
      }
    }

    if (isMerged) {
      console.log(
        `${ref}: delivery failed but live PR #${auth.pin?.prNumber} is MERGED. ` +
          `Treating as a post-merge/finalization failure; skipping spurious delivery_failed comment/event. ` +
          `Attempt will be left unfinished for resumeAttempt.`,
      );
    } else {
      await postComment(config, token, ref, deliveryFailureComment(ref, message)).catch((e: Error) =>
        console.error(`could not comment the failure on ${ref}: ${e.message}`),
      );
      await postDeliveryEvent(config, token, ref, { type: "delivery_failed", message }).catch(
        (e: Error) =>
          console.error(`could not record delivery_failed event on ${ref}: ${e.message}`),
      );
    }
  }
}

/**
 * Resumes an attempt a prior crash left unfinished (SYD-208/209). Consults the
 * PR's LIVE GitHub state — never pr_state or the tracker — because only GitHub
 * knows whether the merge landed:
 *   - MERGED → run the deploy tail and finish it (never re-merge).
 *   - OPEN → re-anchor on the heads the worker authorized (S0, and the S1 it
 *     may have force-pushed before crashing) and re-drive the orchestrator,
 *     rather than disarming after every mid-attempt crash. A third-party push
 *     while the worker was down fails the anchor inside the orchestrator →
 *     sha_chain_disarmed. With no authorized head to re-anchor on, it fails
 *     merge_failed for a human to re-authorize.
 *   - CLOSED / no PR pinned → the merge never landed and won't; merge_failed +
 *     crash comment/event.
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
    } else if (live.state === "OPEN") {
      // Re-anchor on our own authorized heads (S0 = the stamped head, S1 = a
      // rebase we force-pushed before crashing) and re-drive the orchestrator.
      const accepted = [attempt.headSha, attempt.derivedHeadSha].filter(
        (h): h is string => typeof h === "string" && h.length > 0,
      );
      if (accepted.length === 0) {
        await finishAttempt(config, token, attempt.id, { outcome: "merge_failed" });
        await postComment(config, token, ref, crashedAttemptComment(ref, attempt.prNumber)).catch(
          (e: Error) => console.error(`could not comment the crash on ${ref}: ${e.message}`),
        );
        await postDeliveryEvent(config, token, ref, {
          type: "delivery_failed",
          message: `crashed mid-attempt; PR #${attempt.prNumber} is OPEN but no authorized head was recorded to re-anchor on`,
        }).catch((e: Error) =>
          console.error(`could not record delivery_failed event on ${ref}: ${e.message}`),
        );
        return;
      }
      console.log(
        `${ref}: resuming crashed attempt ${attempt.id} — re-anchoring PR #${attempt.prNumber} on ${accepted.join(", ")}`,
      );
      try {
        const result = await deliverQueue(
          ref,
          project,
          config,
          token,
          cloneDir,
          attempt.prNumber,
          accepted,
          attempt.id,
        );
        await finishAttempt(config, token, attempt.id, {
          outcome: result.outcome,
          derivedHeadSha: result.derivedHeadSha,
        });
      } catch (driveErr) {
        // no-branch / merge-retry exhausted — a genuine pre-merge failure.
        await finishAttempt(config, token, attempt.id, { outcome: "merge_failed" }).catch(
          (e: Error) => console.error(`could not finish resumed attempt for ${ref}: ${e.message}`),
        );
        const message = `crashed mid-attempt; re-drive of PR #${attempt.prNumber} failed: ${(driveErr as Error).message}`;
        await postComment(config, token, ref, deliveryFailureComment(ref, message)).catch(
          (e: Error) => console.error(`could not comment the failure on ${ref}: ${e.message}`),
        );
        await postDeliveryEvent(config, token, ref, { type: "delivery_failed", message }).catch(
          (e: Error) =>
            console.error(`could not record delivery_failed event on ${ref}: ${e.message}`),
        );
      }
    } else {
      // CLOSED unmerged — the merge never landed and won't.
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

/**
 * Startup/periodic health check (SYD-209): reads each linked repo's `main`
 * branch protection live and logs a loud warning if it's relaxed (no required
 * checks, an empty required-checks list, or admins allowed to bypass). CI is
 * the sole check authority, so an unprotected main would let the delivery
 * worker merge unverified code — this surfaces that off-box misconfiguration
 * instead of trusting it. Read-only and always best-effort here: it never
 * blocks delivery by itself.
 *
 * Returns the keys of every project that failed (or couldn't verify) the
 * check, so the caller can optionally turn this from a warning into a hard
 * startup gate via `delivery.requireBranchProtection` (SYD-222) — a repo
 * whose check errored (e.g. no `origin` remote) is treated the same as a
 * failing one: unverifiable protection is not verified protection.
 */
export async function warnOnRelaxedBranchProtection(config: WorkerConfig): Promise<string[]> {
  const failing: string[] = [];
  for (const [key, proj] of Object.entries(config.projects)) {
    try {
      const health = await checkBranchProtection(proj.repo);
      if (!health.ok) {
        failing.push(key);
        console.error(
          `WARNING: ${key}'s repo has relaxed branch protection on main — CI is the sole check ` +
            `authority (SYD-209), so delivery merges are unguarded until this is fixed:\n  - ` +
            health.problems.join("\n  - "),
        );
      }
    } catch (err) {
      failing.push(key);
      console.error(`could not check branch protection for ${key}: ${(err as Error).message}`);
    }
  }
  return failing;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const once = args.includes("--once");
  const dryRun = args.includes("--dry-run");

  loadDotEnv();
  const token = resolveInfraToken();
  if (!token) {
    console.error(
      "SWITCHYARD_SERVICE_TOKEN (preferred) or SWITCHYARD_TOKEN is required (set it in the environment or the repo .env)",
    );
    process.exit(1);
  }
  const config = loadConfig();
  const gate = newTickGate();

  // SYD-209 branch-protection health check: CI is now the sole check authority,
  // so the merge's safety rests on GitHub actually requiring those checks on
  // main. Warn loudly at startup if any linked repo's protection is relaxed —
  // an operator alarm, never a silent downgrade. Best-effort and read-only, so
  // it runs in dry-run too and never blocks the tick loop by itself.
  const unprotected = await warnOnRelaxedBranchProtection(config);

  // SYD-222: an operator can opt a repo into refusing to start at all, rather
  // than merging with the warning alarm as the only signal.
  if (shouldRefuseUnprotectedMain(config.delivery?.requireBranchProtection, unprotected)) {
    console.error(
      `refusing to start: delivery.requireBranchProtection is set and main's branch protection ` +
        `could not be verified as safe for: ${unprotected.join(", ")}`,
    );
    process.exit(1);
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
