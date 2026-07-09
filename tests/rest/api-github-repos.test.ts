import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

describe("github repo routes", () => {
  it("links, lists, deletes, and redacts secrets", async () => {
    const db = openDb(":memory:");
    const h = {
      authorization: `Bearer ${createActor(db, { name: "sean", type: "human" }).token}`,
      "content-type": "application/json",
    };
    const app = buildApiRoutes(db);

    const createdRes = await app.request("/github-repos", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ fullName: "acme/widgets" }),
    });
    expect(createdRes.status).toBe(200);
    const created = (await createdRes.json()) as { id: number; fullName: string; hasSecret?: boolean; secret?: unknown };
    expect(created.fullName).toBe("acme/widgets");
    expect(created.hasSecret).toBe(false);
    expect(created.secret).toBeUndefined();

    const withSecretRes = await app.request("/github-repos", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ fullName: "acme/syd", secret: "s3cret" }),
    });
    expect(withSecretRes.status).toBe(200);
    const withSecret = (await withSecretRes.json()) as { hasSecret?: boolean; secret?: unknown };
    expect(withSecret.hasSecret).toBe(true);
    expect(withSecret.secret).toBeUndefined();

    const listRes = await app.request("/github-repos", { headers: h });
    const repos = (await listRes.json()) as Array<{ id: number; secret?: unknown }>;
    expect(repos).toHaveLength(2);
    for (const repo of repos) expect(repo.secret).toBeUndefined();

    const deleteRes = await app.request(`/github-repos/${created.id}`, { method: "DELETE", headers: h });
    expect(deleteRes.status).toBe(200);
    const remaining = (await (await app.request("/github-repos", { headers: h })).json()) as Array<{ id: number }>;
    expect(remaining).toHaveLength(1);
  });

  it("rejects agent actors managing linked repos but allows agent reads", async () => {
    const db = openDb(":memory:");
    const agentH = {
      authorization: `Bearer ${createActor(db, { name: "claude/dev", type: "agent" }).token}`,
      "content-type": "application/json",
    };
    const app = buildApiRoutes(db);

    const createRes = await app.request("/github-repos", {
      method: "POST",
      headers: agentH,
      body: JSON.stringify({ fullName: "acme/widgets" }),
    });
    expect(createRes.status).toBe(400);
    expect(((await createRes.json()) as { error: string }).error).toMatch(/only humans manage linked github repos/i);

    const deleteRes = await app.request("/github-repos/1", { method: "DELETE", headers: agentH });
    expect(deleteRes.status).toBe(400);
    expect(((await deleteRes.json()) as { error: string }).error).toMatch(/only humans manage linked github repos/i);

    const listRes = await app.request("/github-repos", { headers: agentH });
    expect(listRes.status).toBe(200);
  });
});
