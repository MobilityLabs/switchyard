import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

let db: Db, app: ReturnType<typeof buildApiRoutes>, h: Record<string, string>;
beforeEach(() => {
  db = openDb(":memory:");
  h = {
    authorization: `Bearer ${createActor(db, { name: "sean", type: "human" }).token}`,
    "content-type": "application/json",
  };
  createProject(db, { key: "SYD", name: "Switchyard" });
  app = buildApiRoutes(db);
});

const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: h, body: JSON.stringify(body) });

describe("request validation", () => {
  it("rejects wrong-typed and missing fields with legible 400s", async () => {
    const noTitle = await post("/issues", { projectKey: "SYD" });
    expect(noTitle.status).toBe(400);
    expect(((await noTitle.json()) as { error: string }).error).toMatch(/title/);

    const badPriority = await post("/issues", { projectKey: "SYD", title: "x", priority: "mega" });
    expect(badPriority.status).toBe(400);
    expect(((await badPriority.json()) as { error: string }).error).toMatch(/priority/);

    const badStatus = await app.request("/issues/SYD-1", {
      method: "PATCH", headers: h, body: JSON.stringify({ status: "doing" }),
    });
    expect(badStatus.status).toBe(400);

    const badUrl = await post("/webhooks", { url: 42 });
    expect(badUrl.status).toBe(400);
    expect(((await badUrl.json()) as { error: string }).error).toMatch(/url/);
  });

  it("valid bodies still work end to end", async () => {
    const created = await post("/issues", { projectKey: "SYD", title: "Real one", priority: "high" });
    expect(created.status).toBe(200);
    expect(((await created.json()) as { ref: string }).ref).toBe("SYD-1");
  });
});
