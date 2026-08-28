import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type Db } from "../../src/db/index.js";
import { actors } from "../../src/db/schema.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { asHuman, actingAgent, effectiveActor } from "../../src/services/principal.js";
import { NO_SESSION, type Attribution } from "../../src/services/attribution.js";
import { SwitchyardError } from "../../src/services/errors.js";

let db: Db, human: Actor, agent: Actor, service: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  service = createActor(db, { name: "poller", type: "service" }).actor;
});

/** The attribution a supervised session carries. */
const supervised = (agentId: number): Attribution => ({ sessionId: 1, viaAgentId: agentId });

describe("asHuman — who authorizes", () => {
  it("returns the human when nothing indicates a session", () => {
    expect(asHuman(human, NO_SESSION)?.id).toBe(human.id);
  });

  it("is null inside a supervised session — presence is not consent", () => {
    expect(asHuman(human, supervised(agent.id))).toBeNull();
  });

  it("is null when only sessionId is set", () => {
    expect(asHuman(human, { sessionId: 1 })).toBeNull();
  });

  it("is null when only viaAgentId is set — the fields are typed independently", () => {
    expect(asHuman(human, { viaAgentId: agent.id })).toBeNull();
  });

  it("is null for an agent and for a service actor", () => {
    expect(asHuman(agent, NO_SESSION)).toBeNull();
    expect(asHuman(service, NO_SESSION)).toBeNull();
  });
});

describe("actingAgent — whose credential", () => {
  it("returns the actor itself for a plain agent session", () => {
    expect(actingAgent(db, agent, NO_SESSION)?.id).toBe(agent.id);
  });

  it("resolves viaAgentId in a supervised session, not the accountable human", () => {
    expect(actingAgent(db, human, supervised(agent.id))?.id).toBe(agent.id);
  });

  it("is null for a human with no session", () => {
    expect(actingAgent(db, human, NO_SESSION)).toBeNull();
  });

  it("is null for a service actor", () => {
    expect(actingAgent(db, service, NO_SESSION)).toBeNull();
  });

  it("is null — not a throw — when the referenced row is gone", () => {
    expect(actingAgent(db, human, supervised(9999))).toBeNull();
  });

  it("is null when the referenced actor is no longer typed agent", () => {
    db.update(actors).set({ type: "service" }).where(eq(actors.id, agent.id)).run();
    expect(actingAgent(db, human, supervised(agent.id))).toBeNull();
  });
});

describe("effectiveActor — whose name goes on the row", () => {
  it("returns the acting agent in a supervised session", () => {
    expect(effectiveActor(db, human, supervised(agent.id)).id).toBe(agent.id);
  });

  it("returns the actor when no session is indicated", () => {
    expect(effectiveActor(db, human, NO_SESSION).id).toBe(human.id);
    expect(effectiveActor(db, agent, NO_SESSION).id).toBe(agent.id);
  });

  it("THROWS when ctx says supervised but the agent row is gone", () => {
    // Falling back to the human here would silently restore the state this
    // work exists to remove, and asHuman is null too — the write would be
    // neither authorized as a human nor represented as an agent.
    expect(() => effectiveActor(db, human, supervised(9999))).toThrow(SwitchyardError);
  });

  it("THROWS when the agent row was retyped after the session was minted", () => {
    db.update(actors).set({ type: "service" }).where(eq(actors.id, agent.id)).run();
    expect(() => effectiveActor(db, human, supervised(agent.id))).toThrow(/no longer resolves/);
  });
});
