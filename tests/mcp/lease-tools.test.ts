import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue } from "../../src/services/issues.js";
import { buildMcpServer } from "../../src/mcp/server.js";

let db: Db, human: Actor, agent: Actor;
async function connect(actor: Actor, connectionLeaseToken?: string) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(db, actor, undefined, connectionLeaseToken).connect(st);
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

  it("a host-supervised (connection-lease) session can heartbeat off its connection token", async () => {
    const claimer = await connect(agent);
    const claim = JSON.parse(
      text(await claimer.callTool({ name: "claim_issue", arguments: { ref: "AIPI-1" } })),
    );
    const session = await connect(agent, claim.lease_token);
    const beat = await session.callTool({ name: "heartbeat", arguments: { ref: "AIPI-1" } });
    expect(beat.isError).toBeFalsy();
    expect(JSON.parse(text(beat)).ok).toBe(true);
  });

  it("a host-injected connection lease token satisfies claim-scoped calls with no per-call token", async () => {
    // The host claims and mints the lease, then injects it as an MCP connection
    // header — the container session mutates without ever seeing the token in
    // its transcript (no lease_token tool arg).
    const claimer = await connect(agent);
    const claim = JSON.parse(
      text(await claimer.callTool({ name: "claim_issue", arguments: { ref: "AIPI-1" } })),
    );
    const session = await connect(agent, claim.lease_token); // connection-level injection
    const r = await session.callTool({
      name: "update_issue",
      arguments: { ref: "AIPI-1", status: "in_review" }, // no lease_token arg
    });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r)).status).toBe("in_review");
    // heartbeat likewise works off the connection token
    const beat = await session.callTool({ name: "heartbeat", arguments: { ref: "AIPI-1" } });
    expect(beat.isError).toBeFalsy();
  });

  it("a connection-lease (host-supervised) session cannot claim_issue — no token echoed into its transcript", async () => {
    // Host claims + mints; the container session connects with the injected
    // connection lease. If it tries claim_issue (e.g. via prompt-injection),
    // the server refuses rather than minting a fresh token into the transcript.
    const claimer = await connect(agent);
    const claim = JSON.parse(
      text(await claimer.callTool({ name: "claim_issue", arguments: { ref: "AIPI-1" } })),
    );
    const session = await connect(agent, claim.lease_token);
    const r = await session.callTool({ name: "claim_issue", arguments: { ref: "AIPI-1" } });
    expect(r.isError).toBe(true);
    expect(text(r)).not.toContain(claim.lease_token);
    expect(text(r)).not.toMatch(/lease_[0-9a-f]/); // no fresh token minted into the result
    // takeover is likewise refused for a connection-lease session
    const t = await session.callTool({ name: "claim_issue", arguments: { ref: "AIPI-1", takeover: true } });
    expect(t.isError).toBe(true);
  });

  it("a connection-lease session cannot mint a token via update_issue's auto-claim (foreign or own-issue loop)", async () => {
    // A second unassigned issue the injected session might try to auto-claim.
    createIssue(db, human, { projectKey: "AIPI", title: "other" });
    updateIssue(db, human, "AIPI-2", { status: "todo" });
    const claimer = await connect(agent);
    const claim = JSON.parse(
      text(await claimer.callTool({ name: "claim_issue", arguments: { ref: "AIPI-1" } })),
    );
    const session = await connect(agent, claim.lease_token);

    // Variant A: auto-claim a DIFFERENT unassigned issue -> refused, no token.
    const foreign = await session.callTool({
      name: "update_issue",
      arguments: { ref: "AIPI-2", status: "in_progress" },
    });
    expect(foreign.isError).toBe(true);
    expect(text(foreign)).not.toMatch(/lease_[0-9a-f]/);

    // Variant B: own-issue todo -> in_progress re-claim loop. The re-claim leg
    // is refused and never mints/echoes a fresh token.
    await session.callTool({ name: "update_issue", arguments: { ref: "AIPI-1", status: "todo" } });
    const remint = await session.callTool({
      name: "update_issue",
      arguments: { ref: "AIPI-1", status: "in_progress" },
    });
    expect(remint.isError).toBe(true);
    expect(text(remint)).not.toMatch(/lease_[0-9a-f]/);
  });

  it("the model-facing heartbeat tool is hidden from ordinary sessions, shown only on a connection-lease session", async () => {
    const interactive = await connect(agent); // no connection lease
    const tools = (await interactive.listTools()).tools.map((t) => t.name);
    expect(tools).not.toContain("heartbeat");
    const supervised = await connect(agent, "lease_whatever"); // host-injected connection lease
    const tools2 = (await supervised.listTools()).tools.map((t) => t.name);
    expect(tools2).toContain("heartbeat");
  });

  it("exempt surfaces (comment) work without a lease", async () => {
    const a = await connect(agent);
    await a.callTool({ name: "claim_issue", arguments: { ref: "AIPI-1" } });
    const b = await connect(agent);
    const r = await b.callTool({ name: "comment", arguments: { ref: "AIPI-1", body: "fyi" } });
    expect(r.isError).toBeFalsy();
  });
});
