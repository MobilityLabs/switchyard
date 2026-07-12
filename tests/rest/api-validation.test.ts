import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";
import { SUMMARY_MAX_LENGTH } from "../../src/services/issues.js";

let db: Db, app: ReturnType<typeof buildApiRoutes>, h: Record<string, string>;
beforeEach(() => {
  db = openDb(":memory:");
  const sean = createActor(db, { name: "sean", type: "human" });
  h = {
    authorization: `Bearer ${sean.token}`,
    "content-type": "application/json",
  };
  createProject(db, sean.actor, { key: "SYD", name: "Switchyard" });
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
      method: "PATCH",
      headers: h,
      body: JSON.stringify({ status: "doing" }),
    });
    expect(badStatus.status).toBe(400);

    const badUrl = await post("/webhooks", { url: 42 });
    expect(badUrl.status).toBe(400);
    expect(((await badUrl.json()) as { error: string }).error).toMatch(/url/);

    const longSummary = await post("/issues", {
      projectKey: "SYD",
      title: "x",
      summary: "x".repeat(SUMMARY_MAX_LENGTH + 1),
    });
    expect(longSummary.status).toBe(400);
    expect(((await longSummary.json()) as { error: string }).error).toMatch(/summary/i);
  });

  it("valid bodies still work end to end", async () => {
    const created = await post("/issues", {
      projectKey: "SYD",
      title: "Real one",
      priority: "high",
    });
    expect(created.status).toBe(200);
    expect(((await created.json()) as { ref: string }).ref).toBe("SYD-1");
  });

  it("accepts and round-trips a summary within the cap", async () => {
    const created = await post("/issues", {
      projectKey: "SYD",
      title: "Real one",
      summary: "A concise summary.",
    });
    expect(created.status).toBe(200);
    expect(((await created.json()) as { summary: string }).summary).toBe("A concise summary.");
  });
});
