import { and, eq, gt, isNull } from "drizzle-orm";
import type { DbOrTx } from "../db/index.js";
import { claimLeases } from "../db/schema.js";
import { SwitchyardError } from "./errors.js";
import { hashToken, mintToken } from "./tokens.js";

export type ClaimLease = typeof claimLeases.$inferSelect;

/** The setting key for the mint TTL (default 8h). */
export const LEASE_TTL_SETTING = "claims.lease_ttl_seconds" as const;

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * The single active lease of an issue: not invalidated and not past
 * expires_at. At most one by construction (a claim is 1:1 with an issue).
 */
export function getActiveLease(
  db: DbOrTx,
  issueId: number,
  now: number = nowSeconds(),
): ClaimLease | null {
  return (
    db
      .select()
      .from(claimLeases)
      .where(
        and(
          eq(claimLeases.issueId, issueId),
          isNull(claimLeases.invalidatedAt),
          gt(claimLeases.expiresAt, now),
        ),
      )
      .get() ?? null
  );
}

/**
 * Inserts a fresh lease and returns the plaintext token ONCE. Store only the
 * hash; the plaintext is never re-derivable and never persisted elsewhere.
 * Runs inside the caller's transaction so a lease and its claim are atomic.
 */
export function mintLease(
  tx: DbOrTx,
  issueId: number,
  actorId: number,
  ttlSeconds: number,
): string {
  const token = mintToken("lease");
  const now = nowSeconds();
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
