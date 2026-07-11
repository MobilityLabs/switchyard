import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createLoginLink, getSessionActor } from "../../src/services/auth.js";
import { buildAuthRoutes } from "../../src/rest/auth-routes.js";

describe("auth routes", () => {
  it("login sets a session cookie; logout clears it", async () => {
    const db = openDb(":memory:");
    createActor(db, { name: "sean", type: "human" });
    const app = buildAuthRoutes(db);
    const { path } = createLoginLink(db, "sean");

    const res = await app.request(path);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/switchyard_session=sys_/);
    expect(cookie).toMatch(/HttpOnly/i);
    const sessionToken = /switchyard_session=([^;]+)/.exec(cookie)![1];
    expect(getSessionActor(db, sessionToken)?.name).toBe("sean");

    const out = await app.request("/auth/logout", {
      method: "POST",
      headers: { cookie: `switchyard_session=${sessionToken}` },
    });
    expect(out.status).toBe(200);
    expect(getSessionActor(db, sessionToken)).toBeNull();
  });

  it("bad or missing tokens are rejected legibly", async () => {
    const db = openDb(":memory:");
    const app = buildAuthRoutes(db);
    expect((await app.request("/auth/login")).status).toBe(400);
    const res = await app.request("/auth/login?token=syl_deadbeef");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /invalid, expired, or already used/i,
    );
  });

  it("omits the Secure flag by default (plain-http deployments keep working)", async () => {
    delete process.env.SWITCHYARD_COOKIE_SECURE;
    const db = openDb(":memory:");
    createActor(db, { name: "sean", type: "human" });
    const app = buildAuthRoutes(db);
    const { path } = createLoginLink(db, "sean");

    const res = await app.request(path);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).not.toMatch(/secure/i);
  });

  it("sets the Secure flag when SWITCHYARD_COOKIE_SECURE=1", async () => {
    process.env.SWITCHYARD_COOKIE_SECURE = "1";
    try {
      const db = openDb(":memory:");
      createActor(db, { name: "sean", type: "human" });
      const app = buildAuthRoutes(db);
      const { path } = createLoginLink(db, "sean");

      const res = await app.request(path);
      const cookie = res.headers.get("set-cookie")!;
      expect(cookie).toMatch(/secure/i);
    } finally {
      delete process.env.SWITCHYARD_COOKIE_SECURE;
    }
  });
});
