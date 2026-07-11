import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type Db } from "../../src/db/index.js";
import { loginLinks, actors } from "../../src/db/schema.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { setSetting } from "../../src/services/settings.js";
import {
  createLoginLink, redeemLoginLink, getSessionActor, deleteSession,
} from "../../src/services/auth.js";

let db: Db, human: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  createActor(db, { name: "claude/dev", type: "agent" });
});

describe("auth", () => {
  it("mints a link, redeems it once, and the session authenticates", () => {
    const { token, path } = createLoginLink(db, "sean");
    expect(token).toMatch(/^syl_[0-9a-f]{48}$/);
    expect(path).toBe(`/auth/login?token=${token}`);
    const { sessionToken, actor } = redeemLoginLink(db, token);
    expect(sessionToken).toMatch(/^sys_[0-9a-f]{64}$/);
    expect(actor.name).toBe("sean");
    expect(getSessionActor(db, sessionToken)?.name).toBe("sean");
    // single use
    expect(() => redeemLoginLink(db, token)).toThrowError(/invalid, expired, or already used/i);
    deleteSession(db, sessionToken);
    expect(getSessionActor(db, sessionToken)).toBeNull();
  });

  it("rejects agents and unknown actors", () => {
    expect(() => createLoginLink(db, "claude/dev")).toThrowError(/agents authenticate with their bearer token/i);
    expect(() => createLoginLink(db, "ghost")).toThrowError(/no actor named "ghost"/i);
    expect(getSessionActor(db, "sys_" + "0".repeat(64))).toBeNull();
  });

  it("respects a custom auth.login_link_ttl_seconds setting (knob bite)", () => {
    setSetting(db, human, "auth.login_link_ttl_seconds", 60);
    const before = Math.floor(Date.now() / 1000);
    const { token } = createLoginLink(db, "sean");
    const row = db.select().from(loginLinks).all().find((r) => r.actorId === human.id)!;
    expect(row.expiresAt).toBeGreaterThanOrEqual(before + 60);
    expect(row.expiresAt).toBeLessThan(before + 15 * 60); // well under the 15m default
    expect(token).toMatch(/^syl_[0-9a-f]{48}$/);
  });

  it("redeemLoginLink throws SwitchyardError instead of crashing if the actor was deleted from under the link (SYD-146)", () => {
    const { token } = createLoginLink(db, "sean");
    const sean = db.select().from(actors).where(eq(actors.name, "sean")).get()!;
    // FK enforcement would normally block this; simulate the data drifting out
    // from under the link so the missing-actor guard in redeemLoginLink is reachable.
    (db as unknown as { $client: { pragma(source: string): unknown } }).$client.pragma("foreign_keys = OFF");
    db.delete(actors).where(eq(actors.id, sean.id)).run();
    expect(() => redeemLoginLink(db, token)).toThrowError(/references a missing actor/i);
  });
});
