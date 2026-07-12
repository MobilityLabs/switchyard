import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue } from "../../src/services/issues.js";
import type { Actor } from "../../src/services/actors.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

let db: Db, app: ReturnType<typeof buildApiRoutes>, human: Actor;
let humanH: Record<string, string>;

beforeEach(() => {
  db = openDb(":memory:");
  const h = createActor(db, { name: "sean", type: "human" });
  human = h.actor;
  humanH = { authorization: `Bearer ${h.token}`, "content-type": "application/json" };
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  createIssue(db, human, { projectKey: "SYD", title: "Schema" }); // SYD-1
  createIssue(db, human, { projectKey: "SYD", title: "API" }); // SYD-2
  for (const ref of ["SYD-1", "SYD-2"]) updateIssue(db, human, ref, { status: "todo" });
  app = buildApiRoutes(db);
});

async function body<T>(r: Response): Promise<T> {
  return (await r.json()) as T;
}

type DepView = { ref: string; title: string; status: string };
type Detail = { dependencies: { blockedBy: DepView[]; blocks: DepView[] } };

describe("dependency routes", () => {
  it("issue detail carries both dependency directions", async () => {
    await app.request("/dependencies", {
      method: "POST",
      headers: humanH,
      body: JSON.stringify({ blockerRef: "SYD-1", blockedRef: "SYD-2" }),
    });
    const blocked = await body<Detail>(await app.request("/issues/SYD-2", { headers: humanH }));
    expect(blocked.dependencies.blockedBy).toEqual([
      { ref: "SYD-1", title: "Schema", status: "todo" },
    ]);
    expect(blocked.dependencies.blocks).toEqual([]);
    const blocker = await body<Detail>(await app.request("/issues/SYD-1", { headers: humanH }));
    expect(blocker.dependencies.blocks).toEqual([{ ref: "SYD-2", title: "API", status: "todo" }]);
  });

  it("DELETE /dependencies removes the edge; missing params are a 400", async () => {
    await app.request("/dependencies", {
      method: "POST",
      headers: humanH,
      body: JSON.stringify({ blockerRef: "SYD-1", blockedRef: "SYD-2" }),
    });
    const missing = await app.request("/dependencies?blockerRef=SYD-1", {
      method: "DELETE",
      headers: humanH,
    });
    expect(missing.status).toBe(400);
    const ok = await app.request("/dependencies?blockerRef=SYD-1&blockedRef=SYD-2", {
      method: "DELETE",
      headers: humanH,
    });
    expect(ok.status).toBe(200);
    const detail = await body<Detail>(await app.request("/issues/SYD-2", { headers: humanH }));
    expect(detail.dependencies.blockedBy).toEqual([]);
  });

  it("a cycle surfaces as a 400 with a legible error", async () => {
    await app.request("/dependencies", {
      method: "POST",
      headers: humanH,
      body: JSON.stringify({ blockerRef: "SYD-1", blockedRef: "SYD-2" }),
    });
    const res = await app.request("/dependencies", {
      method: "POST",
      headers: humanH,
      body: JSON.stringify({ blockerRef: "SYD-2", blockedRef: "SYD-1" }),
    });
    expect(res.status).toBe(400);
    expect((await body<{ error: string }>(res)).error).toMatch(/cycle/i);
  });
});
