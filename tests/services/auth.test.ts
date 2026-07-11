import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import {
  createLoginLink,
  redeemLoginLink,
  getSessionActor,
  deleteSession,
} from "../../src/services/auth.js";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
  createActor(db, { name: "sean", type: "human" });
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
    expect(() => createLoginLink(db, "claude/dev")).toThrowError(
      /agents authenticate with their bearer token/i,
    );
    expect(() => createLoginLink(db, "ghost")).toThrowError(/no actor named "ghost"/i);
    expect(getSessionActor(db, "sys_" + "0".repeat(64))).toBeNull();
  });
});
