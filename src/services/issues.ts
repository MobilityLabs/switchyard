import { and, eq, sql } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import type { Db, DbOrTx } from "../db/index.js";
import {
  issues,
  projects,
  actors as actorsTable,
  STATUSES,
  PRIORITIES,
  type Status,
  type Priority,
} from "../db/schema.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { getProjectByKey, reserveIssueNumber } from "./projects.js";
import { recordEvent } from "./events.js";
import { getOpenBlockers } from "./dependencies.js";
import { getOpenPr } from "./pr-status.js";
import { getSetting } from "./settings.js";
import { mintLease, validateLease, invalidateLease, getActiveLease } from "./leases.js";

export type Provenance = {
  sourceType: "session" | "todo" | "ci" | "manual";
  detail?: string;
  url?: string;
};

/**
 * Status changes an agent may make on its own, keyed by the issue's current
 * status. Anything not listed — including any transition out of `triage` or
 * `done`, or into `done` — is human-only (SYD-124: previously only those
 * three special cases were gated, so e.g. an agent could push someone else's
 * `todo` straight to `in_review`, or reopen a `done` issue). `assigneeOnly`
 * transitions additionally require the actor to be the current assignee.
 */
const AGENT_STATUS_TRANSITIONS: Partial<Record<Status, { to: Status; assigneeOnly?: boolean }[]>> =
  {
    todo: [{ to: "in_progress" }], // assignee handling is claimIssue/assertClaimable's job
    in_progress: [
      { to: "in_review", assigneeOnly: true },
      { to: "todo", assigneeOnly: true }, // releasing your own claim
    ],
    in_review: [
      { to: "in_progress", assigneeOnly: true }, // reopening your own work after feedback
    ],
  };

export const SUMMARY_MAX_LENGTH = 280;

function checkSummaryLength(summary: string | null | undefined): void {
  if (summary != null && summary.length > SUMMARY_MAX_LENGTH) {
    throw new SwitchyardError(
      `Summary is ${summary.length} characters — summaries must be ${SUMMARY_MAX_LENGTH} or fewer. Keep it to one or two sentences; put the rest in the description.`,
    );
  }
}

export type CreateIssueInput = {
  projectKey: string;
  title: string;
  description?: string;
  summary?: string;
  priority?: Priority;
  labels?: string[];
  parentRef?: string;
  provenance?: Provenance;
  workerPreference?: string | null;
};

export type IssueView = typeof issues.$inferSelect & { ref: string };

export function parseRef(ref: string): { key: string; number: number } {
  const m = /^([A-Z]{2,10})-(\d+)$/.exec(ref);
  if (!m) {
    throw new SwitchyardError(
      `"${ref}" is not an issue ref — use the form <PROJECT_KEY>-<number>, like "AIPI-42".`,
    );
  }
  return { key: m[1], number: Number(m[2]) };
}

export function toView(db: DbOrTx, row: typeof issues.$inferSelect): IssueView {
  const project = db.select().from(projects).where(eq(projects.id, row.projectId)).get();
  if (!project) {
    throw new SwitchyardError(
      `Issue ${row.id} references a missing project (id ${row.projectId}).`,
    );
  }
  return { ...row, ref: `${project.key}-${row.number}` };
}

export function getIssue(db: DbOrTx, ref: string): IssueView {
  const { key, number } = parseRef(ref);
  const project = getProjectByKey(db, key);
  const row = db
    .select()
    .from(issues)
    .where(and(eq(issues.projectId, project.id), eq(issues.number, number)))
    .get();
  if (!row) {
    throw new SwitchyardError(
      `Issue ${ref} does not exist — call search_issues to find valid issues.`,
    );
  }
  return toView(db, row);
}

export function createIssue(db: Db, actor: Actor, input: CreateIssueInput): IssueView {
  if (actor.type === "agent" && !input.provenance) {
    throw new SwitchyardError(
      "Agent-created issues require provenance — pass sourceType " +
        '("session" | "todo" | "ci" | "manual") plus a detail (e.g. "src/api.ts:88" or a session id) or url.',
    );
  }
  if (actor.type === "agent" && !input.description?.trim()) {
    throw new SwitchyardError(
      "Agent-filed issues need a description a human can triage from — say what's wrong, why it matters, and what you suggest doing.",
    );
  }
  if (input.provenance?.url && !/^https?:\/\//.test(input.provenance.url)) {
    throw new SwitchyardError(`Provenance url must be http(s) — got "${input.provenance.url}".`);
  }
  checkSummaryLength(input.summary);
  return db.transaction((tx) => {
    const project = getProjectByKey(tx, input.projectKey);
    const number = reserveIssueNumber(tx, project.id);
    const parentId = input.parentRef ? getIssue(tx, input.parentRef).id : null;
    const row = tx
      .insert(issues)
      .values({
        projectId: project.id,
        number,
        title: input.title,
        description: input.description ?? "",
        summary: input.summary ?? null,
        status: actor.type === "agent" ? "triage" : "backlog",
        priority: input.priority ?? "none",
        labels: input.labels ?? [],
        creatorId: actor.id,
        parentId,
        sourceType: input.provenance?.sourceType ?? null,
        sourceDetail: input.provenance?.detail ?? null,
        sourceUrl: input.provenance?.url ?? null,
        workerPreference: input.workerPreference ?? null,
      })
      .returning()
      .get();
    recordEvent(tx, { issueId: row.id, actorId: actor.id, type: "created" });
    return toView(tx, row);
  });
}

export type UpdateIssueInput = {
  status?: Status;
  priority?: Priority;
  title?: string;
  description?: string;
  summary?: string | null;
  assigneeName?: string | null;
  labels?: string[];
  workerPreference?: string | null;
  /** SYD-208: required to stamp done over an issue with an open agent PR —
   * the head SHA the human reviewed, compared-and-set against pr_state's
   * current head. */
  expectedHeadSha?: string;
};

/**
 * Refuses to let `actor` claim an issue already spoken for (SYD-99): claimed
 * by a different actor, or sitting behind an open agent PR from a prior claim
 * (see getOpenPr — this also catches a stale claim that got released while
 * its PR is still unmerged). Reclaiming your own issue is always fine. This
 * is the gap that let SYD-93 get fixed twice in parallel (worker PR #41 vs a
 * coordinating session's PR #42, opened without ever calling claim_issue).
 */
function assertClaimable(db: DbOrTx, actor: Actor, current: IssueView): void {
  if (current.assigneeId === actor.id) return;
  if (current.assigneeId !== null) {
    const assignee = db
      .select()
      .from(actorsTable)
      .where(eq(actorsTable.id, current.assigneeId))
      .get();
    throw new SwitchyardError(
      `${current.ref} is already claimed by ${assignee?.name ?? "another actor"} — check with them before starting duplicate work, or call next_task for another issue.`,
    );
  }
  const openPr = getOpenPr(db, current.id);
  if (openPr) {
    throw new SwitchyardError(
      `${current.ref} already has an open PR (#${openPr.prNumber}: ${openPr.url}) from a prior claim — check it before starting duplicate work, or call next_task for another issue.`,
    );
  }
}

/** Used by assigneeOnly entries in AGENT_STATUS_TRANSITIONS. */
function assertAssignee(db: DbOrTx, actor: Actor, current: IssueView, toStatus: Status): void {
  if (current.assigneeId === actor.id) return;
  if (current.assigneeId === null) {
    throw new SwitchyardError(
      `${current.ref} isn't assigned to anyone — only the assignee can move it to "${toStatus}". Claim it first.`,
    );
  }
  const assignee = db
    .select()
    .from(actorsTable)
    .where(eq(actorsTable.id, current.assigneeId))
    .get();
  throw new SwitchyardError(
    `${current.ref} is assigned to ${assignee?.name ?? "another actor"} — only the assignee can move it to "${toStatus}".`,
  );
}

/**
 * How a caller passes the lease token in and receives a freshly minted one out
 * (SYD-210). `presented` is the token the holder supplies for validation;
 * `minted` is an out-container the function fills when this call establishes a
 * new claim — kept off the returned IssueView so the token is never serialized.
 */
export type LeaseChannel = { presented?: string; minted?: { token: string | null } };

export function updateIssue(
  db: Db,
  actor: Actor,
  ref: string,
  patch: UpdateIssueInput,
  lease: LeaseChannel = {},
): IssueView {
  checkSummaryLength(patch.summary);
  return db.transaction((tx) => {
    const current = getIssue(tx, ref);
    // SYD-210: an agent mutating an issue it already holds must present the
    // lease minted at claim time — this closes the shared-token double-work
    // hole (a second session of the same worker actor holds the shared bearer
    // token but not this lease). Humans are individuated by actor and are never
    // lease-gated. A fresh claim (assigneeId === null -> assigned, below) mints
    // instead of validating, so the two are disjoint.
    const isHolderMutation = actor.type === "agent" && current.assigneeId === actor.id;
    if (isHolderMutation) {
      validateLease(tx, current.id, actor.id, lease.presented);
    }
    const changes: SQLiteUpdateSetSource<typeof issues> = {};
    const toRecord: { type: string; payload: Record<string, unknown> }[] = [];

    if (patch.status !== undefined && patch.status !== current.status) {
      if (!STATUSES.includes(patch.status)) {
        throw new SwitchyardError(
          `"${patch.status}" is not a status — valid statuses are: ${STATUSES.join(", ")}.`,
        );
      }
      if (current.status === "triage" && actor.type === "agent") {
        throw new SwitchyardError(
          `${ref} is in triage — only humans move issues out of triage. Use triage_queue to help a human review it.`,
        );
      }
      if (patch.status === "done" && actor.type === "agent") {
        throw new SwitchyardError(
          "Only humans move issues to done — comment your verification evidence and move it to in_review instead.",
        );
      }
      if (actor.type === "agent") {
        if (current.status === "done") {
          throw new SwitchyardError(`${ref} is done — only humans reopen a done issue.`);
        }
        const allowed = AGENT_STATUS_TRANSITIONS[current.status]?.find(
          (t) => t.to === patch.status,
        );
        if (!allowed) {
          throw new SwitchyardError(
            `Agents can't move ${ref} from "${current.status}" to "${patch.status}" — that transition is human-only.`,
          );
        }
        if (allowed.assigneeOnly) {
          assertAssignee(tx, actor, current, patch.status);
        }
      }
      // SYD-208: stamping done on an issue with an open agent PR authorizes
      // delivery, so it is compare-and-set on the PR head — the client submits
      // the SHA it displayed, and a third-party push landing seconds before
      // the click is rejected instead of silently authorized. The validated
      // pin rides the status_changed payload; the delivery trigger reads it
      // from there.
      let donePin: { repo: string; prNumber: number; headSha: string } | null = null;
      if (patch.status === "done") {
        const open = getOpenPr(tx, current.id);
        if (open) {
          if (open.headSha === null) {
            throw new SwitchyardError(
              `${ref}'s open agent PR #${open.prNumber} has no recorded head SHA yet — wait for the poller/webhook to record one, then stamp again.`,
            );
          }
          if (patch.expectedHeadSha === undefined) {
            throw new SwitchyardError(
              `Stamping ${ref} done authorizes delivery of PR #${open.prNumber} — pass expectedHeadSha (the head SHA you reviewed) to confirm. Current head: ${open.headSha}.`,
            );
          }
          if (patch.expectedHeadSha !== open.headSha) {
            throw new SwitchyardError(
              `${ref}'s PR #${open.prNumber} head moved since you looked: you reviewed ${patch.expectedHeadSha}, but the head is now ${open.headSha} — review the new commits, then stamp again.`,
            );
          }
          donePin = { repo: open.repo, prNumber: open.prNumber, headSha: open.headSha };
        }
      }

      changes.status = patch.status;
      toRecord.push({
        type: "status_changed",
        payload: { from: current.status, to: patch.status, ...(donePin ? { pin: donePin } : {}) },
      });
      // Mirror claimIssue: a bare PATCH to in_progress on an unclaimed issue
      // must assign the caller, or a second actor's identical PATCH would
      // pass assertClaimable (assigneeId still null) and both would believe
      // they own it (SYD-111 — the SYD-93 double-work gap, reachable via
      // update_issue instead of claim_issue).
      if (
        patch.status === "in_progress" &&
        current.assigneeId === null &&
        patch.assigneeName === undefined
      ) {
        changes.assigneeId = actor.id;
        toRecord.push({ type: "assigned", payload: { to: actor.name } });
      }
      // Symmetric to the auto-claim above: `todo` means "available for
      // dispatch", so moving (back) to todo releases any claim. Without this a
      // `todo` issue can keep an assignee and selectDispatchable skips it
      // forever (the "todo + assigned" stuck state, e.g. after a killed
      // container). The dedicated release paths (stale-claims, needs_input
      // answers) already pair todo with assignee=null; this makes a plain
      // status->todo do the same. Skipped when the same patch sets an explicit
      // assignee.
      if (
        patch.status === "todo" &&
        current.assigneeId !== null &&
        patch.assigneeName === undefined
      ) {
        changes.assigneeId = null;
        toRecord.push({ type: "claim_released", payload: { reason: "moved_to_todo" } });
        // SYD-210: self-release ends the claim, so its lease is invalidated
        // (the holder already validated above).
        invalidateLease(tx, current.id);
      }
    }

    if (patch.status === "in_progress" && actor.type === "agent") {
      // Same gates claimIssue enforces — without this, a PATCH straight to
      // in_progress would let an agent start work a human deliberately
      // blocked behind another issue, or duplicate a claim/PR already in
      // flight (SYD-99). Runs even when patch.status === current.status
      // (i.e. the issue is already in_progress) so a second agent's redundant
      // PATCH is refused instead of silently no-op'ing past the gate (SYD-111).
      // Placed after the allow-list/assignee-only check above so reopening
      // in_review -> in_progress as a non-assignee surfaces assertAssignee's
      // "only the assignee" message rather than this gate's generic
      // "already claimed" one (SYD-124).
      const blockers = getOpenBlockers(tx, current.id);
      if (blockers.length > 0) {
        throw new SwitchyardError(
          `${ref} is blocked by ${blockers.map((b) => b.ref).join(", ")} — resolve the blocker first, or call next_task for another issue.`,
        );
      }
      assertClaimable(tx, actor, current);
    }

    if (patch.priority !== undefined && patch.priority !== current.priority) {
      if (!PRIORITIES.includes(patch.priority)) {
        throw new SwitchyardError(
          `"${patch.priority}" is not a priority — valid priorities are: ${PRIORITIES.join(", ")}.`,
        );
      }
      changes.priority = patch.priority;
      toRecord.push({
        type: "priority_changed",
        payload: { from: current.priority, to: patch.priority },
      });
    }
    if (patch.title !== undefined && patch.title !== current.title) {
      changes.title = patch.title;
      toRecord.push({ type: "title_changed", payload: { from: current.title, to: patch.title } });
    }
    if (patch.description !== undefined && patch.description !== current.description) {
      changes.description = patch.description;
      toRecord.push({ type: "description_changed", payload: {} });
    }
    if (patch.summary !== undefined && patch.summary !== current.summary) {
      changes.summary = patch.summary;
      toRecord.push({ type: "summary_changed", payload: {} });
    }
    if (
      patch.labels !== undefined &&
      JSON.stringify([...patch.labels].sort()) !== JSON.stringify([...current.labels].sort())
    ) {
      if (
        actor.type === "agent" &&
        patch.labels.includes("auto") &&
        !current.labels.includes("auto")
      ) {
        throw new SwitchyardError(
          `Only humans apply the "auto" label — it opts an issue into unattended dispatch.`,
        );
      }
      changes.labels = patch.labels;
      toRecord.push({ type: "labels_changed", payload: { to: patch.labels } });
    }
    if (patch.assigneeName !== undefined) {
      let assigneeId: number | null = null;
      if (patch.assigneeName !== null) {
        const a = tx
          .select()
          .from(actorsTable)
          .where(eq(actorsTable.name, patch.assigneeName))
          .get();
        if (!a) {
          throw new SwitchyardError(
            `There is no actor named "${patch.assigneeName}" — check the name and try again.`,
          );
        }
        assigneeId = a.id;
      }
      if (assigneeId !== current.assigneeId) {
        // SYD-191: agents may only self-assign (the claimIssue flow), and only
        // subject to the same claim gates — reassigning to another actor or
        // clearing an existing assignee would disrupt dispatch coordination
        // and bypass claim-before-work, so those are human-only.
        if (actor.type === "agent") {
          if (assigneeId !== actor.id) {
            throw new SwitchyardError(
              patch.assigneeName === null
                ? `Agents can't unassign ${ref} — clearing an assignee is human-only. If it's your own claim, move the issue back to "todo" to release it.`
                : `Agents can't assign ${ref} to "${patch.assigneeName}" — agents may only self-assign (use claim_issue); reassigning is human-only.`,
            );
          }
          assertClaimable(tx, actor, current);
        }
        changes.assigneeId = assigneeId;
        toRecord.push({ type: "assigned", payload: { to: patch.assigneeName } });
      }
    }

    if (
      patch.workerPreference !== undefined &&
      patch.workerPreference !== current.workerPreference
    ) {
      changes.workerPreference = patch.workerPreference;
      toRecord.push({
        type: "worker_preference_changed",
        payload: { from: current.workerPreference, to: patch.workerPreference },
      });
    }

    if (patch.status !== undefined && actor.type === "human" && current.needsInput) {
      changes.needsInput = false;
      toRecord.push({ type: "needs_input_cleared", payload: {} });
    }

    // Mint a lease when this update establishes a fresh claim: an unassigned
    // issue becoming assigned to the actor and in_progress (the claimIssue
    // self-assign path AND the SYD-111 bare-PATCH auto-claim path both land
    // here). Disjoint from the holder-validation above (assigneeId was null).
    if (
      lease.minted &&
      changes.assigneeId === actor.id &&
      current.assigneeId === null &&
      (changes.status === "in_progress" || current.status === "in_progress")
    ) {
      lease.minted.token = mintLease(
        tx,
        current.id,
        actor.id,
        getSetting(db, "claims.lease_ttl_seconds"),
      );
    }

    if (Object.keys(changes).length === 0) return current;
    changes.updatedAt = sql`(unixepoch())`;
    const row = tx.update(issues).set(changes).where(eq(issues.id, current.id)).returning().get();
    for (const e of toRecord) {
      recordEvent(tx, { issueId: current.id, actorId: actor.id, ...e });
    }
    return toView(tx, row);
  });
}

/**
 * The result of a claim: the updated issue plus the plaintext lease token,
 * handed to the claiming session ONCE (never stored, never re-returned).
 */
export type ClaimResult = { issue: IssueView; leaseToken: string };

export function claimIssue(
  db: Db,
  actor: Actor,
  ref: string,
  opts: { takeover?: boolean } = {},
): ClaimResult {
  const current = getIssue(db, ref);
  const blockers = getOpenBlockers(db, current.id);
  if (blockers.length > 0) {
    throw new SwitchyardError(
      `${ref} is blocked by ${blockers.map((b) => b.ref).join(", ")} — resolve the blocker first, or call next_task for another issue.`,
    );
  }

  // Same-actor re-claim of an issue that already has an active lease: fail
  // loudly unless takeover is opted in (this project's workflow tells every
  // session to claim before touching code, and interactive + dispatched
  // sessions share the worker actor — a default takeover would silently kill a
  // healthy running container). Takeover only reaches here for the same actor;
  // a different actor's claim is refused by assertClaimable below.
  if (current.assigneeId === actor.id) {
    const active = getActiveLease(db, current.id);
    if (active && !opts.takeover) {
      throw new SwitchyardError(
        `${ref} already has an active lease held by this actor — another session may be working it. ` +
          `Pass takeover: true to seize the claim (invalidating that session's lease), or call next_task for another issue.`,
      );
    }
    // Re-claim (takeover, or a lease-less holder e.g. after expiry): swap the
    // lease in one transaction. The issue is already in_progress + assigned, so
    // no status change is needed.
    const leaseToken = db.transaction((tx) => {
      if (active) {
        invalidateLease(tx, current.id);
        recordEvent(tx, {
          issueId: current.id,
          actorId: actor.id,
          type: "lease_taken_over",
          payload: {},
        });
      }
      return mintLease(tx, current.id, actor.id, getSetting(db, "claims.lease_ttl_seconds"));
    });
    return { issue: getIssue(db, ref), leaseToken };
  }

  // Fresh claim of an unassigned (or blocked/PR-guarded) issue: assertClaimable
  // is re-checked inside updateIssue's in_progress gate; the mint happens there
  // via the out-channel.
  assertClaimable(db, actor, current);
  const minted: { token: string | null } = { token: null };
  const issue = updateIssue(db, actor, ref, { status: "in_progress", assigneeName: actor.name }, { minted });
  if (minted.token === null) {
    // Defensive: the auto-claim mint condition should always fire on a fresh
    // claim. If it didn't, the claim state is inconsistent — fail rather than
    // hand back an empty token.
    throw new SwitchyardError(`Failed to mint a lease while claiming ${ref} — retry the claim.`);
  }
  return { issue, leaseToken: minted.token };
}
