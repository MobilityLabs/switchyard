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
import { alias } from "drizzle-orm/sqlite-core";
import type { Db, DbOrTx } from "../db/index.js";
import { actors, prLinks, prState, type PrLinkRole } from "../db/schema.js";
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

/** What GitHub was last seen doing to a linked PR — the pr_state half of the join. */
export type PrObservationView = {
  status: "open" | "merged" | "closed";
  url: string | null;
  ghUpdatedAt: number | null;
};

export type PrLinkView = PrLink & {
  declaredByName: string;
  confirmedByName: string | null;
  /** Whether a HUMAN confirmed — the §5a exception turns on this, not on merely being confirmed. */
  confirmedByHuman: boolean;
  /** null when nothing has ever observed this PR, which is not the same as "not merged". */
  observed: PrObservationView | null;
  /** True when this link on its own would let a reader conclude the work landed. */
  provesLanded: boolean;
};

/**
 * Does this link, joined to its observation, satisfy the proof-bearing
 * predicate the readers use? The TS mirror of the SQL in attention.ts's
 * unresolvedDoneWithoutMerge — kept as one exported function because the UI
 * panel and the attention banner sit on the same screen, and a panel that says
 * "confirmed ✓" beside a lit "done without a merged PR" warning is a second
 * contradictory signal rather than an explanation (SYD-290).
 *
 * The three conjuncts, per design §5/§5a and the pr_links schema comment:
 * role is `delivers` (a suggestion proves nothing), someone accountable
 * confirmed it, and — unless that confirmer was a human — the observation must
 * postdate the declaration, so a stale merge can't be retro-claimed.
 */
export function provesLanded(
  link: Pick<PrLink, "role" | "confirmedBy" | "declaredAt">,
  confirmedByHuman: boolean,
  observed: PrObservationView | null,
): boolean {
  if (link.role !== "delivers" || link.confirmedBy === null) return false;
  if (observed?.status !== "merged") return false;
  if (confirmedByHuman) return true;
  return observed.ghUpdatedAt !== null && observed.ghUpdatedAt >= link.declaredAt;
}

/**
 * Every live link on an issue with the two things a human needs in order to
 * act on it: WHO said what (declarer/confirmer names, so the panel can show
 * "declared by claude/dev, unconfirmed" rather than an actor id), and WHETHER
 * ANYTHING OBSERVED THE PR.
 *
 * The observation half matters more than it looks. `pr_state` only started
 * covering every PR in a bound repo at SYD-287; PRs merged before that — this
 * repo has a run of them, #121-#155 — have no row at all. Declaring and
 * confirming a link to one of those is a perfectly valid statement that still
 * leaves `done_without_merged_pr` lit, because the join has no observation
 * half. Surfacing `observed: null` is what stops the panel from implying a
 * click will clear a flag that it cannot.
 */
export function listLiveLinkViews(db: DbOrTx, issueId: number): PrLinkView[] {
  const declarer = alias(actors, "declarer");
  const confirmer = alias(actors, "confirmer");
  const rows = db
    .select({
      link: prLinks,
      declaredByName: declarer.name,
      confirmedByName: confirmer.name,
      confirmerType: confirmer.type,
      status: prState.status,
      url: prState.url,
      ghUpdatedAt: prState.ghUpdatedAt,
    })
    .from(prLinks)
    .innerJoin(declarer, eq(declarer.id, prLinks.declaredBy))
    .leftJoin(confirmer, eq(confirmer.id, prLinks.confirmedBy))
    // pr_state is keyed (repo, prNumber) with repo stored as written, so match
    // case-insensitively the way every other reader of this join does.
    .leftJoin(
      prState,
      and(
        sql`lower(${prState.repo}) = lower(${prLinks.repo})`,
        eq(prState.prNumber, prLinks.prNumber),
      ),
    )
    .where(and(eq(prLinks.issueId, issueId), isNull(prLinks.revokedAt)))
    .orderBy(sql`${prLinks.declaredAt} DESC, ${prLinks.id} DESC`)
    .all();

  return rows.map((r) => {
    const observed: PrObservationView | null =
      r.status === null ? null : { status: r.status, url: r.url, ghUpdatedAt: r.ghUpdatedAt };
    const confirmedByHuman = r.confirmerType === "human";
    return {
      ...r.link,
      declaredByName: r.declaredByName,
      confirmedByName: r.confirmedByName,
      confirmedByHuman,
      observed,
      provesLanded: provesLanded(r.link, confirmedByHuman, observed),
    };
  });
}

/**
 * The issues holding a live `delivers` link to a PR — the (repo, prNumber)
 * direction of the same predicate pr-status.ts reads issue-first as
 * LIVE_DELIVERS. Oldest declaration first, so a caller that must pick one
 * (pr_state's single lastTransitionEventId column) picks deterministically.
 *
 * This is what makes ingestion link-aware (SYD-287): a PR is worth observing
 * when someone accountable has said it carries an issue's work, which is a
 * fact about (repo, prNumber) alone — no branch name, no PR text.
 */
export function deliversLinkIssueIds(db: DbOrTx, repo: string, prNumber: number): number[] {
  if (!Number.isInteger(prNumber) || prNumber <= 0) return [];
  return db
    .select({ issueId: prLinks.issueId })
    .from(prLinks)
    .where(
      and(
        sql`lower(${prLinks.repo}) = lower(${normalizeRepoFullName(repo)})`,
        eq(prLinks.prNumber, prNumber),
        eq(prLinks.role, "delivers"),
        isNull(prLinks.revokedAt),
      ),
    )
    .orderBy(sql`${prLinks.declaredAt} ASC, ${prLinks.id} ASC`)
    .all()
    .map((r) => r.issueId);
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

    const now = nowSeconds();

    // Promotion (SYD-287). Free-text ingestion mints an unconfirmed
    // `references` suggestion the moment the webhook sees a PR whose title
    // carries the ref — which, for interactive work, lands BEFORE the session
    // gets to declare. Rejecting the declaration outright made the declared
    // path unreachable in the only order production actually produces, so a
    // `references` -> `delivers` declaration supersedes the suggestion instead
    // of colliding with it. Design §8 already calls this "a 'did you mean?' a
    // human may promote"; this is the promotion.
    //
    // Authority is unchanged, not widened: the declarer has just passed §4's
    // rules above, and the same actor could already reach this state by
    // revoking and re-declaring. Superseding is a soft revoke plus a fresh
    // row, so both statements survive — the suggestion is not rewritten into
    // an assertion it never made.
    const existing = findLiveLink(tx, issue.id, repo, input.prNumber);
    if (existing) {
      if (!(existing.role === "references" && role === "delivers")) {
        throw new SwitchyardError(
          `${ref} already has a live link to ${repo}#${input.prNumber} — revoke it before declaring a different role.`,
        );
      }
      tx.update(prLinks).set({ revokedAt: now }).where(eq(prLinks.id, existing.id)).run();
    }

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
      payload: {
        repo,
        prNumber: input.prNumber,
        role,
        confirmed: !isAgent,
        // Names what this superseded, so "where did the references link go"
        // is answerable from the timeline and not only from the revoked row.
        ...(existing ? { promotedFrom: existing.role } : {}),
      },
      viaAgentId: attr.viaAgentId,
      sessionId: attr.sessionId,
    });
    return row;
  });
}

/**
 * Ingestion's declaration path — webhook/poller and the worker's publish.
 *
 * Separate from declarePrLink because ingestion is not an actor staking a
 * claim: it is the system recording an attribution it observed, attributed to
 * the synthetic `github` actor (which is type `agent`,
 * src/services/github-webhook.ts:176, and so could never satisfy the
 * claim+lease rules). Runs inside the caller's transaction.
 *
 * **Scope discipline — this is parity, not a widening.** Only the
 * branch-attributed path (a strict agent/<ref> match in a repo bound to that
 * ref's project) may pass `role: "delivers"`, because that is precisely the
 * signal that gates claims and proves landing *today*. Free-text ref matches
 * must pass `role: "references"`, which gates nothing and proves nothing — a
 * narrowing of today's behaviour, and the fix for the false-clear hole where
 * an unrelated PR that merely mentions an issue silences its warning.
 *
 * Note the untrusted-ingress caveat: POST /api/github-events accepts any
 * human/service token and is indistinguishable from an HMAC-verified delivery
 * (design "Scope", analysis §3.7). That is true of today's attribution too, so
 * this is not a regression — it is SYD-282's to fix, and this function must
 * not be read as making ingested merges trustworthy.
 *
 * Idempotent: a redelivery finds the live link and returns it unchanged. The
 * one exception is the upgrade below — a branch-attributed observation
 * supersedes a `references` suggestion an earlier free-text match minted for
 * the same (issue, repo, PR), because otherwise ingestion order would decide
 * whether a PR gates claims.
 *
 * **Records no event, deliberately.** The row itself carries the full audit
 * (declared_by, declared_at, role), and the observation that prompted it is
 * already on the timeline as gh_pr_opened/gh_pr_merged. Emitting an event too
 * would put a "pr_link_declared" line above every single PR in every activity
 * feed — a signal that fires on ordinary success, which is the noise class the
 * intent document's principle 5 warns about. Actor-initiated declarations
 * (declarePrLink/confirmPrLink/revokePrLink) DO record events, because those
 * are decisions someone made rather than bookkeeping the system did.
 */
export function recordIngestedPrLink(
  tx: DbOrTx,
  input: {
    issueId: number;
    repo: string;
    prNumber: number;
    role: PrLinkRole;
    actorId: number;
  },
): PrLink {
  const repo = normalizeRepoFullName(input.repo);
  const now = nowSeconds();
  const existing = findLiveLink(tx, input.issueId, repo, input.prNumber);
  if (existing) {
    // Upgrade only, never downgrade (SYD-287). The branch-attributed path is
    // strictly more authoritative than the free-text one, so it supersedes a
    // `references` suggestion the same way an actor's declaration does —
    // otherwise a PR that happened to be ingested by text first would keep a
    // suggestion where a claim-gating link belongs, and lose its co-written
    // transition event with it.
    if (!(existing.role === "references" && input.role === "delivers")) return existing;
    tx.update(prLinks).set({ revokedAt: now }).where(eq(prLinks.id, existing.id)).run();
  }

  // A `delivers` link from the branch-attributed path is confirmed, matching
  // the authority pr_state.issue_ref carries today — its confirmer is not a
  // human, so §5a's recency binding still applies to it. A `references` link
  // is never confirmed: it is a suggestion for a human to promote.
  const confirmed = input.role === "delivers";
  const row = tx
    .insert(prLinks)
    .values({
      issueId: input.issueId,
      repo,
      prNumber: input.prNumber,
      role: input.role,
      declaredBy: input.actorId,
      declaredAt: now,
      confirmedBy: confirmed ? input.actorId : null,
      confirmedAt: confirmed ? now : null,
    })
    .returning()
    .get();
  return row;
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
    // Confirming a suggestion used to succeed and do nothing. Every reader of
    // proof joins on role='delivers', so a confirmed `references` row
    // satisfies none of them: the caller got a success, an event on the
    // timeline, and an unchanged flag. Found the live way — confirming the
    // ingested #194 link on SYD-243 to clear its done_without_merged_pr, which
    // reported success and left the flag lit.
    //
    // Refused rather than auto-promoted, deliberately. `references` links come
    // from PR prose — since SYD-274, one for EVERY ref a PR names — so letting
    // a single confirm turn a passing mention into delivery-grade evidence
    // would reopen the SYD-280 hole from the other side. The two verbs mean
    // different things: `declare` asserts what a PR carries, `confirm` vouches
    // for an assertion someone already made. There is no assertion here to
    // vouch for, and declaring is a one-step path that both supersedes the
    // suggestion and confirms.
    if (link.role === "references") {
      throw new SwitchyardError(
        `${ref}'s link to ${repo}#${input.prNumber} is a \`references\` suggestion, not a claim that ` +
          `the PR carries this work — confirming it would prove nothing, because every reader of ` +
          `proof requires role 'delivers'. Declare it instead: that supersedes the suggestion and ` +
          `confirms in one step.`,
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

export type BackfillResult = { created: number; alreadyLinked: number; skipped: number };

/**
 * One-time cutover backfill (design §10 step 2): one confirmed `delivers` link
 * per attributed pr_state row, so existing agent work keeps its attribution
 * when the readers swap over. **Must run before the join swap ships** — without
 * it every existing agent PR silently loses its link, which would make
 * in-flight work claimable again (the SYD-93/177 class).
 *
 * Two deliberate departures from the ordinary declaration rules, because
 * reading this as a normal declaration produces the wrong result:
 *
 * 1. **`confirmed_by` is set explicitly, not derived.** These rows were trusted
 *    under the old model — pr_state.issue_ref gated claims and proved landing —
 *    so leaving them unconfirmed would strip proof from all existing agent work
 *    and turn the migration into a regression.
 * 2. **The confirmer is the human operator, not the `github` actor.** The
 *    github actor is type `agent` (github-webhook.ts:176), so deriving the
 *    confirmer from the declarer would both fail rule 1 and, via §5a, subject
 *    every historical row to recency binding — retroactively failing merges
 *    that legitimately predate their pr_state row. Requiring an operator
 *    identity also means this cannot run unattended, which is correct for a
 *    one-time trust assertion over existing data.
 *
 * `declared_at` comes from the row's own `updated_at`, never wall-clock, for
 * the same reason.
 */
export function backfillPrLinksFromPrState(
  db: Db,
  operator: Actor,
  opts: { dryRun?: boolean } = {},
): BackfillResult {
  if (operator.type !== "human") {
    throw new SwitchyardError(
      "The pr_links backfill asserts trust over existing data on a human's behalf — run it as a human actor, not as an agent or service token.",
    );
  }
  const rows = db.all<{
    issueId: number;
    repo: string;
    prNumber: number;
    updatedAt: number;
  }>(sql`
    SELECT i.id AS issueId, ps.repo AS repo, ps.pr_number AS prNumber,
           ps.updated_at AS updatedAt
    FROM pr_state ps, issues i, projects p
    WHERE ps.issue_ref IS NOT NULL
      AND i.project_id = p.id
      AND ps.issue_ref = p.key || '-' || i.number
    ORDER BY ps.repo ASC, ps.pr_number ASC
  `);

  const result: BackfillResult = { created: 0, alreadyLinked: 0, skipped: 0 };
  for (const row of rows) {
    const repo = normalizeRepoFullName(row.repo);
    if (findLiveLink(db, row.issueId, repo, row.prNumber)) {
      result.alreadyLinked++;
      continue;
    }
    if (opts.dryRun) {
      result.created++;
      continue;
    }
    db.insert(prLinks)
      .values({
        issueId: row.issueId,
        repo,
        prNumber: row.prNumber,
        role: "delivers",
        declaredBy: operator.id,
        declaredAt: row.updatedAt,
        confirmedBy: operator.id,
        confirmedAt: row.updatedAt,
      })
      .run();
    result.created++;
  }
  return result;
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
