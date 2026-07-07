import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toReqRes, toFetchResponse } from "fetch-to-node";
import type { Db } from "./db/index.js";
import { authenticate } from "./services/actors.js";
import { buildMcpServer } from "./mcp/server.js";

export function createApp(db: Db) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/mcp", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const actor = token ? authenticate(db, token) : null;
    if (!actor) {
      return c.json(
        { error: "Missing or invalid bearer token — mint one with the switchyard CLI." },
        401
      );
    }
    const { req, res } = toReqRes(c.req.raw);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildMcpServer(db, actor);
    await server.connect(transport);
    // NB: don't pre-parse the body ourselves (e.g. `await c.req.json()`) — the
    // transport's internal request listener reads `req`'s body stream itself,
    // and that stream is the same one `toReqRes` wired up. Reading it twice
    // throws "ReadableStream is locked".
    await transport.handleRequest(req, res);
    res.on("close", () => {
      transport.close();
      server.close();
    });
    return toFetchResponse(res);
  });

  return app;
}

export function startServer(db: Db, port: number) {
  return serve({ fetch: createApp(db).fetch, port }, (info) =>
    console.log(`switchyard listening on :${info.port}`)
  );
}

// Entrypoint: `npm run dev` (tsx src/server.ts)
if (import.meta.url === `file://${process.argv[1]}`) {
  const { openDb } = await import("./db/index.js");
  const db = openDb(process.env.SWITCHYARD_DB ?? "switchyard.db");
  startServer(db, Number(process.env.PORT ?? 3300));
}
