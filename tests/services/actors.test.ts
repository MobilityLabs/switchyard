import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import {
  createActor,
  authenticate,
  listActorsWithStatus,
  rotateActorToken,
  revokeActorToken,
} from "../../src/services/actors.js";

describe("actors", () => {
  it("creates an actor and returns a usable token exactly once", () => {
    const db = openDb(":memory:");
    const { actor, token } = createActor(db, { name: "claude/aipi-worker", type: "agent" });
    expect(actor.id).toBeGreaterThan(0);
    expect(token).toMatch(/^syd_[0-9a-f]{48}$/);
    expect(authenticate(db, token)?.name).toBe("claude/aipi-worker");
    expect(authenticate(db, "syd_" + "0".repeat(48))).toBeNull();
  });

  it("rejects duplicate names with an agent-legible error", () => {
    const db = openDb(":memory:");
    createActor(db, { name: "sean", type: "human" });
    expect(() => createActor(db, { name: "sean", type: "human" })).toThrowError(
      /actor named "sean" already exists/,
    );
  });

  it("lists actors with token status and no token material", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    createActor(db, { name: "claude/worker", type: "agent" });
    const list = listActorsWithStatus(db);
    expect(list).toHaveLength(2);
    const sean = list.find((a) => a.id === human.id)!;
    expect(sean).toMatchObject({ name: "sean", type: "human", hasToken: true });
    expect(typeof sean.createdAt).toBe("number");
    for (const a of list) {
      expect((a as Record<string, unknown>).tokenHash).toBeUndefined();
      expect((a as Record<string, unknown>).token).toBeUndefined();
    }
  });

  it("rotates a token: old token stops authenticating, new one works", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    const { token: oldToken } = createActor(db, { name: "claude/worker", type: "agent" });
    const worker = authenticate(db, oldToken)!;
    const { token: newToken } = rotateActorToken(db, human, worker.id);
    expect(newToken).toMatch(/^syd_[0-9a-f]{48}$/);
    expect(newToken).not.toBe(oldToken);
    expect(authenticate(db, oldToken)).toBeNull();
    expect(authenticate(db, newToken)?.id).toBe(worker.id);
  });

  it("rejects agents rotating tokens", () => {
    const db = openDb(":memory:");
    const agent = createActor(db, { name: "claude/dev", type: "agent" }).actor;
    const other = createActor(db, { name: "claude/worker", type: "agent" }).actor;
    expect(() => rotateActorToken(db, agent, other.id)).toThrowError(/only humans/i);
  });

  it("errors rotating a token for an unknown actor id", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    expect(() => rotateActorToken(db, human, 999)).toThrowError(/no actor with id 999/i);
  });

  it("revokes a token: the actor can no longer authenticate", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    const { token } = createActor(db, { name: "claude/worker", type: "agent" });
    const worker = authenticate(db, token)!;
    revokeActorToken(db, human, worker.id);
    expect(authenticate(db, token)).toBeNull();
  });

  it("rejects agents revoking tokens", () => {
    const db = openDb(":memory:");
    const agent = createActor(db, { name: "claude/dev", type: "agent" }).actor;
    const other = createActor(db, { name: "claude/worker", type: "agent" }).actor;
    expect(() => revokeActorToken(db, agent, other.id)).toThrowError(/only humans/i);
  });

  it("refuses to let a human revoke their own token", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    expect(() => revokeActorToken(db, human, human.id)).toThrowError(/cannot revoke your own/i);
  });

  it("errors revoking a token for an unknown actor id", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    expect(() => revokeActorToken(db, human, 999)).toThrowError(/no actor with id 999/i);
  });
});
