// SYD-280: the MCP surface for declared issue<->PR attribution.
//
// This is the surface that makes interactive work visible to the board at all.
// Without it a feat/ branch has no way to say which PR carries its work, and
// the swap in pr-status.ts/attention.ts would silently regress SYD-267.
import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue } from "../../src/services/issues.js";
import { addGithubRepo } from "../../src/services/github-repos.js";
import { listLiveLinks } from "../../src/services/pr-links.js";
import { buildMcpServer } from "../../src/mcp/server.js";

const REPO = "acme/widgets";
let db: Db, human: Actor, agent: Actor;

async function connect(actor: Actor, connectionLease?: string) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(db, actor, undefined, connectionLease).connect(st);
  const c = new Client({ name: "test", version: "0.0.0" });
  await c.connect(ct);
  return c;
}

const text = (r: Awaited<ReturnType<Client["callTool"]>>) =>
  (r.content as { type: string; text: string }[])[0].text;

beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
  updateIssue(db, human, "SYD-1", { status: "todo" });
  addGithubRepo(db, human, { fullName: REPO, projectKey: "SYD" });
});

describe("declare_pr_link", () => {
  it("declares with an explicit lease_token arg", async () => {
    const { leaseToken } = claimIssue(db, agent, "SYD-1");
    const client = await connect(agent);
    const res = await client.callTool({
      name: "declare_pr_link",
      arguments: { ref: "SYD-1", repo: REPO, pr_number: 42, lease_token: leaseToken },
    });
    expect(res.isError).toBeFalsy();
    const [link] = listLiveLinks(db, 1);
    expect(link.prNumber).toBe(42);
    expect(link.role).toBe("delivers");
    // An agent's own declaration never vouches for itself.
    expect(link.confirmedBy).toBeNull();
  });

  it("declares using the connection lease, so the token never enters the transcript", async () => {
    const { leaseToken } = claimIssue(db, agent, "SYD-1");
    const client = await connect(agent, leaseToken);
    const res = await client.callTool({
      name: "declare_pr_link",
      arguments: { ref: "SYD-1", repo: REPO, pr_number: 42 },
    });
    expect(res.isError).toBeFalsy();
    expect(listLiveLinks(db, 1)).toHaveLength(1);
  });

  it("refuses without a lease, as a tool error rather than a throw", async () => {
    claimIssue(db, agent, "SYD-1");
    const client = await connect(agent);
    const res = await client.callTool({
      name: "declare_pr_link",
      arguments: { ref: "SYD-1", repo: REPO, pr_number: 42 },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/lease/i);
    expect(listLiveLinks(db, 1)).toHaveLength(0);
  });

  it("refuses an issue the agent does not hold", async () => {
    const client = await connect(agent);
    const res = await client.callTool({
      name: "declare_pr_link",
      arguments: { ref: "SYD-1", repo: REPO, pr_number: 42 },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/not yours/i);
  });

  it("refuses a repo not bound to the project", async () => {
    const { leaseToken } = claimIssue(db, agent, "SYD-1");
    const client = await connect(agent);
    const res = await client.callTool({
      name: "declare_pr_link",
      arguments: {
        ref: "SYD-1",
        repo: "someone/else",
        pr_number: 42,
        lease_token: leaseToken,
      },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/bound/i);
  });
});

describe("revoke_pr_link", () => {
  it("withdraws the agent's own unconfirmed link", async () => {
    const { leaseToken } = claimIssue(db, agent, "SYD-1");
    const client = await connect(agent, leaseToken);
    await client.callTool({
      name: "declare_pr_link",
      arguments: { ref: "SYD-1", repo: REPO, pr_number: 42 },
    });
    const res = await client.callTool({
      name: "revoke_pr_link",
      arguments: { ref: "SYD-1", repo: REPO, pr_number: 42, reason: "linked the wrong PR" },
    });
    expect(res.isError).toBeFalsy();
    expect(listLiveLinks(db, 1)).toHaveLength(0);
  });

  it("requires a reason", async () => {
    const { leaseToken } = claimIssue(db, agent, "SYD-1");
    const client = await connect(agent, leaseToken);
    await client.callTool({
      name: "declare_pr_link",
      arguments: { ref: "SYD-1", repo: REPO, pr_number: 42 },
    });
    const res = await client.callTool({
      name: "revoke_pr_link",
      arguments: { ref: "SYD-1", repo: REPO, pr_number: 42, reason: "   " },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/reason/i);
  });
});

describe("what MCP deliberately does not expose", () => {
  it("has no confirm tool — confirming is a human act, by design", async () => {
    const client = await connect(agent);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("declare_pr_link");
    expect(names).toContain("revoke_pr_link");
    expect(names.some((n) => n.includes("confirm"))).toBe(false);
  });
});
