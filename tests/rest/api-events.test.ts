import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue } from "../../src/services/issues.js";
import { addComment } from "../../src/services/comments.js";
import { recordEvent } from "../../src/services/events.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

describe("GET /events", () => {
  it("returns the joined, newest-first feed and honors ?limit", async () => {
    const db = openDb(":memory:");
    const { token } = createActor(db, { name: "sean", type: "human" });
    const human = createActor(db, { name: "someone-else", type: "human" }).actor;
    createProject(db, human, { key: "SYD", name: "Switchyard" });
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

  it("pages via before_id and signals truncation with X-Truncated/X-Next-Cursor headers (SYD-89)", async () => {
    const db = openDb(":memory:");
    const { token } = createActor(db, { name: "sean", type: "human" });
    const human = createActor(db, { name: "someone-else", type: "human" }).actor;
    createProject(db, human, { key: "SYD", name: "Switchyard" });
    const issue = createIssue(db, human, { projectKey: "SYD", title: "Busy issue" }); // 1 event
    for (let i = 0; i < 4; i++) {
      recordEvent(db, { issueId: issue.id, actorId: human.id, type: "comment", payload: {} });
    }
    // 5 events total.

    const app = buildApiRoutes(db);
    const headers = { authorization: `Bearer ${token}` };

    const firstPage = await app.request("/events?limit=2", { headers });
    expect(firstPage.status).toBe(200);
    expect(firstPage.headers.get("X-Truncated")).toBe("true");
    const cursor = firstPage.headers.get("X-Next-Cursor");
    expect(cursor).not.toBeNull();
    const firstBody = (await firstPage.json()) as Array<{ id: number }>;
    expect(firstBody).toHaveLength(2);

    const secondPage = await app.request(`/events?limit=2&before_id=${cursor}`, { headers });
    expect(secondPage.status).toBe(200);
    const secondBody = (await secondPage.json()) as Array<{ id: number }>;
    expect(secondBody.every((e) => e.id < Number(cursor))).toBe(true);

    const lastPage = await app.request("/events?limit=10", { headers });
    expect(lastPage.headers.get("X-Truncated")).toBe("false");
    expect(lastPage.headers.get("X-Next-Cursor")).toBeNull();
    expect(await lastPage.json()).toHaveLength(5);
  });
});

describe("GET /unanswered-questions", () => {
  it("returns issues whose @agent question has no later agent-actor comment (SYD-60)", async () => {
    const db = openDb(":memory:");
    const { token } = createActor(db, { name: "sean", type: "human" });
    const agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
    const human = createActor(db, { name: "someone-else", type: "human" }).actor;
    createProject(db, human, { key: "SYD", name: "Switchyard" });
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
