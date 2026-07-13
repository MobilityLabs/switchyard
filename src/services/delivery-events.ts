// Structured delivery-status events (SYD-54): deliver.ts and the auto-dispatch
// worker already know the moments that matter for the stamp-to-merge loop —
// PR opened, delivered (merged + deployed), or delivery failed. Recording
// these as typed events (not just prose comments) lets the issue UI render a
// delivery strip by scanning the activity feed instead of parsing text.

import type { Db } from "../db/index.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { getIssue } from "./issues.js";
import { recordEvent } from "./events.js";
import { boundRepoFullNames } from "./github-repos.js";
import { parseGhTimestamp } from "./github-webhook.js";
import { upsertPrState, attributedRef } from "./pr-state.js";

export type DeployResult = { ran: false } | { ran: true; ok: boolean; tail: string };

// `repo` (and pr_opened's headSha/ghUpdatedAt, sourced by the worker from
// `gh pr view --json headRefOid,updatedAt`) are optional until the worker
// host go-live — the SYD-205 deploy-skew rule.
export type DeliveryEventInput =
  | {
      type: "pr_opened";
      prNumber: number;
      url: string;
      repo?: string;
      headSha?: string;
      ghUpdatedAt?: string;
    }
  | {
      type: "delivered";
      prNumber: number;
      mergeSha: string;
      deploy: DeployResult;
      repo?: string;
      headSha?: string;
      ghUpdatedAt?: string;
    }
  | { type: "delivery_failed"; message: string; repo?: string };

export function recordDeliveryEvent(
  db: Db,
  actor: Actor,
  ref: string,
  input: DeliveryEventInput,
): void {
  // SYD-108: these events are load-bearing — getOpenPr treats `delivered`
  // after `pr_opened` as "PR closed out" (clearing the SYD-99 claim gate) and
  // getAttention treats it as clearing a delivery_failed. An agent that could
  // post them could unblock its own issue or hide a failed delivery. The
  // legit posters (deliver.ts, agent-worker.ts) authenticate with the
  // worker's human-typed infra token (same identity rule as /github-events,
  // SYD-107); dispatched agents' own tokens are refused here.
  if (actor.type === "agent") {
    throw new SwitchyardError(
      "Only the delivery infrastructure (a human-typed token) may record delivery events — agents cannot post delivery status.",
    );
  }
  const issue = getIssue(db, ref);
  const { type, ...rest } = input;
  let repo = input.repo ?? null;
  if (repo === null) {
    // SYD-205 deploy-skew rule: infer only when it's unambiguous.
    const bound = boundRepoFullNames(db, issue.projectId);
    if (bound.length === 1) repo = bound[0];
    else if (bound.length > 1) {
      throw new SwitchyardError(
        "repo is ambiguous — the issue's project has multiple bound repos, so this delivery event must name its repo.",
      );
    }
  }
  const payload: Record<string, unknown> = { ...rest, repo };
  if (input.type === "pr_opened") {
    payload.headSha = input.headSha ?? null;
    payload.ghUpdatedAt = parseGhTimestamp(input.ghUpdatedAt);
  } else if (input.type === "delivered" && input.ghUpdatedAt !== undefined) {
    payload.ghUpdatedAt = parseGhTimestamp(input.ghUpdatedAt);
  }
  recordEvent(db, { issueId: issue.id, actorId: actor.id, type, payload });

  // SYD-206: the publish and the merge are two of pr_state's four writers —
  // this is what closes the claim gate at publish time even on poll-only
  // repos (no freshness window), and keeps board state from waiting on
  // webhook/poll lag after a merge. Attribution is still repo-bound: a repo
  // that isn't bound to this issue's project never writes its claim-gating
  // state, exactly as in webhook ingestion.
  if (repo !== null && (input.type === "pr_opened" || input.type === "delivered")) {
    const branch = `agent/${issue.ref}`;
    if (attributedRef(db, repo, branch) === issue.ref) {
      upsertPrState(db, actor, {
        repo,
        prNumber: input.prNumber,
        status: input.type === "pr_opened" ? "open" : "merged",
        branch,
        url: input.type === "pr_opened" ? input.url : undefined,
        headSha: input.headSha ?? null,
        ghUpdatedAt: input.ghUpdatedAt ?? null,
        mergeSha: input.type === "delivered" ? input.mergeSha : undefined,
      });
    }
  }
}
