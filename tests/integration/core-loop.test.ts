import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { getIssue } from "../../src/services/issues.js";
import { getActivity } from "../../src/services/comments.js";
import { createApp } from "../../src/server.js";

let db: Db, server: ServerType, port: number;
let humanToken: string, agentToken: string;

async function mcpClient(token: string) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
  );
  const c = new Client({ name: "test", version: "0.0.0" });
  await c.connect(transport);
  return c;
}

const text = (r: Awaited<ReturnType<Client["callTool"]>>) =>
  (r.content as { type: string; text: string }[])[0].text;

beforeAll(async () => {
  db = openDb(":memory:");
  humanToken = createActor(db, { name: "sean", type: "human" }).token;
  agentToken = createActor(db, { name: "claude/worker", type: "agent" }).token;
  createProject(db, { key: "AIPI", name: "aipi" });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: createApp(db).fetch, port: 0 }, (info) => {
      port = info.port;
      resolve();
    });
  });
});

afterAll(() => server.close());

describe("core loop over HTTP", () => {
  it("rejects missing or bad tokens", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("agent files -> human accepts -> agent claims, comments, moves to review", async () => {
    const agent = await mcpClient(agentToken);
    const human = await mcpClient(humanToken);

    const filed = JSON.parse(text(await agent.callTool({
      name: "file_issue",
      arguments: {
        project_key: "AIPI", title: "Flaky retry test",
        source_type: "session", source_detail: "session-abc123",
      },
    })));
    expect(filed.status).toBe("triage");

    await human.callTool({
      name: "update_issue",
      arguments: { ref: filed.ref, status: "todo", priority: "high" },
    });

    const next = JSON.parse(text(await agent.callTool({ name: "next_task", arguments: {} })));
    expect(next.ref).toBe(filed.ref);

    await agent.callTool({ name: "claim_issue", arguments: { ref: filed.ref } });
    await agent.callTool({
      name: "comment",
      arguments: { ref: filed.ref, body: "Fixed the retry logic; vitest 14/14 green." },
    });
    await agent.callTool({
      name: "update_issue",
      arguments: { ref: filed.ref, status: "in_review" },
    });

    const final = getIssue(db, filed.ref);
    expect(final.status).toBe("in_review");
    const actorNames = getActivity(db, filed.ref).map((a) => a.actorName);
    expect(actorNames).toContain("sean");
    expect(actorNames).toContain("claude/worker");
  });
});
