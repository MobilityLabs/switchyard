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
  // The delivery infra (deliver.ts / agent-worker.ts) authenticates with a
  // human-typed token (SYD-107/108) — agent tokens are rejected below.
  const worker = createActor(db, { name: "delivery-worker", type: "human" });
  workerH = { authorization: `Bearer ${worker.token}`, "content-type": "application/json" };
  createProject(db, worker.actor, { key: "SYD", name: "Switchyard" });
  createIssue(db, worker.actor, {
    projectKey: "SYD",
    title: "Ship v1",
    provenance: { sourceType: "session" },
    description: "x",
  });
  app = buildApiRoutes(db);
});

async function body<T>(r: Response): Promise<T> {
  return (await r.json()) as T;
}

describe("POST /issues/:ref/delivery-events", () => {
  it("records a pr_opened event onto the activity feed", async () => {
    const res = await app.request("/issues/SYD-1/delivery-events", {
      method: "POST",
      headers: workerH,
      body: JSON.stringify({
        type: "pr_opened",
        prNumber: 7,
        url: "https://github.com/acme/widgets/pull/7",
      }),
    });
    expect(res.status).toBe(200);

    const issue = await body<{ activity: { type: string; payload: Record<string, unknown> }[] }>(
      await app.request("/issues/SYD-1", { headers: workerH }),
    );
    const ev = issue.activity.find((a) => a.type === "pr_opened");
    expect(ev?.payload).toEqual({
      prNumber: 7,
      url: "https://github.com/acme/widgets/pull/7",
      repo: null,
      headSha: null,
      ghUpdatedAt: null,
    });
  });

  it("accepts and records the SYD-205 freshness fields on pr_opened", async () => {
    const res = await app.request("/issues/SYD-1/delivery-events", {
      method: "POST",
      headers: workerH,
      body: JSON.stringify({
        type: "pr_opened",
        prNumber: 7,
        url: "https://github.com/acme/widgets/pull/7",
        repo: "acme/widgets",
        headSha: "c".repeat(40),
        ghUpdatedAt: "2026-07-12T10:00:00Z",
      }),
    });
    expect(res.status).toBe(200);

    const issue = await body<{ activity: { type: string; payload: Record<string, unknown> }[] }>(
      await app.request("/issues/SYD-1", { headers: workerH }),
    );
    expect(issue.activity.find((a) => a.type === "pr_opened")?.payload).toEqual({
      prNumber: 7,
      url: "https://github.com/acme/widgets/pull/7",
      repo: "acme/widgets",
      headSha: "c".repeat(40),
      ghUpdatedAt: "2026-07-12T10:00:00Z",
    });
  });

  it("records a delivered event with deploy result", async () => {
    const res = await app.request("/issues/SYD-1/delivery-events", {
      method: "POST",
      headers: workerH,
      body: JSON.stringify({
        type: "delivered",
        prNumber: 7,
        mergeSha: "deadbeef",
        deploy: { ran: true, ok: false, tail: "npm ERR!" },
      }),
    });
    expect(res.status).toBe(200);

    const issue = await body<{ activity: { type: string; payload: Record<string, unknown> }[] }>(
      await app.request("/issues/SYD-1", { headers: workerH }),
    );
    const ev = issue.activity.find((a) => a.type === "delivered");
    expect(ev?.payload).toEqual({
      prNumber: 7,
      mergeSha: "deadbeef",
      deploy: { ran: true, ok: false, tail: "npm ERR!" },
      repo: null,
    });
  });

  it("accepts and records GitHub freshness fields on delivered (the merge writer's timestamp source, SYD-206)", async () => {
    const res = await app.request("/issues/SYD-1/delivery-events", {
      method: "POST",
      headers: workerH,
      body: JSON.stringify({
        type: "delivered",
        prNumber: 7,
        mergeSha: "deadbeef",
        deploy: { ran: false },
        repo: "acme/widgets",
        headSha: "e".repeat(40),
        ghUpdatedAt: "2026-07-12T11:00:00Z",
      }),
    });
    expect(res.status).toBe(200);

    const issue = await body<{ activity: { type: string; payload: Record<string, unknown> }[] }>(
      await app.request("/issues/SYD-1", { headers: workerH }),
    );
    expect(issue.activity.find((a) => a.type === "delivered")?.payload).toMatchObject({
      headSha: "e".repeat(40),
      ghUpdatedAt: "2026-07-12T11:00:00Z",
    });
  });

  it("records a delivery_failed event", async () => {
    const res = await app.request("/issues/SYD-1/delivery-events", {
      method: "POST",
      headers: workerH,
      body: JSON.stringify({ type: "delivery_failed", message: "merge conflict" }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects an unknown event type", async () => {
    const res = await app.request("/issues/SYD-1/delivery-events", {
      method: "POST",
      headers: workerH,
      body: JSON.stringify({ type: "bogus" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects agent-token callers so delivery status can't be forged (SYD-108)", async () => {
    const agent = createActor(db, { name: "claude/rogue", type: "agent" });
    const res = await app.request("/issues/SYD-1/delivery-events", {
      method: "POST",
      headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        type: "delivered",
        prNumber: 7,
        mergeSha: "deadbeef",
        deploy: { ran: false },
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/delivery infrastructure/);
  });

  it("requires authentication", async () => {
    const res = await app.request("/issues/SYD-1/delivery-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "delivery_failed", message: "boom" }),
    });
    expect(res.status).toBe(401);
  });
});
