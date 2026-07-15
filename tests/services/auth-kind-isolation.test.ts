import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { openSupervisedSession, closeSupervisedSession } from "../../src/services/supervised-sessions.js";
import { getSessionActor, deleteSession } from "../../src/services/auth.js";

describe("supervised token is not a web/REST credential", () => {
  it("getSessionActor refuses a sup_ token", () => {
    const db = openDb(":memory:");
    const h = createActor(db, { name: "sean", type: "human" }).actor;
    const { sessionToken } = openSupervisedSession(db, h, "claude-code");
    expect(getSessionActor(db, sessionToken)).toBeNull();
  });
  it("deleteSession is inert on a sup_ token (no FK error, session survives via soft-close only)", () => {
    const db = openDb(":memory:");
    const h = createActor(db, { name: "sean", type: "human" }).actor;
    const { sessionToken } = openSupervisedSession(db, h, "claude-code");
    deleteSession(db, sessionToken); // must not throw and must not delete the supervised row
    const n = db.get<{ c: number }>(sql`SELECT COUNT(*) c FROM sessions WHERE kind='supervised'`);
    expect(n!.c).toBe(1);
    closeSupervisedSession(db, sessionToken); // the correct revocation path still works
  });
});
