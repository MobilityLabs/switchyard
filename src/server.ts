import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { bodyLimit } from "hono/body-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toReqRes, toFetchResponse } from "fetch-to-node";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Db } from "./db/index.js";
import { authenticate } from "./services/actors.js";
import { buildMcpServer } from "./mcp/server.js";
import { buildAuthRoutes } from "./rest/auth-routes.js";
import { buildApiRoutes } from "./rest/api-routes.js";
import { buildGithubWebhookRoutes } from "./rest/github-routes.js";

// Paths the client-side router never owns — anything under these should 404
// as JSON (or be handled by their own route) rather than fall back to the SPA shell.
const SPA_EXCLUDED_PREFIXES = ["/api", "/auth", "/mcp", "/health", "/attachments", "/webhooks"];

// Modest cap for JSON/RPC traffic (issue bodies, MCP tool calls, GitHub webhook
// deliveries). better-sqlite3 is synchronous and Node is single-threaded, so an
// oversized body — or the heavy query/tool call it drives — can stall the whole
// server; this is generous for any legitimate payload while blocking that. The
// attachment upload route sets its own larger limit (see api-routes.ts) and is
// exempted below since it's mounted under the same /api/* prefix.
const JSON_BODY_LIMIT = 1024 * 1024; // 1MB

const ATTACHMENT_UPLOAD_PATH = /^\/api\/issues\/[^/]+\/attachments$/;

function jsonBodyLimit() {
  return bodyLimit({
    maxSize: JSON_BODY_LIMIT,
    onError: (c) => c.json({ error: "Request body too large — the limit is 1MB." }, 413),
  });
}

// Cached lazily: undefined = not yet attempted, null = build missing.
let cachedIndexHtml: string | null | undefined;

async function loadIndexHtml(): Promise<string | null> {
  if (cachedIndexHtml !== undefined) return cachedIndexHtml;
  try {
    cachedIndexHtml = await fs.readFile(path.join("./dist/ui", "index.html"), "utf-8");
  } catch {
    cachedIndexHtml = null;
  }
  return cachedIndexHtml;
}

export function createApp(db: Db) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.route("/", buildAuthRoutes(db));

  app.use("/webhooks/github", jsonBodyLimit());
  app.route("/", buildGithubWebhookRoutes(db));

  app.use("/api/*", (c, next) =>
    ATTACHMENT_UPLOAD_PATH.test(c.req.path) ? next() : jsonBodyLimit()(c, next)
  );
  app.route("/api", buildApiRoutes(db));

  app.use("/mcp", jsonBodyLimit());
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
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      // NB: don't pre-parse the body ourselves (e.g. `await c.req.json()`) — the
      // transport's internal request listener reads `req`'s body stream itself,
      // and that stream is the same one `toReqRes` wired up. Reading it twice
      // throws "ReadableStream is locked".
      await transport.handleRequest(req, res);
    } catch (err) {
      transport.close();
      server.close();
      throw err;
    }
    return toFetchResponse(res);
  });

  app.on(["GET", "DELETE"], "/mcp", (c) =>
    c.json({ error: "Method not allowed — POST JSON-RPC to /mcp." }, 405)
  );

  app.use("/*", serveStatic({ root: "./dist/ui" }));

  // SPA fallback: any GET that isn't a static asset, an API/auth/mcp/health/
  // attachments route, and has no file extension (e.g. /issue/SYD-1, /board/SYD,
  // /review) gets the client shell so the History-API router can take over.
  app.get("*", async (c) => {
    const p = c.req.path;
    if (SPA_EXCLUDED_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`))) {
      return c.notFound();
    }
    if (path.extname(p)) return c.notFound();
    const html = await loadIndexHtml();
    if (html === null) {
      return c.json({ error: "UI build not found — run `npm run build:ui` first." }, 404);
    }
    return c.html(html);
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
  const { startWebhookDispatcher } = await import("./services/webhook-dispatcher.js");
  startWebhookDispatcher(db);
}
