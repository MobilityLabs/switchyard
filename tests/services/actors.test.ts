import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor, authenticate } from "../../src/services/actors.js";

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
    expect(() => createActor(db, { name: "sean", type: "human" }))
      .toThrowError(/actor named "sean" already exists/);
  });
});
