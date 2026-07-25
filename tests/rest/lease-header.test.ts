import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue } from "../../src/services/issues.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

let db: Db, app: ReturnType<typeof buildApiRoutes>, agentToken: string;
const auth = (extra: Record<string, string> = {}) => ({
  Authorization: `Bearer ${agentToken}`,
  "content-type": "application/json",
  ...extra,
});

beforeEach(() => {
  db = openDb(":memory:");
  const human = createActor(db, { name: "sean", type: "human" }).actor;
  agentToken = createActor(db, { name: "claude/worker", type: "agent" }).token;
  createProject(db, human, { key: "AIPI", name: "aipi" });
  createIssue(db, human, { projectKey: "AIPI", title: "t" });
  updateIssue(db, human, "AIPI-1", { status: "todo" });
  app = buildApiRoutes(db);
});

describe("REST X-Switchyard-Lease", () => {
  it("POST /claim returns a leaseToken", async () => {
    const r = await app.request("/issues/AIPI-1/claim", { method: "POST", headers: auth() });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.leaseToken).toMatch(/^lease_/);
  });

  it("PATCH by a holder without the header is rejected; with it, accepted", async () => {
    const claim = await (
      await app.request("/issues/AIPI-1/claim", { method: "POST", headers: auth() })
    ).json();
    const noHeader = await app.request("/issues/AIPI-1", {
      method: "PATCH",
      headers: auth(),
      body: JSON.stringify({ status: "in_review" }),
    });
    expect(noHeader.status).toBe(400);
    const withHeader = await app.request("/issues/AIPI-1", {
      method: "PATCH",
      headers: auth({ "X-Switchyard-Lease": claim.leaseToken }),
      body: JSON.stringify({ status: "in_review" }),
    });
    expect(withHeader.status).toBe(200);
    expect((await withHeader.json()).status).toBe("in_review");
  });

  it("POST /heartbeat renews with the lease header and rejects without it", async () => {
    const claim = await (
      await app.request("/issues/AIPI-1/claim", { method: "POST", headers: auth() })
    ).json();
    const beat = await app.request("/issues/AIPI-1/heartbeat", {
      method: "POST",
      headers: auth({ "X-Switchyard-Lease": claim.leaseToken }),
    });
    expect(beat.status).toBe(200);
    expect((await beat.json()).ok).toBe(true);
    const noHeader = await app.request("/issues/AIPI-1/heartbeat", {
      method: "POST",
      headers: auth(),
    });
    expect(noHeader.status).toBe(400);
  });
});
