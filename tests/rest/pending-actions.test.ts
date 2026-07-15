import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, getIssue, type IssueView } from "../../src/services/issues.js";
import { createLoginLink, redeemLoginLink } from "../../src/services/auth.js";
import { openSupervisedSession } from "../../src/services/supervised-sessions.js";
import { attributionOf } from "../../src/services/attribution.js";
import { listPendingActions } from "../../src/services/hard-gate.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

let db: Db;
let app: ReturnType<typeof buildApiRoutes>;
let owner: Actor, bystander: Actor, agent: Actor;
let agentToken: string, supToken: string;
let ownerCookie: string, bystanderCookie: string;
let issue: IssueView;
let pendingId: number;

/** A plain web-session cookie for `name` — the only credential the affirm
 * route accepts, minted the way a real browser login does. */
function loginCookie(name: string): string {
  const { token } = createLoginLink(db, name);
  const { sessionToken } = redeemLoginLink(db, token);
  return `switchyard_session=${sessionToken}`;
}

beforeEach(() => {
  db = openDb(":memory:");
  app = buildApiRoutes(db);
  owner = createActor(db, { name: "sean", type: "human" }).actor;
  bystander = createActor(db, { name: "morgan", type: "human" }).actor;
  const created = createActor(db, { name: "claude-code", type: "agent" });
  agent = created.actor;
  agentToken = created.token;

  createProject(db, owner, { key: "SUP", name: "supervised" });
  issue = createIssue(db, owner, { projectKey: "SUP", title: "Ship the gate" });
  updateIssue(db, owner, issue.ref, { status: "todo" });

  const session = openSupervisedSession(db, owner, agent.name);
  supToken = session.sessionToken;

  // The agent side proposes `done`; the divert parks it instead of executing.
  expect(() =>
    updateIssue(
      db,
      owner,
      issue.ref,
      { status: "done" },
      {},
      attributionOf({ actor: owner, viaAgent: agent, sessionId: session.sessionId }),
    ),
  ).toThrow(/awaiting human affirmation/i);

  ownerCookie = loginCookie(owner.name);
  bystanderCookie = loginCookie(bystander.name);
  pendingId = listPendingActions(db)[0].id;
});

const affirm = (headers: Record<string, string>) =>
  app.request(`/pending-actions/${pendingId}/affirm`, { method: "POST", headers });

describe("POST /api/pending-actions/:id/affirm", () => {
  it("the owner human's session cookie affirms and the deferred done commits", async () => {
    const res = await affirm({ cookie: ownerCookie });
    expect(res.status).toBe(200);
    expect(((await res.json()) as IssueView).status).toBe("done");
    expect(getIssue(db, issue.ref).status).toBe("done");
    expect(listPendingActions(db, "affirmed")[0].affirmedById).toBe(owner.id);
  });

  it("refuses an agent bearer with no session cookie (a bearer is not human presence)", async () => {
    const res = await affirm({ authorization: `Bearer ${agentToken}` });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/human web session/i);
    expect(getIssue(db, issue.ref).status).toBe("todo");
  });

  it("refuses a sup_ token presented as the session cookie", async () => {
    // Authed by the agent's bearer so the request reaches the handler — this
    // asserts the route itself rejects the sup_ credential, not just middleware.
    const res = await affirm({
      authorization: `Bearer ${agentToken}`,
      cookie: `switchyard_session=${supToken}`,
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/human web session/i);
    expect(getIssue(db, issue.ref).status).toBe("todo");
  });

  it("refuses a different human's cookie (only the session's accountable human may affirm)", async () => {
    const res = await affirm({ cookie: bystanderCookie });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/only the accountable human/i);
    expect(getIssue(db, issue.ref).status).toBe("todo");
  });

  it("rejects a non-numeric id before it reaches the service", async () => {
    const res = await app.request("/pending-actions/not-an-id/affirm", {
      method: "POST",
      headers: { cookie: ownerCookie },
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/pending-actions", () => {
  it("lists the pending action", async () => {
    const res = await app.request("/pending-actions?status=pending", {
      headers: { cookie: ownerCookie },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: number; actionType: string; issueId: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(pendingId);
    expect(rows[0].actionType).toBe("done");
    expect(rows[0].issueId).toBe(issue.id);
  });

  it("defaults to pending and rejects an unknown status", async () => {
    const res = await app.request("/pending-actions", { headers: { cookie: ownerCookie } });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).toHaveLength(1);

    const bad = await app.request("/pending-actions?status=bogus", {
      headers: { cookie: ownerCookie },
    });
    expect(bad.status).toBe(400);
  });
});
