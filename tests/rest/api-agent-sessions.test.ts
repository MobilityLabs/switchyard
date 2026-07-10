import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue } from "../../src/services/issues.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

let db: Db, app: ReturnType<typeof buildApiRoutes>;
let workerH: Record<string, string>, humanH: Record<string, string>;

beforeEach(() => {
  db = openDb(":memory:");
  const worker = createActor(db, { name: "claude/worker", type: "agent" });
  const human = createActor(db, { name: "sean", type: "human" });
  workerH = { authorization: `Bearer ${worker.token}`, "content-type": "application/json" };
  humanH = { authorization: `Bearer ${human.token}`, "content-type": "application/json" };
  createProject(db, { key: "SYD", name: "Switchyard" });
  createIssue(db, worker.actor, {
    projectKey: "SYD", title: "Ship v1", description: "x",
    provenance: { sourceType: "session" },
  });
  app = buildApiRoutes(db);
});

async function body<T>(r: Response): Promise<T> { return (await r.json()) as T; }

async function startSession(): Promise<{ id: number }> {
  return body(await app.request("/agent-sessions", {
    method: "POST", headers: workerH,
    body: JSON.stringify({ ref: "SYD-1", mode: "cli", pid: 4242 }),
  }));
}

describe("POST /agent-sessions", () => {
  it("creates a running session", async () => {
    const res = await app.request("/agent-sessions", {
      method: "POST", headers: workerH,
      body: JSON.stringify({ ref: "SYD-1", mode: "cli", pid: 4242 }),
    });
    expect(res.status).toBe(200);
    const s = await body<Record<string, unknown>>(res);
    expect(s).toMatchObject({ ref: "SYD-1", mode: "cli", pid: 4242, status: "running" });
  });

  it("rejects human actors", async () => {
    const res = await app.request("/agent-sessions", {
      method: "POST", headers: humanH,
      body: JSON.stringify({ ref: "SYD-1", mode: "cli" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown mode", async () => {
    const res = await app.request("/agent-sessions", {
      method: "POST", headers: workerH,
      body: JSON.stringify({ ref: "SYD-1", mode: "carrier-pigeon" }),
    });
    expect(res.status).toBe(400);
  });

  it("requires authentication", async () => {
    const res = await app.request("/agent-sessions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "SYD-1", mode: "cli" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("PATCH /agent-sessions/:id", () => {
  it("ends the session with an exit code", async () => {
    const { id } = await startSession();
    const res = await app.request(`/agent-sessions/${id}`, {
      method: "PATCH", headers: workerH, body: JSON.stringify({ exitCode: 0 }),
    });
    expect(res.status).toBe(200);
    expect(await body<Record<string, unknown>>(res)).toMatchObject({ status: "exited", exitCode: 0 });
  });

  it("404-shapes an unknown id as a SwitchyardError (400)", async () => {
    const res = await app.request("/agent-sessions/999", {
      method: "PATCH", headers: workerH, body: JSON.stringify({ exitCode: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it("reports the non-numeric id verbatim instead of NaN (SYD-105)", async () => {
    const res = await app.request("/agent-sessions/abc", {
      method: "PATCH", headers: workerH, body: JSON.stringify({ exitCode: 0 }),
    });
    expect(res.status).toBe(400);
    expect(await body<{ error: string }>(res)).toEqual({ error: "Agent session abc does not exist." });
  });
});

describe("GET /agent-sessions", () => {
  it("lists sessions, filterable to active ones and by ref", async () => {
    const { id } = await startSession();
    await startSession().then(({ id: second }) =>
      app.request(`/agent-sessions/${second}`, {
        method: "PATCH", headers: workerH, body: JSON.stringify({ exitCode: 1 }),
      })
    );
    const all = await body<unknown[]>(await app.request("/agent-sessions", { headers: workerH }));
    expect(all.length).toBe(2);
    const active = await body<{ id: number }[]>(
      await app.request("/agent-sessions?active=true&ref=SYD-1", { headers: workerH })
    );
    expect(active.map((s) => s.id)).toEqual([id]);
  });
});

describe("POST /issues/:ref/progress-note", () => {
  it("records a progress_note event onto the activity feed", async () => {
    const res = await app.request("/issues/SYD-1/progress-note", {
      method: "POST", headers: workerH, body: JSON.stringify({ note: "building the UI" }),
    });
    expect(res.status).toBe(200);
    const issue = await body<{ activity: { type: string; payload: Record<string, unknown> }[] }>(
      await app.request("/issues/SYD-1", { headers: workerH })
    );
    expect(issue.activity.find((a) => a.type === "progress_note")?.payload).toEqual({ note: "building the UI" });
  });

  it("rejects an empty note", async () => {
    const res = await app.request("/issues/SYD-1/progress-note", {
      method: "POST", headers: workerH, body: JSON.stringify({ note: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects human actors", async () => {
    const res = await app.request("/issues/SYD-1/progress-note", {
      method: "POST", headers: humanH, body: JSON.stringify({ note: "hi" }),
    });
    expect(res.status).toBe(400);
  });
});
