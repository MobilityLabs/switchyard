import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import {
  openSupervisedSession,
  resolveSupervisedPrincipal,
  closeSupervisedSession,
} from "../../src/services/supervised-sessions.js";

let db: Db, human: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
});

describe("openSupervisedSession / resolveSupervisedPrincipal", () => {
  it("binds human+agent into a resolvable principal", () => {
    const { sessionToken } = openSupervisedSession(db, human, "claude-code");
    const principal = resolveSupervisedPrincipal(db, sessionToken);
    expect(principal).not.toBeNull();
    expect(principal!.actor.name).toBe("sean");
    expect(principal!.actor.type).toBe("human");
    expect(principal!.viaAgent?.name).toBe("claude-code");
    expect(principal!.viaAgent?.type).toBe("agent");
  });

  it("refuses a non-human root", () => {
    const agentRoot = createActor(db, { name: "claude/worker", type: "agent" }).actor;
    expect(() => openSupervisedSession(db, agentRoot, "claude-code")).toThrow(
      /only a human can open/i,
    );
  });

  it("refuses a name that pre-exists as human", () => {
    createActor(db, { name: "other-human", type: "human" });
    expect(() => openSupervisedSession(db, human, "other-human")).toThrow(/must be an agent/i);
  });

  it("a closed session doesn't resolve", () => {
    const { sessionToken } = openSupervisedSession(db, human, "claude-code");
    closeSupervisedSession(db, sessionToken);
    expect(resolveSupervisedPrincipal(db, sessionToken)).toBeNull();
  });
});
