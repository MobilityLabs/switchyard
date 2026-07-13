import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

describe("settings routes", () => {
  it("GET /settings is readable by both humans and agents", async () => {
    const db = openDb(":memory:");
    const app = buildApiRoutes(db);
    for (const type of ["human", "agent"] as const) {
      const token = createActor(db, { name: `actor-${type}`, type }).token;
      const res = await app.request("/settings", { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ key: string; isDefault: boolean }>;
      expect(body.length).toBeGreaterThan(0);
      expect(body.every((r) => r.isDefault)).toBe(true);
    }
  });

  it("PUT /settings/:key: human ok, agent rejected", async () => {
    const db = openDb(":memory:");
    const app = buildApiRoutes(db);
    const humanH = {
      authorization: `Bearer ${createActor(db, { name: "sean", type: "human" }).token}`,
      "content-type": "application/json",
    };
    const agentH = {
      authorization: `Bearer ${createActor(db, { name: "claude/dev", type: "agent" }).token}`,
      "content-type": "application/json",
    };

    const agentRes = await app.request("/settings/instance.name", {
      method: "PUT",
      headers: agentH,
      body: JSON.stringify({ value: "Nope" }),
    });
    expect(agentRes.status).toBe(400);
    expect(((await agentRes.json()) as { error: string }).error).toMatch(/human-only/i);

    const humanRes = await app.request("/settings/instance.name", {
      method: "PUT",
      headers: humanH,
      body: JSON.stringify({ value: "Acme Tracker" }),
    });
    expect(humanRes.status).toBe(200);
    const updated = (await humanRes.json()) as { value: string; isDefault: boolean };
    expect(updated.value).toBe("Acme Tracker");
    expect(updated.isDefault).toBe(false);

    const listRes = await app.request("/settings", { headers: humanH });
    const row = ((await listRes.json()) as Array<{ key: string; value: string }>).find(
      (r) => r.key === "instance.name",
    )!;
    expect(row.value).toBe("Acme Tracker");
  });

  it("PUT /settings/:key rejects an unknown key and an invalid value", async () => {
    const db = openDb(":memory:");
    const app = buildApiRoutes(db);
    const humanH = {
      authorization: `Bearer ${createActor(db, { name: "sean", type: "human" }).token}`,
      "content-type": "application/json",
    };

    const unknown = await app.request("/settings/nope.nope", {
      method: "PUT",
      headers: humanH,
      body: JSON.stringify({ value: "x" }),
    });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toMatch(/unknown setting/i);

    const invalid = await app.request("/settings/dispatch.max_concurrent", {
      method: "PUT",
      headers: humanH,
      body: JSON.stringify({ value: "not a number" }),
    });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: string }).error).toMatch(/positive integer/i);
  });

  it("DELETE /settings/:key: human ok (resets to default), agent rejected", async () => {
    const db = openDb(":memory:");
    const app = buildApiRoutes(db);
    const humanH = {
      authorization: `Bearer ${createActor(db, { name: "sean", type: "human" }).token}`,
      "content-type": "application/json",
    };
    const agentH = {
      authorization: `Bearer ${createActor(db, { name: "claude/dev", type: "agent" }).token}`,
      "content-type": "application/json",
    };

    await app.request("/settings/instance.name", {
      method: "PUT",
      headers: humanH,
      body: JSON.stringify({ value: "Acme Tracker" }),
    });

    const agentDelete = await app.request("/settings/instance.name", {
      method: "DELETE",
      headers: agentH,
    });
    expect(agentDelete.status).toBe(400);
    expect(((await agentDelete.json()) as { error: string }).error).toMatch(/human-only/i);

    const humanDelete = await app.request("/settings/instance.name", {
      method: "DELETE",
      headers: humanH,
    });
    expect(humanDelete.status).toBe(200);
    const reset = (await humanDelete.json()) as { value: string; isDefault: boolean };
    expect(reset.isDefault).toBe(true);
    expect(reset.value).toBe("Switchyard");
  });

  it("GET /dispatch-policy is agent-readable and returns only the dispatch.* group", async () => {
    const db = openDb(":memory:");
    const app = buildApiRoutes(db);
    const humanToken = createActor(db, { name: "sean", type: "human" }).token;
    const agentToken = createActor(db, { name: "claude/worker", type: "agent" }).token;

    await app.request("/settings/dispatch.max_concurrent", {
      method: "PUT",
      headers: { authorization: `Bearer ${humanToken}`, "content-type": "application/json" },
      body: JSON.stringify({ value: 3 }),
    });

    const res = await app.request("/dispatch-policy", {
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      maxConcurrent: 3,
      maxAnswerConcurrent: 2,
      intervalSeconds: 300,
      eventPollSeconds: 15,
      heartbeatWindowSeconds: 600,
    });
  });
});
