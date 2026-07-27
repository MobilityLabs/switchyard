// Declared issue<->PR attribution (SYD-280, spec: docs/superpowers/specs/
// 2026-07-27-declared-pr-attribution-design.md).
//
// This module is the ONLY writer of pr_links. It replaces three string
// inference sites — the strict agent/<ref> branch match (pr-state.ts's
// attributedRef), the first free-text ref in a PR title/body
// (github-webhook.ts's resolveRef), and a branch name reconstructed from the
// issue ref (delivery-events.ts) — with a statement made by someone the system
// can hold accountable.
//
// The split that makes this safe to widen to agents: a DECLARATION says "this
// PR is this issue's work". It never says anything about the PR's STATUS.
// Merge state comes only from pr_state, whose write path is untouched. So an
// agent that declares cannot fake a merge; the worst it can do is over-block
// its own issue, which a human can revoke.
//
// Why `service` may declare even though SYD-213 denies service actors every
// other board mutation: the auto path's declarer IS trusted infra (the worker
// host posts pr_opened after the container has exited — see design §4a), and
// that path already writes claim-gating pr_state today via recordDeliveryEvent
// -> upsertPrState. Allowing the declaration is exactly equivalent to the
// authority infra already holds, not a widening of it.

import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../db/index.js";
import { prLinks, type PrLinkRole } from "../db/schema.js";
import type { Actor } from "./actors.js";
import type { Attribution } from "./attribution.js";
import { SwitchyardError } from "./errors.js";
import { getIssue } from "./issues.js";
import { recordEvent } from "./events.js";
import { boundRepoFullNames, normalizeRepoFullName } from "./github-repos.js";
import { validateLease } from "./leases.js";

export type PrLink = typeof prLinks.$inferSelect;

export type PrLinkTarget = { repo: string; prNumber: number };

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Every live link on an issue, newest declaration first. */
export function listLiveLinks(db: DbOrTx, issueId: number): PrLink[] {
  return db
    .select()
    .from(prLinks)
    .where(and(eq(prLinks.issueId, issueId), isNull(prLinks.revokedAt)))
    .orderBy(sql`${prLinks.declaredAt} DESC, ${prLinks.id} DESC`)
    .all();
}

function findLiveLink(
  db: DbOrTx,
  issueId: number,
  repo: string,
  prNumber: number,
): PrLink | undefined {
  return db
    .select()
    .from(prLinks)
    .where(
      and(
        eq(prLinks.issueId, issueId),
        sql`lower(${prLinks.repo}) = lower(${repo})`,
        eq(prLinks.prNumber, prNumber),
        isNull(prLinks.revokedAt),
      ),
    )
    .get();
}

/**
 * The repo must be bound to the issue's project — the same rule attributedRef
 * enforces today (src/services/pr-state.ts). Without it any repo could claim
 * any issue, which is the cross-project attribution hole SYD-206 closed.
 */
function assertRepoBound(db: DbOrTx, projectId: number, repo: string): void {
  const bound = boundRepoFullNames(db as Db, projectId);
  if (!bound.some((b) => b.toLowerCase() === repo.toLowerCase())) {
    throw new SwitchyardError(
      `${repo} is not bound to this issue's project — bind it first (add-github-repo), or declare against a repo that is. Bound: ${bound.length ? bound.join(", ") : "none"}.`,
    );
  }
}

/**
 * Declare that a PR carries an issue's work.
 *
 * Authority (design §4):
 * - an **agent** must hold the issue's claim and present its lease; its
 *   declaration is `delivers` and lands **unconfirmed**, so it gates claims but
 *   can never prove the work landed;
 * - a **human or service** actor declares directly, and the declaration is
 *   **auto-confirmed** — which is what collapses "who is trusted" into the
 *   single confirmed_by predicate the readers use.
 */
export function declarePrLink(
  db: Db,
  actor: Actor,
  ref: string,
  input: PrLinkTarget & { role?: PrLinkRole },
  leaseToken?: string,
  attr: Attribution = {},
): PrLink {
  const repo = normalizeRepoFullName(input.repo);
  if (!Number.isInteger(input.prNumber) || input.prNumber <= 0) {
    throw new SwitchyardError(`"${input.prNumber}" is not a PR number.`);
  }
  return db.transaction((tx) => {
    const issue = getIssue(tx, ref);
    assertRepoBound(tx, issue.projectId, repo);

    const isAgent = actor.type === "agent";
    if (isAgent) {
      if (issue.assigneeId !== actor.id) {
        throw new SwitchyardError(
          `${ref} is not yours to declare a PR for — claim it first, or ask a human to record the link.`,
        );
      }
      validateLease(tx, issue.id, actor.id, leaseToken);
    }

    // Agents declare delivers or nothing: a references link is a suggestion,
    // and suggestions come from humans or from free-text ingestion, never from
    // an actor asserting its own work.
    const role: PrLinkRole = isAgent ? "delivers" : (input.role ?? "delivers");

    const existing = findLiveLink(tx, issue.id, repo, input.prNumber);
    if (existing) {
      throw new SwitchyardError(
        `${ref} already has a live link to ${repo}#${input.prNumber} — revoke it before declaring a different role.`,
      );
    }

    const now = nowSeconds();
    const row = tx
      .insert(prLinks)
      .values({
        issueId: issue.id,
        repo,
        prNumber: input.prNumber,
        role,
        declaredBy: actor.id,
        declaredAt: now,
        confirmedBy: isAgent ? null : actor.id,
        confirmedAt: isAgent ? null : now,
      })
      .returning()
      .get();

    recordEvent(tx, {
      issueId: issue.id,
      actorId: actor.id,
      type: "pr_link_declared",
      payload: { repo, prNumber: input.prNumber, role, confirmed: !isAgent },
      viaAgentId: attr.viaAgentId,
      sessionId: attr.sessionId,
    });
    return row;
  });
}

/**
 * Confirm a link, making it proof-bearing (design §5).
 *
 * Agents can never confirm — that is the whole reason declaring is safe to
 * widen to them. In the ordinary flow this is not a separate click: the human
 * authorizing the PR is already looking at it, so the authorization act is
 * expected to call this.
 */
export function confirmPrLink(
  db: Db,
  actor: Actor,
  ref: string,
  input: PrLinkTarget,
  attr: Attribution = {},
): PrLink {
  const repo = normalizeRepoFullName(input.repo);
  if (actor.type === "agent") {
    throw new SwitchyardError(
      "Only a human can confirm a PR link — an agent may declare which PR carries its work, but never vouch for it.",
    );
  }
  return db.transaction((tx) => {
    const issue = getIssue(tx, ref);
    const link = findLiveLink(tx, issue.id, repo, input.prNumber);
    if (!link) {
      throw new SwitchyardError(
        `${ref} has no live link to ${repo}#${input.prNumber} to confirm — declare it first.`,
      );
    }
    if (link.confirmedBy !== null) return link;

    const now = nowSeconds();
    const row = tx
      .update(prLinks)
      .set({ confirmedBy: actor.id, confirmedAt: now })
      .where(eq(prLinks.id, link.id))
      .returning()
      .get();

    recordEvent(tx, {
      issueId: issue.id,
      actorId: actor.id,
      type: "pr_link_confirmed",
      // humanConfirmed drives the §5a recency exception at the read sites: a
      // person asserting the relationship outranks the clock, because
      // hand-merge-then-update is the dominant interactive flow.
      payload: { repo, prNumber: input.prNumber, humanConfirmed: actor.type === "human" },
      viaAgentId: attr.viaAgentId,
      sessionId: attr.sessionId,
    });
    return row;
  });
}

/**
 * Soft-revoke a link. Never DELETEs — "who un-linked this, and why" is exactly
 * what the audit is for, and a soft revoke is what lets the same PR be
 * re-declared later without destroying the first declaration's history.
 *
 * A revoke removes an *interpretation*, never an observation: pr_state and the
 * gh_* event history are untouched.
 */
export function revokePrLink(
  db: Db,
  actor: Actor,
  ref: string,
  input: PrLinkTarget & { reason: string },
  leaseToken?: string,
  attr: Attribution = {},
): void {
  const repo = normalizeRepoFullName(input.repo);
  if (!input.reason.trim()) {
    throw new SwitchyardError("A reason is required to revoke a PR link — say why it is wrong.");
  }
  db.transaction((tx) => {
    const issue = getIssue(tx, ref);
    const link = findLiveLink(tx, issue.id, repo, input.prNumber);
    if (!link) {
      throw new SwitchyardError(`${ref} has no live link to ${repo}#${input.prNumber}.`);
    }

    if (actor.type !== "human") {
      // A non-human may withdraw only its OWN, still-unconfirmed statement.
      // Once a human has vouched for a link, only a human can take it back.
      if (link.confirmedBy !== null) {
        throw new SwitchyardError(
          `${ref}'s link to ${repo}#${input.prNumber} has been confirmed — only a human can revoke it.`,
        );
      }
      if (link.declaredBy !== actor.id) {
        throw new SwitchyardError(
          `${ref}'s link to ${repo}#${input.prNumber} was declared by someone else — only its declarer or a human can revoke it.`,
        );
      }
      if (actor.type === "agent") validateLease(tx, issue.id, actor.id, leaseToken);
    }

    tx.update(prLinks).set({ revokedAt: nowSeconds() }).where(eq(prLinks.id, link.id)).run();

    recordEvent(tx, {
      issueId: issue.id,
      actorId: actor.id,
      type: "pr_link_revoked",
      payload: { repo, prNumber: input.prNumber, reason: input.reason.trim() },
      viaAgentId: attr.viaAgentId,
      sessionId: attr.sessionId,
    });
  });
}
