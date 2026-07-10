// Pure logic for the delivery gate (SYD-49): selecting human done-stamps off
// the event feed, building the git/gh argv for publishing and merging
// agent/<ref> PRs, and formatting the comments deliver.ts posts back. I/O-free
// so it's trivially unit-testable; the exec side lives in delivery-exec.ts.

import { projectKeyOf } from "./worker-select.js";

/** The subset of a GET /api/events row the delivery worker needs. */
export type DeliveryFeedEvent = {
  id: number;
  type: string;
  issue: string; // "<PROJECT>-<number>"
  payload: Record<string, unknown>;
};

export const MAIN_BRANCH = "main";

export function agentBranch(ref: string): string {
  return `agent/${ref}`;
}

/**
 * Scans the global event feed for done-stamps (status_changed → done) newer
 * than `lastEventId` on configured projects. Only human actors can move an
 * issue to done (server-enforced), so every match is a human approval — the
 * delivery gate's trigger. Same cursor semantics as findResumeRefs: a null
 * cursor initializes to the newest event id without firing on history, so a
 * fresh deliver.ts never replays old approvals.
 */
export function findDeliverableRefs(
  feed: DeliveryFeedEvent[],
  projectKeys: Iterable<string>,
  lastEventId: number | null
): { refs: string[]; lastEventId: number | null } {
  if (feed.length === 0) return { refs: [], lastEventId };
  const keys = new Set(projectKeys);
  const newestId = Math.max(...feed.map((e) => e.id));
  if (lastEventId === null) return { refs: [], lastEventId: newestId };

  const refs = new Set<string>();
  for (const e of feed) {
    if (e.id <= lastEventId) continue;
    if (e.type !== "status_changed") continue;
    if (e.payload?.to !== "done") continue;
    if (!keys.has(projectKeyOf(e.issue))) continue;
    refs.add(e.issue);
  }
  return { refs: [...refs], lastEventId: Math.max(newestId, lastEventId) };
}

/**
 * Detects a gap between the persisted cursor and the oldest event the feed
 * window still contains: events in (lastEventId, oldest) are gone from the
 * window and any done-stamps among them will never fire. Returns the missed
 * id range, or null when the window still overlaps the cursor (or there is
 * nothing to compare).
 */
export function feedGap(
  feed: DeliveryFeedEvent[],
  lastEventId: number | null
): { from: number; to: number } | null {
  if (lastEventId === null || feed.length === 0) return null;
  const oldest = Math.min(...feed.map((e) => e.id));
  return oldest > lastEventId + 1 ? { from: lastEventId + 1, to: oldest - 1 } : null;
}

export function buildPrTitle(ref: string, issueTitle: string): string {
  return `${ref}: ${issueTitle}`;
}

export function buildPrBody(ref: string, serverUrl: string): string {
  return [
    `Agent work for Switchyard issue **${ref}**.`,
    "",
    `Issue: ${serverUrl.replace(/\/$/, "")}/issue/${ref}`,
    "",
    "Merged automatically by scripts/deliver.ts when a human moves the issue to done.",
  ].join("\n");
}

// argv builders are pure so tests can assert exact argument vectors; every
// caller passes them to execFile (never a shell), so issue-title content can
// never be interpreted.

// Every gh invocation carries -R <owner>/<repo> and runs from a neutral,
// non-repo cwd (never project.repo, the human's live checkout) — see
// delivery-exec.ts. -R makes gh operate purely against the GitHub API, so a
// human's in-progress checkout of agent/<ref> is never switched or deleted.

export function buildPushArgs(ref: string): string[] {
  return ["push", "origin", agentBranch(ref)];
}

export function buildPrListArgs(ref: string, ownerRepo: string): string[] {
  return ["pr", "list", "-R", ownerRepo, "--head", agentBranch(ref), "--state", "open", "--json", "number"];
}

export function buildPrCreateArgs(ref: string, issueTitle: string, serverUrl: string, ownerRepo: string): string[] {
  return [
    "pr", "create",
    "-R", ownerRepo,
    "--base", MAIN_BRANCH,
    "--head", agentBranch(ref),
    "--title", buildPrTitle(ref, issueTitle),
    "--body", buildPrBody(ref, serverUrl),
  ];
}

export function buildPrMergeArgs(prNumber: number, ownerRepo: string): string[] {
  return ["pr", "merge", String(prNumber), "-R", ownerRepo, "--merge", "--delete-branch"];
}

export function buildPrViewMergeShaArgs(prNumber: number, ownerRepo: string): string[] {
  return ["pr", "view", String(prNumber), "-R", ownerRepo, "--json", "mergeCommit", "--jq", ".mergeCommit.oid"];
}

/** Extracts "owner/repo" from a git remote URL — https, ssh, or scp-like, with or without a .git suffix. */
export function parseOwnerRepo(remoteUrl: string): string {
  const trimmed = remoteUrl.trim().replace(/\.git$/, "");
  const sshMatch = trimmed.match(/^[\w.-]+@[^:/]+[:/](.+)$/);
  if (sshMatch) return sshMatch[1];
  const httpMatch = trimmed.match(/^https?:\/\/[^/]+\/(.+)$/);
  if (httpMatch) return httpMatch[1];
  throw new Error(`cannot parse owner/repo from git remote url: ${remoteUrl}`);
}

export function buildPrViewUrlArgs(prNumber: number, ownerRepo: string): string[] {
  return ["pr", "view", String(prNumber), "--json", "url", "--jq", ".url", "-R", ownerRepo];
}

/** Outcome of a publishAgentBranch call (delivery-exec.ts) — pure so the log-line
 * formatting and the decision to emit a pr_opened event are both testable. */
export type PublishOutcome =
  | { status: "no-branch" }
  | { status: "no-commits" }
  | { status: "already-open"; prNumber: number; url: string }
  | { status: "opened"; prNumber: number | null; url: string };

export function formatPublishOutcome(branch: string, outcome: PublishOutcome): string {
  switch (outcome.status) {
    case "no-branch":
      return `no ${branch} branch — nothing to publish`;
    case "no-commits":
      return `${branch} has no commits ahead of ${MAIN_BRANCH} — nothing to publish`;
    case "already-open":
      return `pushed ${branch}; PR #${outcome.prNumber} already open`;
    case "opened":
      return `opened PR for ${branch}: ${outcome.url}`;
  }
}

/** `gh pr create` prints the created PR's URL on stdout — pull the number out
 * of it so callers don't need a second `gh` round-trip just to get the id. */
export function parsePrNumberFromUrl(url: string): number | null {
  const m = /\/pull\/(\d+)/.exec(url);
  return m ? Number(m[1]) : null;
}

/** The subset of a structured delivery event the server records (SYD-54),
 * posted to POST /issues/:ref/delivery-events by deliver.ts and the worker. */
export type DeliveryEventInput =
  | { type: "pr_opened"; prNumber: number; url: string }
  | { type: "delivered"; prNumber: number; mergeSha: string; deploy: DeliveryResult["deploy"] }
  | { type: "delivery_failed"; message: string };

export type DeliveryResult = {
  prNumber: number;
  mergeSha: string;
  deploy: { ran: false } | { ran: true; ok: boolean; tail: string };
};

export function deliveryComment(r: DeliveryResult): string {
  const lines = [`Delivered: merged PR #${r.prNumber} at \`${r.mergeSha}\`.`];
  if (!r.deploy.ran) {
    lines.push("Deploy: skipped (no deploy script in the merged project).");
  } else if (r.deploy.ok) {
    lines.push("Deploy: succeeded.");
  } else {
    lines.push("Deploy: FAILED — output tail:", "```", r.deploy.tail, "```");
  }
  return lines.join("\n");
}

/** Posted when the post-merge verification gate (SYD-78) fails: the PR merged
 * cleanly but merged main no longer typechecks/passes tests, so deploy was
 * skipped. Distinct from deliveryFailureComment, which covers merge-time
 * failures (the PR never landed) — here the merge already happened. */
export function verificationFailureComment(prNumber: number, mergeSha: string, tail: string): string {
  return [
    `Merged PR #${prNumber} at \`${mergeSha}\`, but post-merge verification FAILED — deploy skipped.`,
    "main is red; do not build on it until this is fixed. Output tail:",
    "```",
    tail,
    "```",
  ].join("\n");
}

export function deliveryFailureComment(ref: string, message: string): string {
  return (
    `Delivery FAILED for ${ref}: ${message}\n` +
    `The agent PR was not delivered — check scripts/deliver.ts logs, resolve, ` +
    `and re-stamp the issue done (or merge manually).`
  );
}

/** Contents of .superpowers/deliver-cursor — the last processed event id. */
export function parseCursorText(text: string): number | null {
  const n = Number(text.trim());
  return Number.isInteger(n) && n >= 0 && text.trim() !== "" ? n : null;
}

/** Last `maxLines` lines of subprocess output, capped at `maxChars`. */
export function tailOf(text: string, maxLines = 20, maxChars = 2000): string {
  const tail = text.trimEnd().split("\n").slice(-maxLines).join("\n");
  return tail.length > maxChars ? tail.slice(-maxChars) : tail;
}
