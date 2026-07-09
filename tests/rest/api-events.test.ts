import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue } from "../../src/services/issues.js";
import { addComment } from "../../src/services/comments.js";
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

describe("GET /unanswered-questions", () => {
  it("returns issues whose @agent question has no later agent-actor comment (SYD-60)", async () => {
    const db = openDb(":memory:");
    const { token } = createActor(db, { name: "sean", type: "human" });
    const agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
    const human = createActor(db, { name: "someone-else", type: "human" }).actor;
    createProject(db, { key: "SYD", name: "Switchyard" });
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    createIssue(db, human, { projectKey: "SYD", title: "Answered already" });
    addComment(db, human, "SYD-1", "@agent what's blocking this?");
    addComment(db, human, "SYD-2", "@agent what's blocking this one?");
    addComment(db, agent, "SYD-2", "Nothing — it's ready for review.");

    const app = buildApiRoutes(db);
    const res = await app.request("/unanswered-questions", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ ref: string; questionEventId: number }>;
    expect(body.map((q) => q.ref)).toEqual(["SYD-1"]);
    expect(typeof body[0].questionEventId).toBe("number");
  });

  it("requires authentication", async () => {
    const db = openDb(":memory:");
    const app = buildApiRoutes(db);
    const res = await app.request("/unanswered-questions");
    expect(res.status).toBe(401);
  });
});
