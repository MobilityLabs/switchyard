import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Db } from "../db/index.js";
import { SwitchyardError } from "../services/errors.js";
import { authenticate, listActors, type Actor } from "../services/actors.js";
import { getSessionActor } from "../services/auth.js";
import { createProject, listProjects } from "../services/projects.js";
import { SESSION_COOKIE } from "./auth-routes.js";
import type { Status } from "../db/schema.js";
import {
  createIssue, getIssue, updateIssue, claimIssue,
  type CreateIssueInput, type UpdateIssueInput,
} from "../services/issues.js";
import { addDependency, nextTask } from "../services/dependencies.js";
import { addComment, getActivity } from "../services/comments.js";
import { searchIssues } from "../services/search.js";
import { addWebhook, listWebhooks, removeWebhook, type Webhook } from "../services/webhooks.js";

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

  app.get("/issues", (c) =>
    c.json(searchIssues(db, {
      projectKey: c.req.query("project") || undefined,
      status: (c.req.query("status") as Status | undefined) || undefined,
      assigneeName: c.req.query("assignee") || undefined,
      label: c.req.query("label") || undefined,
      text: c.req.query("text") || undefined,
    }))
  );

  app.post("/issues", async (c) => {
    const body = (await c.req.json()) as CreateIssueInput;
    return c.json(createIssue(db, c.var.actor, body));
  });

  app.get("/issues/:ref", (c) => {
    const ref = c.req.param("ref");
    return c.json({ ...getIssue(db, ref), activity: getActivity(db, ref) });
  });

  app.patch("/issues/:ref", async (c) => {
    const body = (await c.req.json()) as UpdateIssueInput;
    return c.json(updateIssue(db, c.var.actor, c.req.param("ref"), body));
  });

  app.post("/issues/:ref/claim", (c) => c.json(claimIssue(db, c.var.actor, c.req.param("ref"))));

  app.post("/issues/:ref/comments", async (c) => {
    const { body } = (await c.req.json()) as { body: string };
    addComment(db, c.var.actor, c.req.param("ref"), body);
    return c.json({ ok: true });
  });

  app.get("/next-task", (c) => c.json(nextTask(db, c.var.actor, c.req.query("project") || undefined)));

  app.post("/dependencies", async (c) => {
    const { blockerRef, blockedRef } = (await c.req.json()) as { blockerRef: string; blockedRef: string };
    addDependency(db, c.var.actor, blockerRef, blockedRef);
    return c.json({ ok: true });
  });

  // Redact secret from webhook objects for safe API responses
  const redact = ({ secret, ...rest }: Webhook) => ({ ...rest, hasSecret: secret !== null });

  app.get("/webhooks", (c) => c.json(listWebhooks(db).map(redact)));
  app.post("/webhooks", async (c) => {
    const body = (await c.req.json()) as { url: string; projectKey?: string; secret?: string };
    return c.json(redact(addWebhook(db, body)));
  });
  app.delete("/webhooks/:id", (c) => {
    removeWebhook(db, Number(c.req.param("id")));
    return c.json({ ok: true });
  });

  return app;
}
