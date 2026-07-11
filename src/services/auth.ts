import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { actors, loginLinks, sessions } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { hashToken, mintToken } from "./tokens.js";
import { getSetting } from "./settings.js";

const SESSION_TTL = 30 * 24 * 3600;
const nowSec = () => Math.floor(Date.now() / 1000);

export function createLoginLink(db: Db, actorName: string): { token: string; path: string } {
  const actor = db.select().from(actors).where(eq(actors.name, actorName)).get();
  if (!actor) throw new SwitchyardError(`There is no actor named "${actorName}".`);
  if (actor.type !== "human") {
    throw new SwitchyardError(
      `"${actorName}" is an agent — agents authenticate with their bearer token, not login links.`
    );
  }
  const token = mintToken("syl");
  const ttl = getSetting(db, "auth.login_link_ttl_seconds");
  db.insert(loginLinks)
    .values({ tokenHash: hashToken(token), actorId: actor.id, expiresAt: nowSec() + ttl })
    .run();
  return { token, path: `/auth/login?token=${token}` };
}

export function redeemLoginLink(db: Db, token: string): { sessionToken: string; actor: Actor } {
  const row = db.select().from(loginLinks).where(eq(loginLinks.tokenHash, hashToken(token))).get();
  if (!row || row.usedAt !== null || row.expiresAt < nowSec()) {
    throw new SwitchyardError(
      "This login link is invalid, expired, or already used — mint a new one with the switchyard CLI."
    );
  }
  db.update(loginLinks).set({ usedAt: nowSec() }).where(eq(loginLinks.id, row.id)).run();
  const sessionToken = mintToken("sys", 32);
  db.insert(sessions)
    .values({ tokenHash: hashToken(sessionToken), actorId: row.actorId, expiresAt: nowSec() + SESSION_TTL })
    .run();
  const a = db.select().from(actors).where(eq(actors.id, row.actorId)).get()!;
  return { sessionToken, actor: { id: a.id, name: a.name, type: a.type } };
}

export function getSessionActor(db: Db, sessionToken: string): Actor | null {
  const row = db
    .select({ s: sessions, a: actors })
    .from(sessions)
    .innerJoin(actors, eq(sessions.actorId, actors.id))
    .where(eq(sessions.tokenHash, hashToken(sessionToken)))
    .get();
  if (!row || row.s.expiresAt < nowSec()) return null;
  return { id: row.a.id, name: row.a.name, type: row.a.type };
}

export function deleteSession(db: Db, sessionToken: string): void {
  db.delete(sessions).where(eq(sessions.tokenHash, hashToken(sessionToken))).run();
}
