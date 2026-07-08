import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { openDb, type Db } from "../../src/db/index.js";
import { createApp } from "../../src/server.js";

let db: Db, server: ServerType, base: string;

beforeAll(async () => {
  db = openDb(":memory:");
  server = await new Promise((resolve) => {
    const s = serve({ fetch: createApp(db).fetch, port: 0 }, (i) => {
      base = `http://127.0.0.1:${i.port}`;
      resolve(s);
    });
  });
});

afterAll(() => server.close());

describe("SPA fallback", () => {
  it("serves the UI shell for a client-routed path with no matching static file", async () => {
    const res = await fetch(`${base}/issue/SYD-1`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<title>Switchyard</title>");
  });

  it("serves the shell for other known client routes too", async () => {
    for (const p of ["/", "/board/SYD", "/review"]) {
      const res = await fetch(`${base}${p}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>Switchyard</title>");
    }
  });

  it("still returns JSON for unknown API routes, not the HTML shell", async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  it("leaves /health unaffected", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("doesn't hijack paths with a file extension that don't exist", async () => {
    const res = await fetch(`${base}/definitely-not-a-real-asset.js`);
    expect(res.status).toBe(404);
  });
});
