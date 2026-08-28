import { eq } from "drizzle-orm";
import type { DbOrTx } from "../db/index.js";
import { actors } from "../db/schema.js";
import type { Actor } from "./actors.js";
import type { Attribution } from "./attribution.js";
import { SwitchyardError } from "./errors.js";

/**
 * The acting identity behind a write. `actor` is always the accountable
 * root (a human for supervised sessions, the authenticated actor otherwise).
 * `viaAgent`/`sessionId` are set only when the write happened inside a
 * supervised session, and drive the dual-attribution fields on events
 * (src/db/schema.ts: events.viaAgentId/sessionId).
 *
 * SYD-281: `actor` answers "who is accountable". It does NOT answer "who is
 * authorizing", "whose credential is this", or "whose name goes on the row".
 * Those are `asHuman`, `actingAgent` and `effectiveActor` below — a supervised
 * principal is typed human and is not typed agent, so it passed gates of both
 * shapes until they were split apart.
 */
export type Principal = { actor: Actor; viaAgent?: Actor; sessionId?: number };

declare const humanBrand: unique symbol;
/**
 * An `Actor` a human is *currently acting as* — mintable only by `asHuman`.
 * Human-only services take this instead of `Actor`, so passing an unproven
 * actor is a compile error and a future gate cannot be written wrong by
 * accident.
 *
 * The brand is erased at runtime, so it is compile-time defence in depth, not
 * the enforcement: the runtime predicate lives in the adapters that call
 * `asHuman` and throw. Banning `as HumanActor` (eslint.config.js) does not stop
 * `f(x as any)`, so this is a legibility control at the same tier as
 * NO_SESSION.
 */
export type HumanActor = Actor & { readonly [humanBrand]: true };

const isSupervised = (ctx: Attribution): boolean => ctx.sessionId != null || ctx.viaAgentId != null;

/**
 * (1) Who authorizes this write — the human who is ACTING, as distinct from
 * the human who is ACCOUNTABLE (`Principal.actor`).
 *
 * Null inside a supervised session: presence is not consent for everything
 * that follows. Keyed on BOTH `sessionId` and `viaAgentId` because `Principal`
 * types them independently — they coincide today only because src/server.ts
 * withholds attribution from plain sessions for an FK/logout reason, not an
 * authorization one, so a future principal carrying one without the other must
 * not fail open.
 */
export function asHuman(actor: Actor, ctx: Attribution): HumanActor | null {
  if (isSupervised(ctx)) return null;
  return actor.type === "human" ? (actor as HumanActor) : null;
}

/**
 * `asHuman` or throw — the one runtime chokepoint the six private `requireHuman`
 * helpers collapsed into (settings, actors, projects, webhooks, github-repos,
 * triage-actions each had their own, all asking `type !== "human"`, which is the
 * question that returns the wrong answer for a supervised principal).
 *
 * Adapters call this and hand the result to the service. That is what makes the
 * brand honest: the type says "a human was proven to be acting", and this is the
 * only place outside `asHuman` where that proof is produced.
 */
export function requireHuman(actor: Actor, ctx: Attribution, action: string): HumanActor {
  const human = asHuman(actor, ctx);
  if (!human) {
    throw new SwitchyardError(`Only humans can ${action} — agents should ask a human to do this.`);
  }
  return human;
}

/**
 * (2) Whose credential is acting — the identity whose claim and lease govern
 * this write. In a supervised session that is the agent, never the accountable
 * human, who holds no lease.
 *
 * Returns null rather than throwing on a missing or retyped row: getActorById
 * throws, which would turn "no agent is acting" into a 500. The type is
 * re-checked at use, mirroring resolveSupervisedPrincipal, so a role change
 * after the session was minted cannot launder an agent path.
 */
export function actingAgent(db: DbOrTx, actor: Actor, ctx: Attribution): Actor | null {
  if (ctx.viaAgentId != null) {
    const row = db.select().from(actors).where(eq(actors.id, ctx.viaAgentId)).get();
    if (!row || row.type !== "agent") return null;
    return { id: row.id, name: row.name, type: row.type, attended: row.attended };
  }
  return actor.type === "agent" ? actor : null;
}

/**
 * (3) Whose name goes on the row — the identity written to row-identity
 * columns: issues.assigneeId, issues.creatorId, pr_links.declaredBy,
 * claim_leases.actorId.
 *
 * NOT for events.actorId, pendingActions.affirmedById, or attachments.actorId:
 * those keep the accountable human, with the agent on the paired viaAgentId.
 * Applying this to an event would collapse dual attribution.
 *
 * FAILS CLOSED. When ctx says supervised but no agent resolves, falling back to
 * `actor` would silently restore the human-as-holder state this work exists to
 * remove — and since asHuman is null there too, the write would be neither
 * authorized as a human nor represented as an agent. Unreachable in production
 * (resolveSupervisedPrincipal re-checks and 401s first, and nothing in src/
 * deletes or retypes an actor), so this is correct dead code.
 *
 * Resolve it ONCE at function entry, not per branch — otherwise the fail-closed
 * guarantee is branch-dependent, and a patch touching only `priority` would
 * write as the human where a status patch throws.
 */
export function effectiveActor(db: DbOrTx, actor: Actor, ctx: Attribution): Actor {
  const agent = actingAgent(db, actor, ctx);
  if (agent) return agent;
  if (isSupervised(ctx)) {
    throw new SwitchyardError(
      "This supervised session's agent actor no longer resolves — re-open the session.",
    );
  }
  return actor;
}
