import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createLoginLink } from "../../src/services/auth.js";
import { addWebhook } from "../../src/services/webhooks.js";
import { dispatchPending } from "../../src/services/webhook-dispatcher.js";
import { createApp } from "../../src/server.js";

let db: Db, server: ServerType, base: string, agentToken: string;
let receiver: ServerType;
const hookBodies: string[] = [];

beforeAll(async () => {
  db = openDb(":memory:");
  agentToken = createActor(db, { name: "claude/dev", type: "agent" }).token;
  const human = createActor(db, { name: "sean", type: "human" }).actor;
  createProject(db, { key: "SYD", name: "Switchyard" });

  server = await new Promise((resolve) => {
    const s = serve({ fetch: createApp(db).fetch, port: 0 }, (i) => {
      base = `http://127.0.0.1:${i.port}`;
      resolve(s);
    });
  });
  const rec = new Hono().post("/hook", async (c) => {
    hookBodies.push(await c.req.text());
    return c.json({ ok: true });
  });
  receiver = await new Promise((resolve) => {
    const s = serve({ fetch: rec.fetch, port: 0 }, (i) => {
      addWebhook(db, human, { url: `http://127.0.0.1:${i.port}/hook` });
      resolve(s);
    });
  });
});

afterAll(() => { server.close(); receiver.close(); });

describe("plan 2 loop", () => {
  it("login link -> cookie -> full REST loop with triage gate and webhooks", async () => {
    const { path } = createLoginLink(db, "sean");
    const login = await fetch(base + path, { redirect: "manual" });
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe("/");
    const cookie = login.headers.get("set-cookie")!.split(";")[0];

    const agentH = { authorization: `Bearer ${agentToken}`, "content-type": "application/json" };
    const humanH = { cookie, "content-type": "application/json" };

    const filed = await (await fetch(`${base}/api/issues`, {
      method: "POST", headers: agentH,
      body: JSON.stringify({
        projectKey: "SYD", title: "Found a bug",
        description: "Encountered while exercising the REST loop; the response shape didn't match the documented schema. Suggest verifying the serializer.",
        provenance: { sourceType: "session", detail: "rest-loop test" },
      }),
    })).json() as { ref: string; status: string };
    expect(filed.status).toBe("triage");

    const denied = await fetch(`${base}/api/issues/${filed.ref}`, {
      method: "PATCH", headers: agentH, body: JSON.stringify({ status: "todo" }),
    });
    expect(denied.status).toBe(400);

    const ok = await fetch(`${base}/api/issues/${filed.ref}`, {
      method: "PATCH", headers: humanH, body: JSON.stringify({ status: "todo" }),
    });
    expect(ok.status).toBe(200);

    await fetch(`${base}/api/issues/${filed.ref}/claim`, { method: "POST", headers: agentH });

    expect(await dispatchPending(db)).toBeGreaterThanOrEqual(3);
    const eventsSeen = hookBodies.map((b) => JSON.parse(b).event);
    expect(eventsSeen).toContain("created");
    expect(eventsSeen).toContain("status_changed");
  });

  it("unauthenticated API requests 401", async () => {
    expect((await fetch(`${base}/api/issues`)).status).toBe(401);
  });
});
