import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue } from "../../src/services/issues.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

describe("GET /events", () => {
  it("returns the joined, newest-first feed and honors ?limit", async () => {
    const db = openDb(":memory:");
    const { token } = createActor(db, { name: "sean", type: "human" });
    createProject(db, { key: "SYD", name: "Switchyard" });
    const human = createActor(db, { name: "someone-else", type: "human" }).actor;
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });

    const app = buildApiRoutes(db);
    const headers = { authorization: `Bearer ${token}` };

    const res = await app.request("/events", { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: number;
      type: string;
      issue: string;
      issueTitle: string;
      projectKey: string;
      actorName: string;
      createdAt: number;
    }>;
    expect(body).toHaveLength(2);
    expect(body[0].id).toBeGreaterThan(body[1].id); // newest-first
    expect(body[1]).toMatchObject({
      issue: "SYD-1",
      issueTitle: "Ship it",
      projectKey: "SYD",
      actorName: "someone-else",
    });

    const limited = await app.request("/events?limit=1", { headers });
    expect(await limited.json()).toHaveLength(1);
  });

  it("requires authentication", async () => {
    const db = openDb(":memory:");
    const app = buildApiRoutes(db);
    const res = await app.request("/events");
    expect(res.status).toBe(401);
  });
});
