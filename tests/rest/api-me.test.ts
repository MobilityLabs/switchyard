import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

describe("GET /me", () => {
  it("returns the authenticated actor", async () => {
    const db = openDb(":memory:");
    const { token } = createActor(db, { name: "claude/dev", type: "agent" });
    const app = buildApiRoutes(db);
    const res = await app.request("/me", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    // attended is part of the identity a session should be able to read.
    expect(await res.json()).toEqual({
      id: 1,
      name: "claude/dev",
      type: "agent",
      attended: false,
    });
    expect((await app.request("/me")).status).toBe(401);
  });
});
