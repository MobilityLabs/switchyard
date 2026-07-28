import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { actors, sessions } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { getOrCreateActor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { hashToken, mintToken } from "./tokens.js";
import type { Principal } from "./principal.js";

export const SUPERVISED_TTL = 12 * 3600;
const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Opens a supervised interactive session: binds a human root to an agent
 * acting on their behalf. The minted `sup_` token is a CLI-only handshake
 * credential — it must never reach the web/REST cookie path (see the
 * `kind='plain'` filters in auth.ts's getSessionActor/deleteSession).
 */
export function openSupervisedSession(
  db: Db,
  human: Actor,
  agentName: string,
): { sessionToken: string; sessionId: number } {
  if (human.type !== "human") {
    throw new SwitchyardError("Only a human can open a supervised session.");
  }
  const agent = getOrCreateActor(db, agentName, "agent");
  if (agent.type !== "agent") {
    throw new SwitchyardError(
      `"${agentName}" must be an agent to act as a supervised session's editor — it already exists as a ${agent.type}.`,
    );
  }
  const sessionToken = mintToken("sup", 32);
  const row = db
    .insert(sessions)
    .values({
      tokenHash: hashToken(sessionToken),
      actorId: human.id,
      kind: "supervised",
      viaAgentId: agent.id,
      expiresAt: nowSec() + SUPERVISED_TTL,
    })
    .returning()
    .get();
  return { sessionToken, sessionId: row.id };
}

/**
 * Resolves a supervised token to its dual-attribution principal. Re-fetches
 * both actors' current types (not just their ids at mint time) so a role
 * change after minting can't silently corrupt provenance.
 */
export function resolveSupervisedPrincipal(db: Db, sessionToken: string): Principal | null {
  const row = db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, hashToken(sessionToken)),
        eq(sessions.kind, "supervised"),
        isNull(sessions.closedAt),
      ),
    )
    .get();
  if (!row || row.expiresAt < nowSec() || row.viaAgentId === null) return null;

  const human = db.select().from(actors).where(eq(actors.id, row.actorId)).get();
  const agent = db.select().from(actors).where(eq(actors.id, row.viaAgentId)).get();
  if (!human || !agent || human.type !== "human" || agent.type !== "agent") return null;

  return {
    actor: { id: human.id, name: human.name, type: human.type, attended: human.attended },
    viaAgent: { id: agent.id, name: agent.name, type: agent.type, attended: agent.attended },
    sessionId: row.id,
  };
}

/** Soft-closes a supervised session. Never DELETEs — sessions.id is an FK
 * target (events.sessionId), so a hard delete would 500 once the session has
 * written any events. */
export function closeSupervisedSession(db: Db, sessionToken: string): void {
  db.update(sessions)
    .set({ closedAt: nowSec() })
    .where(and(eq(sessions.tokenHash, hashToken(sessionToken)), eq(sessions.kind, "supervised")))
    .run();
}
