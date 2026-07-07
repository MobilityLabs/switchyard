import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { getIssue } from "../../src/services/issues.js";
import { buildMcpServer } from "../../src/mcp/server.js";

let db: Db, human: Actor, agent: Actor, client: Client;

async function connect(actor: Actor) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(db, actor).connect(st);
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
  client = await connect(agent);
});

describe("MCP write tools", () => {
  it("file_issue creates a triage issue with provenance", async () => {
    const r = await client.callTool({
      name: "file_issue",
      arguments: {
        project_key: "AIPI",
        title: "Flaky test in api suite",
        source_type: "todo",
        source_detail: "src/api.ts:88",
      },
    });
    const issue = JSON.parse(text(r));
    expect(issue.status).toBe("triage");
    expect(getIssue(db, issue.ref).sourceDetail).toBe("src/api.ts:88");
  });

  it("claim, comment, and move to in_review as an agent", async () => {
    const humanClient = await connect(human);
    await humanClient.callTool({
      name: "file_issue",
      arguments: { project_key: "AIPI", title: "Ship v1" },
    });
    // human-created issues start in backlog; move to todo, then agent claims
    await humanClient.callTool({
      name: "update_issue",
      arguments: { ref: "AIPI-1", status: "todo" },
    });
    const claimed = JSON.parse(text(await client.callTool({
      name: "claim_issue", arguments: { ref: "AIPI-1" },
    })));
    expect(claimed.status).toBe("in_progress");
    await client.callTool({
      name: "comment",
      arguments: { ref: "AIPI-1", body: "Done, verified: 3 tests pass." },
    });
    const reviewed = JSON.parse(text(await client.callTool({
      name: "update_issue", arguments: { ref: "AIPI-1", status: "in_review" },
    })));
    expect(reviewed.status).toBe("in_review");
  });

  it("add_dependency makes next_task skip the blocked issue", async () => {
    const humanClient = await connect(human);
    for (const title of ["Schema", "API"]) {
      await humanClient.callTool({ name: "file_issue", arguments: { project_key: "AIPI", title } });
    }
    for (const ref of ["AIPI-1", "AIPI-2"]) {
      await humanClient.callTool({ name: "update_issue", arguments: { ref, status: "todo" } });
    }
    await client.callTool({
      name: "add_dependency",
      arguments: { blocker_ref: "AIPI-1", blocked_ref: "AIPI-2" },
    });
    const r = await client.callTool({ name: "claim_issue", arguments: { ref: "AIPI-2" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/blocked by AIPI-1/);
  });

  it("triage_queue lists triage issues with provenance", async () => {
    await client.callTool({
      name: "file_issue",
      arguments: { project_key: "AIPI", title: "A", source_type: "manual", source_detail: "x" },
    });
    const r = await client.callTool({ name: "triage_queue", arguments: {} });
    const queue = JSON.parse(text(r));
    expect(queue).toHaveLength(1);
    expect(queue[0].sourceType).toBe("manual");
  });
});
