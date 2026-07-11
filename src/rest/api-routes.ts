import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import type { Db } from "../db/index.js";
import { SwitchyardError } from "../services/errors.js";
import {
  authenticate,
  createActor,
  getActorById,
  listActorsWithStatus,
  rotateActorToken,
  revokeActorToken,
  type Actor,
} from "../services/actors.js";
import { createLoginLink, getSessionActor } from "../services/auth.js";
import { createProject, listProjects } from "../services/projects.js";
import { SESSION_COOKIE } from "./auth-routes.js";
import type { Status } from "../db/schema.js";
import { createIssue, getIssue, updateIssue, claimIssue } from "../services/issues.js";
import {
  addDependency,
  listBlockedIssueIds,
  listDependencies,
  nextTask,
  removeDependency,
} from "../services/dependencies.js";
import { addComment, getActivity } from "../services/comments.js";
import { recordDeliveryEvent } from "../services/delivery-events.js";
import {
  startAgentSession,
  endAgentSession,
  listAgentSessions,
  recordProgressNote,
} from "../services/agent-sessions.js";
import { getAttention, listAttentionByIssueId } from "../services/attention.js";
import { getOpenPr, listOpenPrByIssueId } from "../services/pr-status.js";
import { listRecentEventsPage, listUnansweredQuestions } from "../services/events.js";
import { searchIssues, type SearchFilters } from "../services/search.js";
import { requestHumanInput } from "../services/needs-input.js";
import { snoozeIssue, markDuplicate, redeliverIssue } from "../services/triage-actions.js";
import {
  addWebhook,
  listWebhooks,
  removeWebhook,
  setWebhookActive,
  type Webhook,
} from "../services/webhooks.js";
import {
  addGithubRepo,
  listGithubRepos,
  removeGithubRepo,
  type GithubRepo,
} from "../services/github-repos.js";
import { handleGithubWebhook } from "../services/github-webhook.js";
import { getAllSettings, setSetting, resetSetting } from "../services/settings.js";
import {
  saveAttachment,
  getAttachment,
  listAttachments,
  defaultAttachmentsDir,
  MAX_ATTACHMENT_SIZE,
} from "../services/attachments.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  body,
  projectBody,
  issueCreateBody,
  issueUpdateBody,
  commentBody,
  deliveryEventBody,
  actorCreateBody,
  agentSessionCreateBody,
  agentSessionEndBody,
  progressNoteBody,
  dependencyBody,
  webhookCreateBody,
  webhookPatchBody,
  githubRepoCreateBody,
  githubEventBody,
  requestInputBody,
  snoozeBody,
  duplicateBody,
  settingPutBody,
} from "./schemas.js";

type Env = { Variables: { actor: Actor } };

function requireHumanCaller(actor: Actor, action: string): void {
  if (actor.type === "agent") {
    throw new SwitchyardError(`Only humans can ${action} — ask a human to do this.`);
  }
}

export function buildApiRoutes(db: Db, attachmentsDir: string = defaultAttachmentsDir()) {
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
      return c.json(
        { error: "Authentication required — pass a bearer token or log in via a login link." },
        401,
      );
    }
    c.set("actor", actor);
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof SwitchyardError) return c.json({ error: err.message }, 400);
    if (
      err instanceof SyntaxError ||
      (err instanceof HTTPException && /malformed json/i.test(err.message))
    ) {
      return c.json({ error: "Request body is not valid JSON — send a JSON object." }, 400);
    }
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/projects", (c) => c.json(listProjects(db)));
  app.post("/projects", body(projectBody), (c) => c.json(createProject(db, c.req.valid("json"))));
  app.get("/actors", (c) => c.json(listActorsWithStatus(db)));

  app.post("/actors", body(actorCreateBody), (c) => {
    requireHumanCaller(c.var.actor, "create an actor");
    return c.json(createActor(db, c.req.valid("json")));
  });

  const parseActorId = (idParam: string): number => {
    const id = Number(idParam);
    if (!Number.isInteger(id)) throw new SwitchyardError(`There is no actor with id ${idParam}.`);
    return id;
  };

  app.post("/actors/:id/rotate-token", (c) =>
    c.json(rotateActorToken(db, c.var.actor, parseActorId(c.req.param("id")))),
  );

  app.delete("/actors/:id/token", (c) => {
    revokeActorToken(db, c.var.actor, parseActorId(c.req.param("id")));
    return c.json({ ok: true });
  });

  app.post("/actors/:id/login-link", (c) => {
    requireHumanCaller(c.var.actor, "mint a login link");
    const target = getActorById(db, parseActorId(c.req.param("id")));
    const { path } = createLoginLink(db, target.name);
    const base = process.env.SWITCHYARD_URL ?? "http://localhost:3300";
    return c.json({ url: base + path });
  });

  app.get("/me", (c) => c.json(c.var.actor));

  app.get("/issues", (c) => {
    const results = searchIssues(db, {
      projectKey: c.req.query("project") || undefined,
      status: (c.req.query("status") as Status | undefined) || undefined,
      assigneeName: c.req.query("assignee") || undefined,
      label: c.req.query("label") || undefined,
      text: c.req.query("text") || undefined,
      needsInput: c.req.query("needs_input") === "true" ? true : undefined,
      excludeSnoozed: c.req.query("exclude_snoozed") === "true" ? true : undefined,
      attention: (c.req.query("attention") as SearchFilters["attention"]) || undefined,
    });
    const attention = listAttentionByIssueId(db);
    const openPrs = listOpenPrByIssueId(db);
    const blocked = listBlockedIssueIds(db);
    return c.json(
      results.map((r) => ({
        ...r,
        attention: attention.get(r.id) ?? null,
        openPr: openPrs.get(r.id) ?? null,
        blocked: blocked.has(r.id),
      })),
    );
  });

  app.post("/issues", body(issueCreateBody), (c) =>
    c.json(createIssue(db, c.var.actor, c.req.valid("json"))),
  );

  app.get("/issues/:ref", (c) => {
    const ref = c.req.param("ref");
    const issue = getIssue(db, ref);
    return c.json({
      ...issue,
      attention: getAttention(db, issue.id),
      openPr: getOpenPr(db, issue.id),
      activity: getActivity(db, ref),
      dependencies: listDependencies(db, ref),
      attachments: listAttachments(db, ref),
    });
  });

  app.patch("/issues/:ref", body(issueUpdateBody), (c) =>
    c.json(updateIssue(db, c.var.actor, c.req.param("ref"), c.req.valid("json"))),
  );

  app.post("/issues/:ref/claim", (c) => c.json(claimIssue(db, c.var.actor, c.req.param("ref"))));

  app.post("/issues/:ref/comments", body(commentBody), (c) => {
    addComment(db, c.var.actor, c.req.param("ref"), c.req.valid("json").body);
    return c.json({ ok: true });
  });

  app.post("/issues/:ref/delivery-events", body(deliveryEventBody), (c) => {
    recordDeliveryEvent(db, c.var.actor, c.req.param("ref"), c.req.valid("json"));
    return c.json({ ok: true });
  });

  app.get("/agent-sessions", (c) =>
    c.json(
      listAgentSessions(db, {
        active: c.req.query("active") === "true" ? true : undefined,
        ref: c.req.query("ref") || undefined,
      }),
    ),
  );

  app.post("/agent-sessions", body(agentSessionCreateBody), (c) =>
    c.json(startAgentSession(db, c.var.actor, c.req.valid("json"))),
  );

  app.patch("/agent-sessions/:id", body(agentSessionEndBody), (c) => {
    const idParam = c.req.param("id");
    const id = Number(idParam);
    if (!Number.isInteger(id))
      throw new SwitchyardError(`Agent session ${idParam} does not exist.`);
    return c.json(endAgentSession(db, c.var.actor, id, c.req.valid("json").exitCode));
  });

  app.post("/issues/:ref/progress-note", body(progressNoteBody), (c) => {
    recordProgressNote(db, c.var.actor, c.req.param("ref"), c.req.valid("json").note);
    return c.json({ ok: true });
  });

  app.post(
    "/issues/:ref/attachments",
    bodyLimit({
      maxSize: 21 * 1024 * 1024,
      onError: (c) => c.json({ error: "Attachment too large — the limit is 20MB." }, 413),
    }),
    async (c) => {
      const parsed = await c.req.parseBody();
      const file = parsed["file"];
      if (!(file instanceof File)) {
        throw new SwitchyardError('Upload must include a multipart field named "file".');
      }
      // Check the declared size before doing the second copy (Blob -> Buffer) —
      // avoids buffering an oversized upload just to reject it. (Belt-and-braces:
      // the bodyLimit middleware above already rejects oversized bodies pre-buffer.)
      if (file.size > MAX_ATTACHMENT_SIZE) {
        throw new SwitchyardError(
          `Attachment is ${(file.size / (1024 * 1024)).toFixed(1)}MB — attachments must be 20MB or smaller.`,
        );
      }
      const data = Buffer.from(await file.arrayBuffer());
      const { attachment, markdown } = await saveAttachment(
        db,
        c.var.actor,
        c.req.param("ref"),
        file.name,
        data,
        attachmentsDir,
      );
      const url = `/api/attachments/${attachment.id}/${attachment.filename}`;
      return c.json({ id: attachment.id, url, markdown });
    },
  );

  app.get("/issues/:ref/attachments", (c) => c.json(listAttachments(db, c.req.param("ref"))));

  app.get("/attachments/:id/:filename", async (c) => {
    const id = Number(c.req.param("id"));
    const notFound = () =>
      c.json({ error: `Attachment ${c.req.param("id")} does not exist.` }, 404);
    if (!Number.isInteger(id)) return notFound();
    let row;
    try {
      row = getAttachment(db, id);
    } catch {
      return notFound();
    }
    // The filename segment is cosmetic (files are served by id); require it to
    // match the stored name so it can't be used to alias arbitrary text onto
    // this attachment's bytes/content-type.
    if (c.req.param("filename") !== row.filename) return notFound();
    let data: Buffer;
    try {
      data = await fs.readFile(path.join(attachmentsDir, String(id)));
    } catch {
      return notFound();
    }
    c.header("Content-Type", row.contentType);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Disposition", `inline; filename="${row.filename}"`);
    c.header("Cache-Control", "private, max-age=31536000, immutable");
    return c.body(new Uint8Array(data));
  });

  app.post("/issues/:ref/request-input", body(requestInputBody), (c) =>
    c.json(requestHumanInput(db, c.var.actor, c.req.param("ref"), c.req.valid("json").question)),
  );

  app.post("/issues/:ref/snooze", body(snoozeBody), (c) =>
    c.json(snoozeIssue(db, c.var.actor, c.req.param("ref"), c.req.valid("json").until)),
  );

  app.post("/issues/:ref/duplicate", body(duplicateBody), (c) =>
    c.json(markDuplicate(db, c.var.actor, c.req.param("ref"), c.req.valid("json").of)),
  );

  app.post("/issues/:ref/redeliver", (c) =>
    c.json(redeliverIssue(db, c.var.actor, c.req.param("ref"))),
  );

  app.get("/next-task", (c) =>
    c.json(nextTask(db, c.var.actor, c.req.query("project") || undefined)),
  );

  app.post("/dependencies", body(dependencyBody), (c) => {
    const { blockerRef, blockedRef } = c.req.valid("json");
    addDependency(db, c.var.actor, blockerRef, blockedRef);
    return c.json({ ok: true });
  });

  app.delete("/dependencies", (c) => {
    const blockerRef = c.req.query("blockerRef");
    const blockedRef = c.req.query("blockedRef");
    if (!blockerRef || !blockedRef) {
      return c.json({ error: "blockerRef and blockedRef query params are required" }, 400);
    }
    removeDependency(db, c.var.actor, blockerRef, blockedRef);
    return c.json({ ok: true });
  });

  app.get("/events", (c) => {
    const since = c.req.query("since");
    const limit = c.req.query("limit");
    const beforeId = c.req.query("before_id");
    const page = listRecentEventsPage(db, {
      since: since !== undefined ? Number(since) : undefined,
      limit: limit !== undefined ? Number(limit) : undefined,
      beforeId: beforeId !== undefined ? Number(beforeId) : undefined,
    });
    c.header("X-Truncated", String(page.truncated));
    if (page.nextCursor !== null) c.header("X-Next-Cursor", String(page.nextCursor));
    return c.json(page.events);
  });

  app.get("/unanswered-questions", (c) => c.json(listUnansweredQuestions(db)));

  // Redact secret from webhook objects for safe API responses
  const redact = ({ secret, ...rest }: Webhook) => ({ ...rest, hasSecret: secret !== null });

  app.get("/webhooks", (c) => c.json(listWebhooks(db).map(redact)));
  app.post("/webhooks", body(webhookCreateBody), (c) =>
    c.json(redact(addWebhook(db, c.var.actor, c.req.valid("json")))),
  );
  app.delete("/webhooks/:id", (c) => {
    removeWebhook(db, c.var.actor, Number(c.req.param("id")));
    return c.json({ ok: true });
  });
  app.patch("/webhooks/:id", body(webhookPatchBody), (c) => {
    const { active } = c.req.valid("json");
    return c.json(redact(setWebhookActive(db, c.var.actor, Number(c.req.param("id")), active)));
  });

  // Redact secret from linked-repo objects for safe API responses
  const redactRepo = ({ secret, ...rest }: GithubRepo) => ({ ...rest, hasSecret: secret !== null });

  app.get("/github-repos", (c) => c.json(listGithubRepos(db).map(redactRepo)));
  app.post("/github-repos", body(githubRepoCreateBody), (c) =>
    c.json(redactRepo(addGithubRepo(db, c.var.actor, c.req.valid("json")))),
  );
  app.delete("/github-repos/:id", (c) => {
    removeGithubRepo(db, c.var.actor, Number(c.req.param("id")));
    return c.json({ ok: true });
  });

  // Authenticated ingestion point for the polling fallback (SYD-71):
  // scripts/github-poll.ts can't reach POST /webhooks/github's HMAC signature
  // (it doesn't run inside the server process and per-repo secrets are
  // write-only over the API), so it derives the same GitHub-shaped
  // pull_request/check_suite payloads itself and posts them here instead —
  // bearer-token authenticated rather than signature-verified, but running
  // through the exact same src/services/github-webhook.ts matching/recording
  // logic as the real webhook, so both paths converge on one place.
  //
  // Bearer auth alone isn't enough here (SYD-107): the same token type
  // authenticates /mcp, so any dispatched agent could otherwise forge
  // pull_request/check_suite events (e.g. a fake "closed" to clear the
  // SYD-99 open-PR claim guard) attributed to the trusted "github" system
  // actor. Restrict to human-authenticated callers — run
  // scripts/github-poll.ts with a dedicated human-type actor's token, not an
  // agent's.
  app.get("/settings", (c) => c.json(getAllSettings(db)));
  app.put("/settings/:key", body(settingPutBody), (c) =>
    c.json(setSetting(db, c.var.actor, c.req.param("key"), c.req.valid("json").value)),
  );
  app.delete("/settings/:key", (c) => c.json(resetSetting(db, c.var.actor, c.req.param("key"))));

  app.post("/github-events", body(githubEventBody), (c) => {
    if (c.var.actor.type === "agent") {
      throw new SwitchyardError(
        "Only a trusted human-authenticated poller may post GitHub events — agents cannot call /github-events.",
      );
    }
    const { event, payload } = c.req.valid("json");
    const outcome = handleGithubWebhook(db, event, payload);
    return c.json({ ok: true, ...outcome });
  });

  return app;
}
