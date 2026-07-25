import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, type IssueView } from "../../src/services/issues.js";
import { openSupervisedSession } from "../../src/services/supervised-sessions.js";
import { createApp } from "../../src/server.js";

let db: Db, human: Actor, agent: Actor, issue: IssueView;
let supToken: string, sessionId: number, agentToken: string;
let server: ReturnType<typeof serve>, baseUrl: string;

/**
 * Drives the REAL /mcp endpoint over real HTTP, using the SDK's own client
 * transport. This is the only test that proves the production wire: a
 * buildMcpServer-level test passes even when /mcp forgets to resolve the
 * supervised principal, which would silently disable the whole hard gate.
 */
async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

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

beforeEach(async () => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  const created = createActor(db, { name: "claude-code", type: "agent" });
  agent = created.actor;
  agentToken = created.token;
  createProject(db, human, { key: "SUP", name: "supervised" });
  const session = openSupervisedSession(db, human, agent.name);
  supToken = session.sessionToken;
  sessionId = session.sessionId;
  issue = createIssue(db, human, { projectKey: "SUP", title: "Wire /mcp" });
  updateIssue(db, human, issue.ref, { status: "todo" });

  server = serve({ fetch: createApp(db).fetch, port: 0 });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("/mcp resolves a supervised principal", () => {
  it("stamps dual attribution on writes made with a sup_ token", async () => {
    const client = await connect(supToken);
    const r = await client.callTool({
      name: "update_issue",
      arguments: { ref: issue.ref, status: "in_review" },
    });
    expect(r.isError).toBeFalsy();

    const ev = latestEvent(issue.id, "status_changed");
    expect(ev.actor_id).toBe(human.id);
    expect(ev.via_agent_id).toBe(agent.id);
    expect(ev.session_id).toBe(sessionId);
    await client.close();
  });

  it("gates done over the real endpoint instead of silently allowing it", async () => {
    const client = await connect(supToken);
    const r = await client.callTool({
      name: "update_issue",
      arguments: { ref: issue.ref, status: "done" },
    });
    // Task 4: parking is a SUCCESS carrying the canonical doc, not an error.
    // What this case pins is that the gate FIRES over the real endpoint — the
    // shape of the parked result is covered in tests/mcp/pending-affirmation.test.ts.
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(text(r)).pendingActionId).toBeGreaterThan(0);

    expect(
      db.all<{ id: number }>(sql`SELECT id FROM pending_actions WHERE status = 'pending'`),
    ).toHaveLength(1);
    expect(
      db.all<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${issue.id}`)[0].status,
    ).toBe("todo");
    await client.close();
  });

  it("whoami reports the accountable human, not the acting agent", async () => {
    const client = await connect(supToken);
    const r = await client.callTool({ name: "whoami", arguments: {} });
    expect(JSON.parse(text(r)).name).toBe("sean");
    await client.close();
  });

  it("leaves a plain agent bearer unattributed (events.sessionId must stay null)", async () => {
    const client = await connect(agentToken);
    const r = await client.callTool({
      name: "comment",
      arguments: { ref: issue.ref, body: "plain session note" },
    });
    expect(r.isError).toBeFalsy();

    // CROSS-TASK INVARIANT: a plain session's id in events.sessionId would make
    // POST /auth/logout FK-500, since deleteSession hard-deletes plain sessions.
    const ev = latestEvent(issue.id, "comment");
    expect(ev.actor_id).toBe(agent.id);
    expect(ev.via_agent_id).toBeNull();
    expect(ev.session_id).toBeNull();
    await client.close();
  });

  it("still rejects an unknown token", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer sup_nope",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
  });
});
