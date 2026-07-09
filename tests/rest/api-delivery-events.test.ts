import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue } from "../../src/services/issues.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

let db: Db, app: ReturnType<typeof buildApiRoutes>;
let workerH: Record<string, string>;

beforeEach(() => {
  db = openDb(":memory:");
  const worker = createActor(db, { name: "claude/worker", type: "agent" });
  workerH = { authorization: `Bearer ${worker.token}`, "content-type": "application/json" };
  createProject(db, { key: "SYD", name: "Switchyard" });
  createIssue(db, worker.actor, {
    projectKey: "SYD", title: "Ship v1",
    provenance: { sourceType: "session" }, description: "x",
  });
  app = buildApiRoutes(db);
});

async function body<T>(r: Response): Promise<T> { return (await r.json()) as T; }

describe("POST /issues/:ref/delivery-events", () => {
  it("records a pr_opened event onto the activity feed", async () => {
    const res = await app.request("/issues/SYD-1/delivery-events", {
      method: "POST", headers: workerH,
      body: JSON.stringify({ type: "pr_opened", prNumber: 7, url: "https://github.com/acme/widgets/pull/7" }),
    });
    expect(res.status).toBe(200);

    const issue = await body<{ activity: { type: string; payload: Record<string, unknown> }[] }>(
      await app.request("/issues/SYD-1", { headers: workerH })
    );
    const ev = issue.activity.find((a) => a.type === "pr_opened");
    expect(ev?.payload).toEqual({ prNumber: 7, url: "https://github.com/acme/widgets/pull/7" });
  });

  it("records a delivered event with deploy result", async () => {
    const res = await app.request("/issues/SYD-1/delivery-events", {
      method: "POST", headers: workerH,
      body: JSON.stringify({
        type: "delivered", prNumber: 7, mergeSha: "deadbeef",
        deploy: { ran: true, ok: false, tail: "npm ERR!" },
      }),
    });
    expect(res.status).toBe(200);

    const issue = await body<{ activity: { type: string; payload: Record<string, unknown> }[] }>(
      await app.request("/issues/SYD-1", { headers: workerH })
    );
    const ev = issue.activity.find((a) => a.type === "delivered");
    expect(ev?.payload).toEqual({
      prNumber: 7, mergeSha: "deadbeef", deploy: { ran: true, ok: false, tail: "npm ERR!" },
    });
  });

  it("records a delivery_failed event", async () => {
    const res = await app.request("/issues/SYD-1/delivery-events", {
      method: "POST", headers: workerH,
      body: JSON.stringify({ type: "delivery_failed", message: "merge conflict" }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects an unknown event type", async () => {
    const res = await app.request("/issues/SYD-1/delivery-events", {
      method: "POST", headers: workerH,
      body: JSON.stringify({ type: "bogus" }),
    });
    expect(res.status).toBe(400);
  });

  it("requires authentication", async () => {
    const res = await app.request("/issues/SYD-1/delivery-events", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "delivery_failed", message: "boom" }),
    });
    expect(res.status).toBe(401);
  });
});
