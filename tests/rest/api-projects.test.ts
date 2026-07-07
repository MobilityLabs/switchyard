import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createLoginLink, redeemLoginLink } from "../../src/services/auth.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

let db: Db, app: ReturnType<typeof buildApiRoutes>, bearer: string, cookie: string;

beforeEach(() => {
  db = openDb(":memory:");
  bearer = createActor(db, { name: "claude/dev", type: "agent" }).token;
  createActor(db, { name: "sean", type: "human" });
  const { token } = createLoginLink(db, "sean");
  cookie = `switchyard_session=${redeemLoginLink(db, token).sessionToken}`;
  app = buildApiRoutes(db);
});

describe("api auth + projects", () => {
  it("401s without credentials, works with bearer or cookie", async () => {
    expect((await app.request("/projects")).status).toBe(401);
    const viaBearer = await app.request("/projects", { headers: { authorization: `Bearer ${bearer}` } });
    expect(viaBearer.status).toBe(200);
    const created = await app.request("/projects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ key: "SYD", name: "Switchyard" }),
    });
    expect(created.status).toBe(200);
    expect(((await created.json()) as { key: string }).key).toBe("SYD");
  });

  it("maps SwitchyardError to 400 with the message", async () => {
    const res = await app.request("/projects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ key: "bad key", name: "x" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/2–10 uppercase letters/);
  });

  it("lists actors without leaking token hashes", async () => {
    const res = await app.request("/actors", { headers: { cookie } });
    const list = (await res.json()) as Record<string, unknown>[];
    expect(list.map((a) => a.name).sort()).toEqual(["claude/dev", "sean"]);
    for (const a of list) expect(a).not.toHaveProperty("tokenHash");
  });
});
