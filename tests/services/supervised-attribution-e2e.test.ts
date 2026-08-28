import { describe, it, expect, beforeEach } from "vitest";
import { createHuman } from "../helpers/human.js";
import type { HumanActor } from "../../src/services/principal.js";
import { sql } from "drizzle-orm";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue } from "../../src/services/issues.js";
import { openSupervisedSession } from "../../src/services/supervised-sessions.js";
import { attributionOf } from "../../src/services/attribution.js";

let db: Db, human: HumanActor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createHuman(db, "sean");
  agent = createActor(db, { name: "claude-code", type: "agent" }).actor;
  createProject(db, human, { key: "SUP", name: "supervised" });
});

function latestEvent(db: Db, issueId: number, type: string) {
  const [row] = db.all<{
    actor_id: number;
    via_agent_id: number | null;
    session_id: number | null;
  }>(
    sql`SELECT actor_id, via_agent_id, session_id FROM events WHERE issue_id = ${issueId} AND type = ${type} ORDER BY id DESC LIMIT 1`,
  );
  return row;
}

describe("supervised attribution end-to-end", () => {
  it("(a) createIssue + updateIssue->in_review write attributed events", () => {
    const { sessionId } = openSupervisedSession(db, human, agent.name);
    const attr = attributionOf({ actor: human, viaAgent: agent, sessionId });

    // SYD-281: a supervised session is on the agent path, so "agent-created
    // issues land in triage with required provenance" (CLAUDE.md) now applies to
    // it — it used to file straight into backlog with neither.
    expect(() =>
      createIssue(db, human, { projectKey: "SUP", title: "Do the thing" }, attr),
    ).toThrow(/provenance/i);

    const issue = createIssue(
      db,
      human,
      {
        projectKey: "SUP",
        title: "Do the thing",
        description: "Something a human can triage from.",
        provenance: { sourceType: "session", detail: "src/api.ts:88" },
      },
      attr,
    );
    expect(issue.status).toBe("triage");
    expect(issue.creatorId).toBe(agent.id);

    const created = latestEvent(db, issue.id, "created");
    // The row identity is the agent; the AUDIT identity stays the accountable
    // human, with the agent on viaAgentId. That split is the whole design.
    expect(created.actor_id).toBe(human.id);
    expect(created.via_agent_id).toBe(agent.id);
    expect(created.session_id).toBe(sessionId);

    // A human moves it out of triage, then the session claims and works it.
    updateIssue(db, human, issue.ref, { status: "todo" });
    const { leaseToken } = claimIssue(db, human, issue.ref, {}, attr);
    updateIssue(db, human, issue.ref, { status: "in_review" }, { presented: leaseToken }, attr);

    const statusChanged = latestEvent(db, issue.id, "status_changed");
    expect(statusChanged.via_agent_id).toBe(agent.id);
    expect(statusChanged.session_id).toBe(sessionId);
  });

  it("(b) supervised claimIssue attributes the delegated assigned/status_changed event", () => {
    const { sessionId } = openSupervisedSession(db, human, agent.name);
    const attr = attributionOf({ actor: human, viaAgent: agent, sessionId });

    const issue = createIssue(db, human, { projectKey: "SUP", title: "Claim me" });
    updateIssue(db, human, issue.ref, { status: "todo" });

    claimIssue(db, human, issue.ref, {}, attr);

    const assigned = latestEvent(db, issue.id, "assigned");
    expect(assigned.via_agent_id).toBe(agent.id);
    expect(assigned.session_id).toBe(sessionId);

    const statusChanged = latestEvent(db, issue.id, "status_changed");
    expect(statusChanged.via_agent_id).toBe(agent.id);
    expect(statusChanged.session_id).toBe(sessionId);
  });
});
