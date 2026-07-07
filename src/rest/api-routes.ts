import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Db } from "../db/index.js";
import { SwitchyardError } from "../services/errors.js";
import { authenticate, listActors, type Actor } from "../services/actors.js";
import { getSessionActor } from "../services/auth.js";
import { createProject, listProjects } from "../services/projects.js";
import { SESSION_COOKIE } from "./auth-routes.js";

type Env = { Variables: { actor: Actor } };

export function buildApiRoutes(db: Db) {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    const authz = c.req.header("authorization") ?? "";
    let actor: Actor | null = null;
    if (authz.startsWith("Bearer ")) actor = authenticate(db, authz.slice(7));
    if (!actor) {
      const st = getCookie(c, SESSION_COOKIE);
      if (st) actor = getSessionActor(db, st);
    }
    if (!actor) {
      return c.json({ error: "Authentication required — pass a bearer token or log in via a login link." }, 401);
    }
    c.set("actor", actor);
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof SwitchyardError) return c.json({ error: err.message }, 400);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/projects", (c) => c.json(listProjects(db)));
  app.post("/projects", async (c) => {
    const body = (await c.req.json()) as { key: string; name: string };
    return c.json(createProject(db, body));
  });
  app.get("/actors", (c) => c.json(listActors(db)));

  return app;
}
