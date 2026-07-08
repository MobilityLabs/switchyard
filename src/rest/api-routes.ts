import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { Db } from "../db/index.js";
import { SwitchyardError } from "../services/errors.js";
import { authenticate, listActors, type Actor } from "../services/actors.js";
import { getSessionActor } from "../services/auth.js";
import { createProject, listProjects } from "../services/projects.js";
import { SESSION_COOKIE } from "./auth-routes.js";
import type { Status } from "../db/schema.js";
import { createIssue, getIssue, updateIssue, claimIssue } from "../services/issues.js";
import { addDependency, nextTask } from "../services/dependencies.js";
import { addComment, getActivity } from "../services/comments.js";
import { searchIssues } from "../services/search.js";
import { requestHumanInput } from "../services/needs-input.js";
import { snoozeIssue, markDuplicate } from "../services/triage-actions.js";
import { addWebhook, listWebhooks, removeWebhook, setWebhookActive, type Webhook } from "../services/webhooks.js";
import {
  body,
  projectBody,
  issueCreateBody,
  issueUpdateBody,
  commentBody,
  dependencyBody,
  webhookCreateBody,
  webhookPatchBody,
  requestInputBody,
  snoozeBody,
  duplicateBody,
} from "./schemas.js";

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
    if (err instanceof SyntaxError || (err instanceof HTTPException && /malformed json/i.test(err.message))) {
      return c.json({ error: "Request body is not valid JSON — send a JSON object." }, 400);
    }
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/projects", (c) => c.json(listProjects(db)));
  app.post("/projects", body(projectBody), (c) => c.json(createProject(db, c.req.valid("json"))));
  app.get("/actors", (c) => c.json(listActors(db)));
  app.get("/me", (c) => c.json(c.var.actor));

  app.get("/issues", (c) =>
    c.json(searchIssues(db, {
      projectKey: c.req.query("project") || undefined,
      status: (c.req.query("status") as Status | undefined) || undefined,
      assigneeName: c.req.query("assignee") || undefined,
      label: c.req.query("label") || undefined,
      text: c.req.query("text") || undefined,
      needsInput: c.req.query("needs_input") === "true" ? true : undefined,
      excludeSnoozed: c.req.query("exclude_snoozed") === "true" ? true : undefined,
    }))
  );

  app.post("/issues", body(issueCreateBody), (c) =>
    c.json(createIssue(db, c.var.actor, c.req.valid("json")))
  );

  app.get("/issues/:ref", (c) => {
    const ref = c.req.param("ref");
    return c.json({ ...getIssue(db, ref), activity: getActivity(db, ref) });
  });

  app.patch("/issues/:ref", body(issueUpdateBody), (c) =>
    c.json(updateIssue(db, c.var.actor, c.req.param("ref"), c.req.valid("json")))
  );

  app.post("/issues/:ref/claim", (c) => c.json(claimIssue(db, c.var.actor, c.req.param("ref"))));

  app.post("/issues/:ref/comments", body(commentBody), (c) => {
    addComment(db, c.var.actor, c.req.param("ref"), c.req.valid("json").body);
    return c.json({ ok: true });
  });

  app.post("/issues/:ref/request-input", body(requestInputBody), (c) =>
    c.json(requestHumanInput(db, c.var.actor, c.req.param("ref"), c.req.valid("json").question))
  );

  app.post("/issues/:ref/snooze", body(snoozeBody), (c) =>
    c.json(snoozeIssue(db, c.var.actor, c.req.param("ref"), c.req.valid("json").until))
  );

  app.post("/issues/:ref/duplicate", body(duplicateBody), (c) =>
    c.json(markDuplicate(db, c.var.actor, c.req.param("ref"), c.req.valid("json").of))
  );

  app.get("/next-task", (c) => c.json(nextTask(db, c.var.actor, c.req.query("project") || undefined)));

  app.post("/dependencies", body(dependencyBody), (c) => {
    const { blockerRef, blockedRef } = c.req.valid("json");
    addDependency(db, c.var.actor, blockerRef, blockedRef);
    return c.json({ ok: true });
  });

  // Redact secret from webhook objects for safe API responses
  const redact = ({ secret, ...rest }: Webhook) => ({ ...rest, hasSecret: secret !== null });

  app.get("/webhooks", (c) => c.json(listWebhooks(db).map(redact)));
  app.post("/webhooks", body(webhookCreateBody), (c) => {
    if (c.var.actor.type === "agent") {
      throw new SwitchyardError(
        "Only humans manage webhooks — ask a human to add or remove webhook endpoints."
      );
    }
    return c.json(redact(addWebhook(db, c.req.valid("json"))));
  });
  app.delete("/webhooks/:id", (c) => {
    if (c.var.actor.type === "agent") {
      throw new SwitchyardError(
        "Only humans manage webhooks — ask a human to add or remove webhook endpoints."
      );
    }
    removeWebhook(db, Number(c.req.param("id")));
    return c.json({ ok: true });
  });
  app.patch("/webhooks/:id", body(webhookPatchBody), (c) => {
    if (c.var.actor.type === "agent") {
      throw new SwitchyardError(
        "Only humans manage webhooks — ask a human to add or remove webhook endpoints."
      );
    }
    const { active } = c.req.valid("json");
    return c.json(redact(setWebhookActive(db, Number(c.req.param("id")), active)));
  });

  return app;
}
