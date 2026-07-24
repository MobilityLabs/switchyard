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
// form an import cycle. ./errors is itself a leaf (only declares error
// classes), so importing it here does not introduce a cycle. Callers build
// the doc; they have the ref in hand.

import { SwitchyardError } from "./errors.js";

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

// The signed field set, fixed. NOT derived from the runtime object: TypeScript's
// excess-property check only fires on fresh literals, so a caller spreading a DB
// row ({...row, v: 1}) would otherwise sign every column on that row — and two
// callers building the same logical action from different-shaped sources would
// produce different bytes. Sorted explicitly below, never by authoring order.
const CANONICAL_KEYS: readonly (keyof CanonicalAction)[] = [
  "v",
  "pendingActionId",
  "sessionId",
  "issueRef",
  "actionType",
  "expectedHeadSha",
  "expiresAt",
];

// The numeric fields that bind this document to a specific row. JSON.stringify
// silently turns NaN/Infinity into `null` regardless of the replacer, so an
// upstream coercion bug would otherwise produce a document whose binding field
// is `null` — a silently weaker signature. Caught here instead.
const NUMERIC_KEYS: readonly (keyof CanonicalAction)[] = [
  "pendingActionId",
  "sessionId",
  "expiresAt",
];

/**
 * Deterministic serialization. Keys are sorted explicitly rather than trusted to
 * literal order — a future edit reordering the type would otherwise silently
 * invalidate every signature. Undefined-valued keys are dropped so that "absent"
 * and "explicitly undefined" produce one representation, never `null`. String
 * fields are NFC-normalized so visually identical but differently-encoded
 * unicode (precomposed vs. decomposed) canonicalizes identically.
 */
export function canonicalizeAction(a: CanonicalAction): string {
  for (const k of NUMERIC_KEYS) {
    const v = a[k];
    if (typeof v === "number" && !Number.isFinite(v)) {
      throw new SwitchyardError(
        `canonicalizeAction: ${String(k)} must be a finite number, got ${v}`,
      );
    }
  }

  const doc: Record<string, unknown> = {};
  for (const k of CANONICAL_KEYS) {
    const v = a[k];
    if (v === undefined) continue;
    doc[k] = typeof v === "string" ? v.normalize("NFC") : v;
  }

  const keys = CANONICAL_KEYS.filter((k) => a[k] !== undefined).sort();
  return JSON.stringify(doc, keys);
}
