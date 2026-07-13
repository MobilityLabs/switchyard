// GET /api/pr-state (SYD-206): read surface for the poller's targeted
// refresh — which rows are still open for a repo, so ones that fell out of
// the 50-window get an individual `gh pr view`. Read-only; consumers proper
// (claim gate, attention, search) migrate at SYD-207.

import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue } from "../../src/services/issues.js";
import { addGithubRepo } from "../../src/services/github-repos.js";
import { recordDeliveryEvent } from "../../src/services/delivery-events.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

let db: Db, app: ReturnType<typeof buildApiRoutes>;
let headers: Record<string, string>;

beforeEach(() => {
  db = openDb(":memory:");
  const worker = createActor(db, { name: "delivery-worker", type: "human" });
  headers = { authorization: `Bearer ${worker.token}` };
  createProject(db, worker.actor, { key: "SYD", name: "Switchyard" });
  createIssue(db, worker.actor, { projectKey: "SYD", title: "One" });
  createIssue(db, worker.actor, { projectKey: "SYD", title: "Two" });
  addGithubRepo(db, worker.actor, { fullName: "acme/widgets", projectKey: "SYD" });
  recordDeliveryEvent(db, worker.actor, "SYD-1", {
    type: "pr_opened",
    prNumber: 7,
    url: "https://github.com/acme/widgets/pull/7",
    ghUpdatedAt: "2026-07-12T10:00:00Z",
  });
  recordDeliveryEvent(db, worker.actor, "SYD-2", {
    type: "pr_opened",
    prNumber: 8,
    url: "https://github.com/acme/widgets/pull/8",
    ghUpdatedAt: "2026-07-12T10:00:00Z",
  });
  recordDeliveryEvent(db, worker.actor, "SYD-2", {
    type: "delivered",
    prNumber: 8,
    mergeSha: "m".repeat(40),
    deploy: { ran: false },
    ghUpdatedAt: "2026-07-12T11:00:00Z",
  });
  app = buildApiRoutes(db);
});

describe("GET /pr-state", () => {
  it("filters by repo and status", async () => {
    const res = await app.request("/pr-state?repo=acme/widgets&status=open", { headers });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { prNumber: number; status: string; issueRef: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ prNumber: 7, status: "open", issueRef: "SYD-1" });
  });

  it("returns all rows for a repo without a status filter", async () => {
    const res = await app.request("/pr-state?repo=acme/widgets", { headers });
    const rows = (await res.json()) as { prNumber: number }[];
    expect(rows.map((r) => r.prNumber).sort()).toEqual([7, 8]);
  });

  it("rejects an invalid status filter", async () => {
    const res = await app.request("/pr-state?repo=acme/widgets&status=bogus", { headers });
    expect(res.status).toBe(400);
  });

  it("requires authentication", async () => {
    const res = await app.request("/pr-state?repo=acme/widgets");
    expect(res.status).toBe(401);
  });
});
