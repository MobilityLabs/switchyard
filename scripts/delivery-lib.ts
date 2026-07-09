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

export function buildPushArgs(ref: string): string[] {
  return ["push", "origin", agentBranch(ref)];
}

export function buildPrListArgs(ref: string): string[] {
  return ["pr", "list", "--head", agentBranch(ref), "--state", "open", "--json", "number"];
}

export function buildPrCreateArgs(ref: string, issueTitle: string, serverUrl: string): string[] {
  return [
    "pr", "create",
    "--base", MAIN_BRANCH,
    "--head", agentBranch(ref),
    "--title", buildPrTitle(ref, issueTitle),
    "--body", buildPrBody(ref, serverUrl),
  ];
}

export function buildPrMergeArgs(prNumber: number): string[] {
  return ["pr", "merge", String(prNumber), "--merge", "--delete-branch"];
}

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
