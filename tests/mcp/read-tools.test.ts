import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue } from "../../src/services/issues.js";
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

  it("next_task returns the workable issue", async () => {
    const r = await client.callTool({ name: "next_task", arguments: {} });
    expect(JSON.parse(text(r)).ref).toBe("AIPI-1");
  });

  it("errors are agent-legible, not stack traces", async () => {
    const r = await client.callTool({ name: "get_issue", arguments: { ref: "AIPI-99" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/AIPI-99 does not exist/);
    expect(text(r)).not.toMatch(/at .*\.ts/);
  });
});
