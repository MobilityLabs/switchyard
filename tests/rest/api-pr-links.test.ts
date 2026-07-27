// SYD-280: the REST surface for declared issue<->PR attribution.
//
// The half MCP deliberately omits lives here: confirming, which is what turns
// a declared link into evidence that work landed.
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue } from "../../src/services/issues.js";
import { addGithubRepo } from "../../src/services/github-repos.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

const REPO = "acme/widgets";
let db: Db, app: ReturnType<typeof buildApiRoutes>;
let agentH: Record<string, string>, humanH: Record<string, string>;
let leaseToken: string;

beforeEach(() => {
  db = openDb(":memory:");
  const agent = createActor(db, { name: "claude/dev", type: "agent" });
  const human = createActor(db, { name: "sean", type: "human" });
  agentH = { authorization: `Bearer ${agent.token}`, "content-type": "application/json" };
  humanH = { authorization: `Bearer ${human.token}`, "content-type": "application/json" };
  createProject(db, human.actor, { key: "SYD", name: "Switchyard" });
  createIssue(db, human.actor, { projectKey: "SYD", title: "Ship it" });
  updateIssue(db, human.actor, "SYD-1", { status: "todo" });
  addGithubRepo(db, human.actor, { fullName: REPO, projectKey: "SYD" });
  leaseToken = claimIssue(db, agent.actor, "SYD-1").leaseToken as string;
  app = buildApiRoutes(db);
});

async function body<T>(r: Response): Promise<T> {
  return (await r.json()) as T;
}

const declare = (headers: Record<string, string>, extra: Record<string, string> = {}) =>
  app.request("/issues/SYD-1/pr-links", {
    method: "POST",
    headers: { ...headers, ...extra },
    body: JSON.stringify({ repo: REPO, prNumber: 42 }),
  });

describe("POST /issues/:ref/pr-links", () => {
  it("an agent declares with the lease header", async () => {
    const res = await declare(agentH, { "x-switchyard-lease": leaseToken });
    expect(res.status).toBe(200);
    const link = await body<{ role: string; confirmedBy: number | null }>(res);
    expect(link.role).toBe("delivers");
    expect(link.confirmedBy).toBeNull();
  });

  it("refuses an agent with no lease header", async () => {
    const res = await declare(agentH);
    expect(res.status).toBe(400);
    expect((await body<{ error: string }>(res)).error).toMatch(/lease/i);
  });

  it("a human declares without a lease, and it is auto-confirmed", async () => {
    const res = await declare(humanH);
    expect(res.status).toBe(200);
    expect((await body<{ confirmedBy: number | null }>(res)).confirmedBy).not.toBeNull();
  });

  it("rejects a malformed pr number at the schema", async () => {
    const res = await app.request("/issues/SYD-1/pr-links", {
      method: "POST",
      headers: humanH,
      body: JSON.stringify({ repo: REPO, prNumber: -1 }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /issues/:ref/pr-links/confirm", () => {
  it("a human confirms an agent's link", async () => {
    await declare(agentH, { "x-switchyard-lease": leaseToken });
    const res = await app.request("/issues/SYD-1/pr-links/confirm", {
      method: "POST",
      headers: humanH,
      body: JSON.stringify({ repo: REPO, prNumber: 42 }),
    });
    expect(res.status).toBe(200);
    expect((await body<{ confirmedBy: number | null }>(res)).confirmedBy).not.toBeNull();
  });

  it("refuses an agent confirming — the whole reason declaring is safe to widen", async () => {
    await declare(agentH, { "x-switchyard-lease": leaseToken });
    const res = await app.request("/issues/SYD-1/pr-links/confirm", {
      method: "POST",
      headers: { ...agentH, "x-switchyard-lease": leaseToken },
      body: JSON.stringify({ repo: REPO, prNumber: 42 }),
    });
    expect(res.status).toBe(400);
    expect((await body<{ error: string }>(res)).error).toMatch(/human/i);
  });
});

describe("POST /issues/:ref/pr-links/revoke", () => {
  it("a human revokes a confirmed link with a reason", async () => {
    await declare(humanH);
    const res = await app.request("/issues/SYD-1/pr-links/revoke", {
      method: "POST",
      headers: humanH,
      body: JSON.stringify({ repo: REPO, prNumber: 42, reason: "mis-linked" }),
    });
    expect(res.status).toBe(200);
    const detail = await body<{ prLinks: unknown[] }>(
      await app.request("/issues/SYD-1", { headers: humanH }),
    );
    expect(detail.prLinks).toHaveLength(0);
  });

  it("refuses an agent revoking a confirmed link", async () => {
    await declare(humanH); // human-declared => confirmed
    const res = await app.request("/issues/SYD-1/pr-links/revoke", {
      method: "POST",
      headers: { ...agentH, "x-switchyard-lease": leaseToken },
      body: JSON.stringify({ repo: REPO, prNumber: 42, reason: "nope" }),
    });
    expect(res.status).toBe(400);
    expect((await body<{ error: string }>(res)).error).toMatch(/human/i);
  });
});

describe("GET /issues/:ref", () => {
  it("exposes prLinks additively, leaving openPr and deliveryPin untouched", async () => {
    await declare(humanH);
    const detail = await body<{
      prLinks: { repo: string; prNumber: number; role: string }[];
      openPr: unknown;
      deliveryPin: unknown;
    }>(await app.request("/issues/SYD-1", { headers: humanH }));
    expect(detail.prLinks).toHaveLength(1);
    expect(detail.prLinks[0]).toMatchObject({ repo: REPO, prNumber: 42, role: "delivers" });
    // No pr_state row yet, so both stay null — the UI contract is unchanged.
    expect(detail.openPr).toBeNull();
    expect(detail.deliveryPin).toBeNull();
  });
});
