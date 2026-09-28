import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../db/index.js";
import { claimLeases, issues } from "../db/schema.js";
import { SwitchyardError } from "./errors.js";
import { recordEvent } from "./events.js";
import { hashToken, mintToken } from "./tokens.js";
import { getSetting } from "./settings.js";

export type ClaimLease = typeof claimLeases.$inferSelect;

/** The setting key for the mint TTL (default 8h). */
export const LEASE_TTL_SETTING = "claims.lease_ttl_seconds" as const;

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * The current assignee's latest lease, while still valid. Older generations
 * never become current again, even if a legacy duplicate has a longer TTL
 * than its replacement. This also tolerates rows written before reassignment
 * invalidated leases: an outgoing assignee's token cannot remain active.
 */
export function getActiveLease(
  db: DbOrTx,
  issueId: number,
  now: number = nowSeconds(),
): ClaimLease | null {
  return (
    db
      .select({ lease: claimLeases })
      .from(claimLeases)
      .innerJoin(
        issues,
        and(eq(issues.id, claimLeases.issueId), eq(issues.assigneeId, claimLeases.actorId)),
      )
      .where(
        and(
          eq(claimLeases.issueId, issueId),
          isNull(claimLeases.invalidatedAt),
          gt(claimLeases.expiresAt, now),
          sql`NOT EXISTS (
            SELECT 1 FROM claim_leases newer
            WHERE newer.issue_id = ${claimLeases.issueId} AND newer.id > ${claimLeases.id}
          )`,
        ),
      )
      .get()?.lease ?? null
  );
}

/**
 * Inserts a fresh lease and returns the plaintext token ONCE. Store only the
 * hash; the plaintext is never re-derivable and never persisted elsewhere.
 * Runs inside the caller's transaction so a lease and its claim are atomic.
 */
export function mintLease(
  db: DbOrTx,
  issueId: number,
  actorId: number,
  ttlSeconds: number,
): string {
  const token = mintToken("lease");
  const now = nowSeconds();
  return db.transaction((tx) => {
    // Retire expired predecessors too: otherwise the next expiry sweep could
    // mistake their old claim for this new generation.
    invalidateLease(tx, issueId);
    tx.insert(claimLeases)
      .values({
        issueId,
        actorId,
        tokenHash: hashToken(token),
        expiresAt: now + ttlSeconds,
        lastBeatAt: now,
      })
      .run();
    return token;
  });
}

/**
 * Throws unless `token` is the active lease for (issueId, actorId). Pure read.
 * A missing token, no active lease (expired/never-claimed), an actor mismatch,
 * or a superseded token (e.g. after takeover) all reject — this is the
 * SYD-93/122 shared-token close: a second session of the same worker actor
 * holds the shared bearer token but not this lease.
 */
export function validateLease(
  db: DbOrTx,
  issueId: number,
  actorId: number,
  token: string | undefined,
): void {
  const active = token ? getActiveLease(db, issueId) : null;
  if (!active || active.actorId !== actorId || active.tokenHash !== hashToken(token!)) {
    throw new SwitchyardError(
      "This action needs your claim's lease token, which is missing, expired, or superseded — " +
        "call claim_issue to (re)claim this issue and get a fresh lease. If another session took " +
        "it over, that session now owns the work.",
    );
  }
}

/**
 * SYD-210 Layer B: renew a lease's liveness window. Validates the holder's
 * token, then bumps last_beat_at and sets expires_at = now +
 * claims.heartbeat_window_seconds. The window is SHORTER than the mint TTL, so
 * the first heartbeat collapses a container claim's 8h fallback to ~10 min of
 * honest liveness — a container that keeps beating stays alive, a dead one
 * loses its lease within one window. Interactive claims never heartbeat and
 * keep the long TTL.
 */
export function heartbeatLease(
  db: DbOrTx,
  issueId: number,
  actorId: number,
  token: string | undefined,
): ClaimLease {
  validateLease(db, issueId, actorId, token);
  const active = getActiveLease(db, issueId)!;
  const now = nowSeconds();
  return db
    .update(claimLeases)
    .set({
      lastBeatAt: now,
      expiresAt: now + getSetting(db as Db, "claims.heartbeat_window_seconds"),
    })
    .where(eq(claimLeases.id, active.id))
    .returning()
    .get();
}

/**
 * Retires all outstanding lease generations, including expired or historical
 * duplicate rows (takeover / reassignment / release). The REASON is
 * carried by the event the caller co-records (claim_released{reason} /
 * lease_taken_over), not stored on the lease row.
 */
export function invalidateLease(tx: DbOrTx, issueId: number): void {
  tx.update(claimLeases)
    .set({ invalidatedAt: sql`(unixepoch())` })
    .where(and(eq(claimLeases.issueId, issueId), isNull(claimLeases.invalidatedAt)))
    .run();
}

/**
 * Sweep: for every non-invalidated lease past expires_at, atomically release
 * the still-matching in_progress claim (re-assert status/needsInput inside the
 * UPDATE, exactly like releaseStaleClaims — a legit transition that landed
 * first wins the race, .changes === 0 ⇒ skip the event), record
 * claim_released{reason:"lease_expired"}, and mark the lease invalidated (so it
 * leaves future sweeps). Replaces the 4h idle guess for leased claims.
 * Returns the number of issues released.
 *
 * SYD-210 Layer B server-uptime gate: a tracker redeploy is a correlated
 * outage — every container's heartbeats fail at once during the ~5–15s restart.
 * When `serverStartedAt` is given, the sweep is skipped entirely until the
 * server has been continuously up for one full heartbeat window.
 *
 * What this actually buys (do not over-read the guarantee): the PRIMARY
 * protection against a redeploy is the heartbeat cadence itself — a beat every
 * 60s keeps expires_at ≥540s out, so any outage shorter than that never lapses
 * a lease. The gate does NOT resurrect a lease that DID lapse during a longer
 * outage: heartbeatLease → validateLease → getActiveLease requires
 * `expires_at > now`, so a lapsed lease can't be re-heartbeated regardless. The
 * gate closes two remaining gaps: (1) the narrow post-restart window where the
 * 2s sweep could beat the next 60s heartbeat to a just-lapsed lease, and (2)
 * paired with releaseStaleClaims' matching grace, it stops the legacy idle
 * sweep from releasing a lapsed-lease issue the instant the server returns. An
 * outage longer than the window still loses those leases (the host cancels
 * those containers on its own missed-beat counter) — an accepted cost.
 */
export function expireLeases(db: Db, now: number = nowSeconds(), serverStartedAt?: number): number {
  if (
    serverStartedAt !== undefined &&
    now - serverStartedAt < getSetting(db, "claims.heartbeat_window_seconds")
  ) {
    return 0;
  }
  const expired = db
    .select()
    .from(claimLeases)
    .where(and(isNull(claimLeases.invalidatedAt), lte(claimLeases.expiresAt, now)))
    .all();
  let released = 0;
  for (const lease of expired) {
    const wasReleased = db.transaction((tx) => {
      // Always invalidate the expired lease, even if the issue moved on, so the
      // next sweep does not re-scan it.
      const retired = tx
        .update(claimLeases)
        .set({ invalidatedAt: sql`(unixepoch())` })
        .where(
          and(
            eq(claimLeases.id, lease.id),
            isNull(claimLeases.invalidatedAt),
            lte(claimLeases.expiresAt, now),
          ),
        )
        .run();
      if (retired.changes === 0) return false;
      const result = tx
        .update(issues)
        .set({ status: "todo", assigneeId: null, updatedAt: sql`(unixepoch())` })
        .where(
          and(
            eq(issues.id, lease.issueId),
            eq(issues.assigneeId, lease.actorId),
            eq(issues.status, "in_progress"),
            eq(issues.needsInput, false),
            // A historical predecessor must never release a newer claim,
            // whether the replacement is live, expired, or already retired.
            sql`NOT EXISTS (
              SELECT 1 FROM claim_leases newer
              WHERE newer.issue_id = ${lease.issueId} AND newer.id > ${lease.id}
            )`,
          ),
        )
        .run();
      if (result.changes === 0) return false;
      recordEvent(tx, {
        issueId: lease.issueId,
        actorId: lease.actorId,
        type: "claim_released",
        payload: { reason: "lease_expired" },
      });
      return true;
    });
    if (wasReleased) released++;
  }
  return released;
}
