import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, type IssueView } from "../../src/services/issues.js";
import { addDependency, listDependencies } from "../../src/services/dependencies.js";
import { setSetting } from "../../src/services/settings.js";
import {
  openSupervisedSession,
  resolveSupervisedPrincipal,
} from "../../src/services/supervised-sessions.js";
import { attributionOf } from "../../src/services/attribution.js";
import type { Principal } from "../../src/services/principal.js";
import { buildMcpServer } from "../../src/mcp/server.js";

let db: Db, human: Actor, agent: Actor, dir: string, prin: Principal, issue: IssueView;

const text = (r: Awaited<ReturnType<Client["callTool"]>>) =>
  (r.content as { type: string; text: string }[])[0].text;

function latestEvent(issueId: number, type: string) {
  const [row] = db.all<{
    actor_id: number;
    via_agent_id: number | null;
    session_id: number | null;
  }>(
    sql`SELECT actor_id, via_agent_id, session_id FROM events WHERE issue_id = ${issueId} AND type = ${type} ORDER BY id DESC LIMIT 1`,
  );
  return row;
}

/** Connects a client to the MCP server as the supervised principal — exactly
 * how /mcp bakes a resolved supervised session into the tool closure. */
async function connectSupervised(): Promise<Client> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(db, prin.actor, dir, undefined, attributionOf(prin), prin.viaAgent).connect(
    st,
  );
  const c = new Client({ name: "test", version: "0.0.0" });
  await c.connect(ct);
  return c;
}

beforeEach(() => {
  db = openDb(":memory:");
  dir = mkdtempSync(path.join(tmpdir(), "syd-supervised-"));
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude-code", type: "agent" }).actor;
  createProject(db, human, { key: "SUP", name: "supervised" });
  const { sessionToken } = openSupervisedSession(db, human, agent.name);
  prin = resolveSupervisedPrincipal(db, sessionToken)!;
  issue = createIssue(db, human, { projectKey: "SUP", title: "Wire the surface" });
  updateIssue(db, human, issue.ref, { status: "todo" });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("MCP write tools in a supervised session", () => {
  it("(a) update_issue -> in_review writes a dual-attributed status_changed event", async () => {
    const client = await connectSupervised();
    const r = await client.callTool({
      name: "update_issue",
      arguments: { ref: issue.ref, status: "in_review" },
    });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r)).status).toBe("in_review");

    const ev = latestEvent(issue.id, "status_changed");
    // The human is accountable; the agent is recorded as the editor.
    expect(ev.actor_id).toBe(human.id);
    expect(ev.via_agent_id).toBe(agent.id);
    expect(ev.session_id).toBe(prin.sessionId);
  });

  it("(b) update_issue -> done is diverted to a pending action, over the real MCP transport", async () => {
    const client = await connectSupervised();
    const r = await client.callTool({
      name: "update_issue",
      arguments: { ref: issue.ref, status: "done" },
    });

    // Task 4: parked is a SUCCESS, not an error — guard() translates the
    // PendingAffirmation signal into an ok() result carrying the canonical doc.
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(text(r)).pendingActionId).toBeGreaterThan(0);

    const rows = db.all<{ id: number; session_id: number; issue_id: number; action_type: string }>(
      sql`SELECT id, session_id, issue_id, action_type FROM pending_actions WHERE status = 'pending'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe(prin.sessionId);
    expect(rows[0].issue_id).toBe(issue.id);
    expect(rows[0].action_type).toBe("done");

    // Nothing was changed — the whole point of parking it.
    const [row] = db.all<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${issue.id}`);
    expect(row.status).toBe("todo");
  });

  it("(c) progress_note succeeds (acting as the via-agent) and carries the session id", async () => {
    const client = await connectSupervised();
    const r = await client.callTool({
      name: "progress_note",
      arguments: { ref: issue.ref, note: "wiring the MCP surface" },
    });
    expect(r.isError).toBeFalsy();

    const ev = latestEvent(issue.id, "progress_note");
    // recordProgressNote requires an agent actor, so the supervised session acts
    // as its via-agent here rather than as the human root.
    expect(ev.actor_id).toBe(agent.id);
    expect(ev.session_id).toBe(prin.sessionId);
  });

  it("does not expose a supervised-session minting tool (the token must stay out of the transcript)", async () => {
    const client = await connectSupervised();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("open_supervised_session");
  });

  it("never accepts client-supplied attribution — session_id/via_agent are server-derived", async () => {
    const client = await connectSupervised();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const props = Object.keys(tool.inputSchema?.properties ?? {});
      expect(props).not.toContain("session_id");
      expect(props).not.toContain("via_agent");
      expect(props).not.toContain("via_agent_id");
    }
  });

  it("remove_dependency via plain agent is refused, but supervised session parks or executes it", async () => {
    // 1. Setup blocker issue and dependency
    const blocker = createIssue(db, human, { projectKey: "SUP", title: "The blocker" });
    addDependency(db, human, blocker.ref, issue.ref);

    // 2. Plain agent via MCP is refused directly
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await buildMcpServer(db, agent, dir).connect(st);
    const plainAgentClient = new Client({ name: "test", version: "0.0.0" });
    await plainAgentClient.connect(ct);

    const rPlain = await plainAgentClient.callTool({
      name: "remove_dependency",
      arguments: { blocker_ref: blocker.ref, blocked_ref: issue.ref },
    });
    expect(rPlain.isError).toBe(true);
    expect(text(rPlain)).toMatch(/Only humans remove dependencies/i);

    // 3. Supervised session with hard-gate action configured parks a pending action
    setSetting(db, human, "supervised.hard_gate_actions", ["dependency.remove"]);
    const client = await connectSupervised();
    const rGated = await client.callTool({
      name: "remove_dependency",
      arguments: { blocker_ref: blocker.ref, blocked_ref: issue.ref },
    });
    expect(rGated.isError).toBeUndefined();
    const parsedGated = JSON.parse(text(rGated));
    expect(parsedGated.pendingActionId).toBeGreaterThan(0);

    const rows = db.all<{ id: number; session_id: number; issue_id: number; action_type: string }>(
      sql`SELECT id, session_id, issue_id, action_type FROM pending_actions WHERE status = 'pending'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action_type).toBe(`dependency.remove:${blocker.ref}`);

    // Edge still exists (nothing was changed)
    expect(listDependencies(db, issue.ref).blockedBy.map((d) => d.ref)).toEqual([blocker.ref]);

    // 4. Supervised session with full absorption (no hard-gate) executes immediately
    setSetting(db, human, "supervised.hard_gate_actions", []);
    const rAbsorb = await client.callTool({
      name: "remove_dependency",
      arguments: { blocker_ref: blocker.ref, blocked_ref: issue.ref },
    });
    expect(rAbsorb.isError).toBeUndefined();

    // Edge is gone!
    expect(listDependencies(db, issue.ref).blockedBy).toEqual([]);
  });
});
