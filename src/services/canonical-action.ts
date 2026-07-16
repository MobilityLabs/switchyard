// The exact bytes a human signs to affirm a gated action, and that the server
// re-derives from the DB row before executing it.
//
// Why the whole document and not a SHA-256 challenge (research doc §4.2): that
// framing is inherited from WebAuthn, which needs a fixed-size challenge.
// SSHSIG hashes its own stdin, so signing the document directly means there is
// no challenge column to store, drift, or forget to compare — the binding is
// structural. The only bytes that verify are the ones the server rebuilds from
// the row it is about to execute, so a signature for SYD-42 cannot verify
// against SYD-43. It also composes with Phase 1's dedup refresh: if a
// re-proposal rewrites `payload`, these bytes change, the signature stops
// verifying, and the human re-signs. Fail-safe by construction.
//
// LEAF MODULE — imports nothing from ./issues or ./hard-gate, which already
// form an import cycle. Callers build the doc; they have the ref in hand.

/** The SSHSIG signature namespace. Not decoration: it is what stops a signature
 *  we solicit being replayable in another domain of use (e.g. git signing). */
export const AFFIRM_NAMESPACE = "switchyard-affirm";

export type CanonicalAction = {
  v: 1;
  pendingActionId: number;
  sessionId: number;
  issueRef: string;
  actionType: string;
  expectedHeadSha?: string;
  expiresAt: number;
};

/**
 * Deterministic serialization. Keys are sorted explicitly rather than trusted to
 * literal order — a future edit reordering the type would otherwise silently
 * invalidate every signature. Undefined-valued keys are dropped so that "absent"
 * and "explicitly undefined" produce one representation, never `null`.
 */
export function canonicalizeAction(a: CanonicalAction): string {
  const keys = (Object.keys(a) as (keyof CanonicalAction)[])
    .filter((k) => a[k] !== undefined)
    .sort();
  return JSON.stringify(a, keys as string[]);
}
