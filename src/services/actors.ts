import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { actors } from "../db/schema.js";
import { SwitchyardError } from "./errors.js";
import { hashToken, mintToken } from "./tokens.js";

export type Actor = { id: number; name: string; type: "human" | "agent" };

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
