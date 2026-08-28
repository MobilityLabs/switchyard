import { describe, it, expect, beforeEach } from "vitest";
import { createHuman } from "../helpers/human.js";
import type { HumanActor } from "../../src/services/principal.js";
import { sql } from "drizzle-orm";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue } from "../../src/services/issues.js";
import { recordEvent } from "../../src/services/events.js";
import {
  openSupervisedSession,
  resolveSupervisedPrincipal,
} from "../../src/services/supervised-sessions.js";

let db: Db, human: HumanActor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createHuman(db, "sean");
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "TEST", name: "test" });
  createIssue(db, human, { projectKey: "TEST", title: "Test Issue" });
});

describe("recordEvent attribution", () => {
  it("persists viaAgentId and sessionId when provided", () => {
    // SYD-281: the second argument is an engine; the session mints its own
    // namespaced agent, which is the one whose id lands on the event.
    const { sessionToken, sessionId } = openSupervisedSession(db, human, "claude");
    const supAgent = resolveSupervisedPrincipal(db, sessionToken)!.viaAgent!;

    const eventId = recordEvent(db, {
      issueId: 1,
      actorId: human.id,
      type: "status_changed",
      viaAgentId: supAgent.id,
      sessionId,
    });

    const [row] = db.all<{ via_agent_id: number | null; session_id: number | null }>(
      sql`SELECT via_agent_id, session_id FROM events WHERE id = ${eventId}`,
    );

    expect(row.via_agent_id).toBe(supAgent.id);
    expect(row.session_id).toBe(sessionId);
  });

  it("leaves viaAgentId and sessionId as null when not provided", () => {
    const eventId = recordEvent(db, {
      issueId: 1,
      actorId: human.id,
      type: "status_changed",
    });

    const [row] = db.all<{ via_agent_id: number | null; session_id: number | null }>(
      sql`SELECT via_agent_id, session_id FROM events WHERE id = ${eventId}`,
    );

    expect(row.via_agent_id).toBeNull();
    expect(row.session_id).toBeNull();
  });
});
