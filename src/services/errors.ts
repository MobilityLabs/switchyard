// TYPE-ONLY import, deliberately: ./canonical-action imports SwitchyardError
// from this module, so a value import here would close a runtime require cycle.
// `import type` is erased at compile time, leaving this module a runtime leaf —
// which is what canonical-action.ts's header comment relies on.
import type { CanonicalAction } from "./canonical-action.js";

export class SwitchyardError extends Error {}

/**
 * A gated action was parked and awaits a human's signed affirmation.
 *
 * NOT a SwitchyardError subclass, deliberately: "parked" is a SUCCESS, and
 * overloading one class to mean both "you did something wrong" and "this is
 * fine, wait" is the collision worth avoiding. It is also not a return-type
 * union — that would ripple through every updateIssue caller to add a branch
 * that is unreachable for most of them (affirmPendingAction re-drives
 * updateIssue with attr={}, which cannot divert), and unreachable branches rot.
 *
 * RISK: this extends Error, so it propagates as a real 500 through any
 * `catch (e) { if (e instanceof SwitchyardError) ... else throw }`. The
 * translation in guard() (src/mcp/server.ts) is therefore NOT optional; a test
 * pins it. The matching arm in src/rest/api-routes.ts's onError is a tripwire
 * for a REST surface that cannot reach this today — see the comment there.
 */
export type PendingAffirmationView = {
  pendingActionId: number;
  /** The exact bytes to sign. */
  canonical: string;
  /** The same content, parsed, for rendering. */
  action: CanonicalAction;
  instructions: string;
};

export class PendingAffirmation extends Error {
  constructor(readonly pending: PendingAffirmationView) {
    super(`Awaiting human affirmation (pending action #${pending.pendingActionId}).`);
    this.name = "PendingAffirmation";
  }
}
