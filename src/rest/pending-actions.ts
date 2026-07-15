import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Db } from "../db/index.js";
import { SwitchyardError } from "../services/errors.js";
import { getSessionActor } from "../services/auth.js";
import { affirmPendingAction, listPendingActions } from "../services/hard-gate.js";
import { PENDING_ACTION_STATUSES, type PendingActionStatus } from "../db/schema.js";
import { SESSION_COOKIE } from "./auth-routes.js";

/**
 * The human-presence surface for supervised sessions: a gated action an agent
 * proposed sits here until the session's accountable human affirms it.
 *
 * NB: `GET /pending-actions` has no owner scoping in Phase 1 — any authed
 * actor, INCLUDING a plain agent bearer, can read issue-ref/action-type/session
 * metadata across all sessions. No capability leaks (affirming still needs the
 * owner's cookie), but it is cross-session info disclosure; scoping it to the
 * requesting human is a logged follow-up.
 */
export function buildPendingActionRoutes(db: Db) {
  const app = new Hono();

  app.get("/pending-actions", (c) => {
    const status = c.req.query("status") ?? "pending";
    if (!(PENDING_ACTION_STATUSES as readonly string[]).includes(status)) {
      throw new SwitchyardError(
        `"${status}" is not a pending-action status — valid statuses are: ${PENDING_ACTION_STATUSES.join(", ")}.`,
      );
    }
    return c.json(listPendingActions(db, status as PendingActionStatus));
  });

  app.post("/pending-actions/:id/affirm", (c) => {
    // Affirmation MUST come from a real web session cookie, never c.var.actor:
    // the API middleware resolves a Bearer FIRST, and a human actor's syd_
    // bearer is a token an agent process can hold — so an actor.type === "human"
    // check would let an agent affirm its own gated action, defeating the gate.
    // A browser cookie is the closest thing we have to a human being present.
    // getSessionActor's kind='plain' filter (Task 2) also rejects a sup_ token
    // replayed here, so a supervised session can't affirm itself either.
    const cookie = getCookie(c, SESSION_COOKIE);
    const human = cookie ? getSessionActor(db, cookie) : null;
    if (!human || human.type !== "human") {
      return c.json({ error: "A human web session is required to affirm a gated action." }, 403);
    }
    const idParam = c.req.param("id");
    const id = Number(idParam);
    if (!Number.isInteger(id) || id <= 0) {
      throw new SwitchyardError(`There is no pending action ${idParam}.`);
    }
    return c.json(affirmPendingAction(db, human, id));
  });

  return app;
}
