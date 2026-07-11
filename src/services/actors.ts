import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { actors } from "../db/schema.js";
import { SwitchyardError } from "./errors.js";
import { hashToken, mintToken } from "./tokens.js";

export type Actor = { id: number; name: string; type: "human" | "agent" };
export type ActorWithStatus = Actor & { createdAt: number; hasToken: boolean };

function requireHuman(actor: Actor, action: string): void {
  if (actor.type !== "human") {
    throw new SwitchyardError(`Only humans can ${action} — agents should ask a human to do this.`);
  }
}

export function createActor(
  db: Db,
  input: { name: string; type: "human" | "agent" }
): { actor: Actor; token: string } {
  const existing = db.select().from(actors).where(eq(actors.name, input.name)).get();
  if (existing) {
    throw new SwitchyardError(
      `An actor named "${input.name}" already exists — pick a different name or use the existing actor's token.`
    );
  }
  const token = mintToken("syd");
  const row = db
    .insert(actors)
    .values({ name: input.name, type: input.type, tokenHash: hashToken(token) })
    .returning()
    .get();
  return { actor: { id: row.id, name: row.name, type: row.type }, token };
}

export function authenticate(db: Db, token: string): Actor | null {
  const row = db.select().from(actors).where(eq(actors.tokenHash, hashToken(token))).get();
  return row ? { id: row.id, name: row.name, type: row.type } : null;
}

/**
 * Finds or creates a token-less actor for attributing events from a system
 * that doesn't authenticate through Switchyard (e.g. the GitHub webhook
 * receiver) — unlike createActor, this never throws on an existing name.
 */
export function getOrCreateActor(db: Db, name: string, type: "human" | "agent"): Actor {
  const existing = db.select().from(actors).where(eq(actors.name, name)).get();
  if (existing) return { id: existing.id, name: existing.name, type: existing.type };
  const row = db.insert(actors).values({ name, type }).returning().get();
  return { id: row.id, name: row.name, type: row.type };
}

export function getActorById(db: Db, id: number): Actor {
  const row = db.select().from(actors).where(eq(actors.id, id)).get();
  if (!row) throw new SwitchyardError(`There is no actor with id ${id}.`);
  return { id: row.id, name: row.name, type: row.type };
}

export function listActorsWithStatus(db: Db): ActorWithStatus[] {
  return db
    .select()
    .from(actors)
    .all()
    .map((r) => ({ id: r.id, name: r.name, type: r.type, createdAt: r.createdAt, hasToken: r.tokenHash !== null }));
}

/** Mints a fresh token for an existing actor, invalidating the old one. Human-only. */
export function rotateActorToken(db: Db, actor: Actor, actorId: number): { token: string } {
  requireHuman(actor, "rotate an actor's token");
  getActorById(db, actorId);
  const token = mintToken("syd");
  db.update(actors).set({ tokenHash: hashToken(token) }).where(eq(actors.id, actorId)).run();
  return { token };
}

/** Nulls out an actor's token hash, so it can no longer authenticate. Human-only. */
export function revokeActorToken(db: Db, actor: Actor, actorId: number): void {
  requireHuman(actor, "revoke an actor's token");
  if (actorId === actor.id) {
    throw new SwitchyardError(
      "You cannot revoke your own actor's token — sign in as a different human actor to do this."
    );
  }
  getActorById(db, actorId);
  db.update(actors).set({ tokenHash: null }).where(eq(actors.id, actorId)).run();
}
