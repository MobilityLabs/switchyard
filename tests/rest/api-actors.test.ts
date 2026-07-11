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

describe("actor routes", () => {
  it("GET /actors returns the extended shape with hasToken and no token material", async () => {
    const res = await app.request("/actors", { headers: { cookie } });
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(2);
    for (const a of list) {
      expect(typeof a.createdAt).toBe("number");
      expect(typeof a.hasToken).toBe("boolean");
      expect(a).not.toHaveProperty("tokenHash");
      expect(a).not.toHaveProperty("token");
    }
  });

  it("POST /actors creates an actor and returns {actor, token}, human-only", async () => {
    const denied = await app.request("/actors", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "claude/other", type: "agent" }),
    });
    expect(denied.status).toBe(400);
    expect(((await denied.json()) as { error: string }).error).toMatch(/only humans/i);

    const res = await app.request("/actors", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "claude/other", type: "agent" }),
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { actor: { id: number; name: string }; token: string };
    expect(created.actor.name).toBe("claude/other");
    expect(created.token).toMatch(/^syd_[0-9a-f]{48}$/);
  });

  it("POST /actors/:id/rotate-token rotates, human-only, and the old token stops working", async () => {
    const worker = (await (
      await app.request("/actors", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "claude/worker", type: "agent" }),
      })
    ).json()) as { actor: { id: number }; token: string };

    const denied = await app.request(`/actors/${worker.actor.id}/rotate-token`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(denied.status).toBe(400);
    expect(((await denied.json()) as { error: string }).error).toMatch(/only humans/i);

    const res = await app.request(`/actors/${worker.actor.id}/rotate-token`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const { token: newToken } = (await res.json()) as { token: string };
    expect(newToken).not.toBe(worker.token);

    const oldStillWorks = await app.request("/me", {
      headers: { authorization: `Bearer ${worker.token}` },
    });
    expect(oldStillWorks.status).toBe(401);
    const newWorks = await app.request("/me", { headers: { authorization: `Bearer ${newToken}` } });
    expect(newWorks.status).toBe(200);
  });

  it("DELETE /actors/:id/token revokes, human-only, and refuses self-revoke", async () => {
    const worker = (await (
      await app.request("/actors", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "claude/worker", type: "agent" }),
      })
    ).json()) as { actor: { id: number }; token: string };

    const denied = await app.request(`/actors/${worker.actor.id}/token`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(denied.status).toBe(400);
    expect(((await denied.json()) as { error: string }).error).toMatch(/only humans/i);

    const res = await app.request(`/actors/${worker.actor.id}/token`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const revoked = await app.request("/me", {
      headers: { authorization: `Bearer ${worker.token}` },
    });
    expect(revoked.status).toBe(401);

    // Self-revoke: find sean's own actor id from the list.
    const list = (await (await app.request("/actors", { headers: { cookie } })).json()) as Array<{
      id: number;
      name: string;
    }>;
    const sean = list.find((a) => a.name === "sean")!;
    const selfRevoke = await app.request(`/actors/${sean.id}/token`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(selfRevoke.status).toBe(400);
    expect(((await selfRevoke.json()) as { error: string }).error).toMatch(
      /cannot revoke your own/i,
    );
  });

  it("rotate/revoke 400 with a legible error for an unknown actor id", async () => {
    const rotate = await app.request("/actors/999/rotate-token", {
      method: "POST",
      headers: { cookie },
    });
    expect(rotate.status).toBe(400);
    expect(((await rotate.json()) as { error: string }).error).toMatch(/no actor with id 999/i);

    const revoke = await app.request("/actors/999/token", {
      method: "DELETE",
      headers: { cookie },
    });
    expect(revoke.status).toBe(400);
    expect(((await revoke.json()) as { error: string }).error).toMatch(/no actor with id 999/i);
  });

  it("POST /actors/:id/login-link mints a login url, human-only, human targets only", async () => {
    const list = (await (await app.request("/actors", { headers: { cookie } })).json()) as Array<{
      id: number;
      name: string;
    }>;
    const sean = list.find((a) => a.name === "sean")!;

    const denied = await app.request(`/actors/${sean.id}/login-link`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(denied.status).toBe(400);
    expect(((await denied.json()) as { error: string }).error).toMatch(/only humans/i);

    const res = await app.request(`/actors/${sean.id}/login-link`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const base = process.env.SWITCHYARD_URL ?? "http://localhost:3300";
    expect(url.startsWith(base)).toBe(true);
    expect(url).toMatch(/\/auth\/login\?token=/);

    const agentActor = list.find((a) => a.name === "claude/dev")!;
    const agentTarget = await app.request(`/actors/${agentActor.id}/login-link`, {
      method: "POST",
      headers: { cookie },
    });
    expect(agentTarget.status).toBe(400);
    expect(((await agentTarget.json()) as { error: string }).error).toMatch(
      /agents authenticate with their bearer token/i,
    );
  });
});
