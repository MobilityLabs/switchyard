import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue } from "../../src/services/issues.js";
import { recordDeliveryEvent } from "../../src/services/delivery-events.js";
import { startAgentSession, endAgentSession } from "../../src/services/agent-sessions.js";
import { buildMcpServer } from "../../src/mcp/server.js";

let db: Db, human: Actor, agent: Actor, client: Client;

async function connect(actor: Actor) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer(db, actor);
  await server.connect(st);
  const c = new Client({ name: "test", version: "0.0.0" });
  await c.connect(ct);
  return c;
}

const text = (r: Awaited<ReturnType<Client["callTool"]>>) =>
  (r.content as { type: string; text: string }[])[0].text;

beforeEach(async () => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, { key: "AIPI", name: "aipi" });
  createIssue(db, human, { projectKey: "AIPI", title: "Ship v1", priority: "high" });
  updateIssue(db, human, "AIPI-1", { status: "todo" });
  client = await connect(agent);
});

describe("MCP read tools", () => {
  it("list_projects returns project keys", async () => {
    const r = await client.callTool({ name: "list_projects", arguments: {} });
    expect(JSON.parse(text(r))[0].key).toBe("AIPI");
  });

  it("get_issue returns the issue by ref", async () => {
    const r = await client.callTool({ name: "get_issue", arguments: { ref: "AIPI-1" } });
    expect(JSON.parse(text(r)).title).toBe("Ship v1");
  });

  it("search_issues applies filters", async () => {
    const r = await client.callTool({
      name: "search_issues",
      arguments: { project_key: "AIPI", status: "todo" },
    });
    expect(JSON.parse(text(r))).toHaveLength(1);
  });

  it("get_issue and search_issues surface an attention flag for an unresolved delivery_failed", async () => {
    recordDeliveryEvent(db, agent, "AIPI-1", {
      type: "delivery_failed",
      message: "merge conflict",
    });

    const got = await client.callTool({ name: "get_issue", arguments: { ref: "AIPI-1" } });
    expect(JSON.parse(text(got)).attention).toEqual({
      reason: "delivery_failed",
      message: "merge conflict",
    });

    const searched = await client.callTool({
      name: "search_issues",
      arguments: { project_key: "AIPI", status: "todo" },
    });
    expect(JSON.parse(text(searched))[0].attention).toEqual({
      reason: "delivery_failed",
      message: "merge conflict",
    });
  });

  it("next_task returns the workable issue", async () => {
    const r = await client.callTool({ name: "next_task", arguments: {} });
    expect(JSON.parse(text(r)).ref).toBe("AIPI-1");
  });

  it("recent_events returns the cross-issue feed newest-first", async () => {
    const r = await client.callTool({ name: "recent_events", arguments: {} });
    const body = JSON.parse(text(r));
    expect(body.truncated).toBe(false);
    expect(body.next_cursor).toBeNull();
    expect(body.events.length).toBeGreaterThanOrEqual(2);
    expect(body.events[0]).toMatchObject({ issue: "AIPI-1" });
    // newest-first: the status-change event (to todo) comes back before the creation event
    expect(body.events[0].type).not.toBe("created");
    expect(body.events[body.events.length - 1].type).toBe("created");
  });

  it("recent_events honors since and before_id paging", async () => {
    const all = JSON.parse(
      text(await client.callTool({ name: "recent_events", arguments: {} })),
    ).events;
    const cutoff = all[all.length - 1].createdAt;

    const since = JSON.parse(
      text(await client.callTool({ name: "recent_events", arguments: { since: cutoff } })),
    );
    expect(since.events.every((e: { createdAt: number }) => e.createdAt > cutoff)).toBe(true);

    const page1 = JSON.parse(
      text(await client.callTool({ name: "recent_events", arguments: { limit: 1 } })),
    );
    expect(page1.events).toHaveLength(1);
    expect(page1.truncated).toBe(true);
    expect(page1.next_cursor).toBe(page1.events[0].id);

    const page2 = JSON.parse(
      text(
        await client.callTool({
          name: "recent_events",
          arguments: { limit: 1, before_id: page1.next_cursor },
        }),
      ),
    );
    expect(page2.events[0].id).toBeLessThan(page1.events[0].id);
  });

  it("whoami returns the actor the calling token authenticates as", async () => {
    const r = await client.callTool({ name: "whoami", arguments: {} });
    expect(JSON.parse(text(r))).toEqual({ id: agent.id, name: "claude/worker", type: "agent" });
  });

  it("whoami reflects a human actor's own token", async () => {
    const humanClient = await connect(human);
    const r = await humanClient.callTool({ name: "whoami", arguments: {} });
    expect(JSON.parse(text(r))).toEqual({ id: human.id, name: "sean", type: "human" });
  });

  it("errors are agent-legible, not stack traces", async () => {
    const r = await client.callTool({ name: "get_issue", arguments: { ref: "AIPI-99" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/AIPI-99 does not exist/);
    expect(text(r)).not.toMatch(/at .*\.ts/);
  });

  it("list_agent_sessions returns sessions joined with their issue ref", async () => {
    startAgentSession(db, agent, { ref: "AIPI-1", mode: "cli", pid: 123 });
    const r = await client.callTool({ name: "list_agent_sessions", arguments: {} });
    const sessions = JSON.parse(text(r));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ ref: "AIPI-1", mode: "cli", pid: 123, status: "running" });
  });

  it("list_agent_sessions active filter excludes exited sessions", async () => {
    const s = startAgentSession(db, agent, { ref: "AIPI-1", mode: "cli" });
    endAgentSession(db, agent, s.id, 0);
    const r = await client.callTool({ name: "list_agent_sessions", arguments: { active: true } });
    expect(JSON.parse(text(r))).toEqual([]);
  });

  it("list_agent_sessions filters by ref", async () => {
    createIssue(db, human, { projectKey: "AIPI", title: "Other work" });
    startAgentSession(db, agent, { ref: "AIPI-1", mode: "cli" });
    startAgentSession(db, agent, { ref: "AIPI-2", mode: "cli" });
    const r = await client.callTool({ name: "list_agent_sessions", arguments: { ref: "AIPI-2" } });
    const sessions = JSON.parse(text(r));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].ref).toBe("AIPI-2");
  });
});
