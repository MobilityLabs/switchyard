import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { actors } from "../db/schema.js";
import { SwitchyardError } from "./errors.js";
import { hashToken, mintToken } from "./tokens.js";

export type ActorType = "human" | "agent" | "service";
/** `attended` = a person is watching this caller (see actors.attended). */
export type Actor = { id: number; name: string; type: ActorType; attended: boolean };
export type ActorWithStatus = Actor & { createdAt: number; hasToken: boolean };

function requireHuman(actor: Actor, action: string): void {
  if (actor.type !== "human") {
    throw new SwitchyardError(`Only humans can ${action} — agents should ask a human to do this.`);
  }
}

export function createActor(
  db: Db,
  input: { name: string; type: ActorType; attended?: boolean },
): { actor: Actor; token: string } {
  const existing = db.select().from(actors).where(eq(actors.name, input.name)).get();
  if (existing) {
    throw new SwitchyardError(
      `An actor named "${input.name}" already exists — pick a different name or use the existing actor's token.`,
    );
  }
  const token = mintToken("syd");
  const row = db
    .insert(actors)
    .values({
      name: input.name,
      type: input.type,
      // A human IS the attended caller, so it needs no flag. Anything else
      // defaults to unattended: the flag only ever WITHHOLDS work, so failing
      // closed costs a routing miss rather than handing a headless worker
      // something it cannot finish.
      attended: input.attended ?? input.type === "human",
      tokenHash: hashToken(token),
    })
    .returning()
    .get();
  return { actor: { id: row.id, name: row.name, type: row.type, attended: row.attended }, token };
}

export function authenticate(db: Db, token: string): Actor | null {
  const row = db
    .select()
    .from(actors)
    .where(eq(actors.tokenHash, hashToken(token)))
    .get();
  return row ? { id: row.id, name: row.name, type: row.type, attended: row.attended } : null;
}

/**
 * Finds or creates a token-less actor for attributing events from a system
 * that doesn't authenticate through Switchyard (e.g. the GitHub webhook
 * receiver) — unlike createActor, this never throws on an existing name.
 */
export function getOrCreateActor(db: Db, name: string, type: ActorType): Actor {
  const existing = db.select().from(actors).where(eq(actors.name, name)).get();
  if (existing)
    return {
      id: existing.id,
      name: existing.name,
      type: existing.type,
      attended: existing.attended,
    };
  const row = db.insert(actors).values({ name, type }).returning().get();
  return { id: row.id, name: row.name, type: row.type, attended: row.attended };
}

export function getActorById(db: Db, id: number): Actor {
  const row = db.select().from(actors).where(eq(actors.id, id)).get();
  if (!row) throw new SwitchyardError(`There is no actor with id ${id}.`);
  return { id: row.id, name: row.name, type: row.type, attended: row.attended };
}

export function listActorsWithStatus(db: Db): ActorWithStatus[] {
  return db
    .select()
    .from(actors)
    .all()
    .map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      attended: r.attended,
      createdAt: r.createdAt,
      hasToken: r.tokenHash !== null,
    }));
}

/**
 * Marks whether a person is watching this actor's sessions (see
 * actors.attended). Human-only, because it decides which work `next_task`
 * hands out and a caller must not be able to widen its own queue.
 *
 * Not a privilege: `attended` gates routing only, never authority —
 * requireHuman never reads it, so flipping it on cannot let an agent take a
 * human-only action. It only stops nextTask withholding `interactive` work
 * from a session that can actually finish it.
 *
 * Refused for humans, who are attended by definition — silently accepting a
 * flag that changes nothing would imply it could be turned off.
 */
export function setActorAttended(db: Db, actor: Actor, actorId: number, attended: boolean): Actor {
  requireHuman(actor, "change whether an actor is attended");
  const target = getActorById(db, actorId);
  if (target.type === "human") {
    throw new SwitchyardError(
      `${target.name} is a human and is attended by definition — the flag is for agent sessions a person is driving.`,
    );
  }
  db.update(actors).set({ attended }).where(eq(actors.id, actorId)).run();
  return { ...target, attended };
}

/** Mints a fresh token for an existing actor, invalidating the old one. Human-only. */
export function rotateActorToken(db: Db, actor: Actor, actorId: number): { token: string } {
  requireHuman(actor, "rotate an actor's token");
  getActorById(db, actorId);
  const token = mintToken("syd");
  db.update(actors)
    .set({ tokenHash: hashToken(token) })
    .where(eq(actors.id, actorId))
    .run();
  return { token };
}

/** Nulls out an actor's token hash, so it can no longer authenticate. Human-only. */
export function revokeActorToken(db: Db, actor: Actor, actorId: number): void {
  requireHuman(actor, "revoke an actor's token");
  if (actorId === actor.id) {
    throw new SwitchyardError(
      "You cannot revoke your own actor's token — sign in as a different human actor to do this.",
    );
  }
  getActorById(db, actorId);
  db.update(actors).set({ tokenHash: null }).where(eq(actors.id, actorId)).run();
}
