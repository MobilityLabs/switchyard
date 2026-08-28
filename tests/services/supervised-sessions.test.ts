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
    // SYD-281: the agent is namespaced <engine>/supervised/<human>, so a session
    // can never bind to a dispatch worker's own actor.
    expect(principal!.viaAgent?.name).toBe("claude-code/supervised/sean");
    expect(principal!.viaAgent?.type).toBe("agent");
    // Attended by definition — a person is driving this agent, which is exactly
    // what the flag means for the interactive queue.
    expect(principal!.viaAgent?.attended).toBe(true);
  });

  it("namespaces away from a dispatch worker's actor", () => {
    const dispatch = createActor(db, { name: "claude/dev", type: "agent" }).actor;
    const { sessionToken } = openSupervisedSession(db, human, "claude");
    const principal = resolveSupervisedPrincipal(db, sessionToken)!;
    // Binding to claude/dev is what would collapse assertClaimable once the
    // agent holds the claim: same actor id => the guard early-returns and
    // claimIssue offers takeover instead of refusing.
    expect(principal.viaAgent!.id).not.toBe(dispatch.id);
    expect(principal.viaAgent!.name).toBe("claude/supervised/sean");
    // callerClassification splits on "/" and must still see the engine.
    expect(principal.viaAgent!.name.split("/")[0]).toBe("claude");
  });

  it("refuses an engine argument that is really an actor name", () => {
    expect(() => openSupervisedSession(db, human, "claude/dev")).toThrow(/engine name/i);
  });

  it("refuses a non-human root", () => {
    const agentRoot = createActor(db, { name: "claude/worker", type: "agent" }).actor;
    expect(() => openSupervisedSession(db, agentRoot, "claude-code")).toThrow(
      /only a human can open/i,
    );
  });

  it("refuses an engine whose namespaced actor pre-exists as a non-agent", () => {
    createActor(db, { name: "other/supervised/sean", type: "human" });
    expect(() => openSupervisedSession(db, human, "other")).toThrow(/must be an agent/i);
  });

  it("a closed session doesn't resolve", () => {
    const { sessionToken } = openSupervisedSession(db, human, "claude-code");
    closeSupervisedSession(db, sessionToken);
    expect(resolveSupervisedPrincipal(db, sessionToken)).toBeNull();
  });
});
