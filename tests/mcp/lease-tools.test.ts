import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue } from "../../src/services/issues.js";
import { buildMcpServer } from "../../src/mcp/server.js";

let db: Db, human: Actor, agent: Actor;
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
  createProject(db, human, { key: "AIPI", name: "aipi" });
  createIssue(db, human, { projectKey: "AIPI", title: "t" });
  updateIssue(db, human, "AIPI-1", { status: "todo" });
});

describe("MCP lease enforcement", () => {
  it("claim_issue returns a lease_token", async () => {
    const c = await connect(agent);
    const res = JSON.parse(text(await c.callTool({ name: "claim_issue", arguments: { ref: "AIPI-1" } })));
    expect(res.lease_token).toMatch(/^lease_/);
    expect(res.status).toBe("in_progress");
  });

  it("a second session with the shared bearer token but no lease cannot update_issue", async () => {
    const a = await connect(agent);
    await a.callTool({ name: "claim_issue", arguments: { ref: "AIPI-1" } }); // session A holds the lease
    const b = await connect(agent); // same actor (shared bearer token), different session
    const r = await b.callTool({ name: "update_issue", arguments: { ref: "AIPI-1", status: "in_review" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/lease/i);
  });

  it("the holder can update_issue with the returned lease_token", async () => {
    const c = await connect(agent);
    const claim = JSON.parse(text(await c.callTool({ name: "claim_issue", arguments: { ref: "AIPI-1" } })));
    const r = await c.callTool({
      name: "update_issue",
      arguments: { ref: "AIPI-1", status: "in_review", lease_token: claim.lease_token },
    });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r)).status).toBe("in_review");
  });

  it("a bare same-actor re-claim fails; takeover:true seizes it with a fresh lease", async () => {
    const c = await connect(agent);
    await c.callTool({ name: "claim_issue", arguments: { ref: "AIPI-1" } });
    const bare = await c.callTool({ name: "claim_issue", arguments: { ref: "AIPI-1" } });
    expect(bare.isError).toBe(true);
    expect(text(bare)).toMatch(/takeover/i);
    const seized = JSON.parse(
      text(await c.callTool({ name: "claim_issue", arguments: { ref: "AIPI-1", takeover: true } })),
    );
    expect(seized.lease_token).toMatch(/^lease_/);
  });

  it("exempt surfaces (comment) work without a lease", async () => {
    const a = await connect(agent);
    await a.callTool({ name: "claim_issue", arguments: { ref: "AIPI-1" } });
    const b = await connect(agent);
    const r = await b.callTool({ name: "comment", arguments: { ref: "AIPI-1", body: "fyi" } });
    expect(r.isError).toBeFalsy();
  });
});
