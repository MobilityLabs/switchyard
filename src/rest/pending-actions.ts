import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import {
  PENDING_ACTION_STATUSES,
  sessions,
  actors,
  issues,
  type PendingActionStatus,
} from "../db/schema.js";
import type { Actor } from "../services/actors.js";
import { getSessionActor } from "../services/auth.js";
import { canonicalizeAction, type CanonicalAction } from "../services/canonical-action.js";
import { SwitchyardError } from "../services/errors.js";
import {
  affirmPendingAction,
  getPendingAction,
  listPendingActions,
} from "../services/hard-gate.js";
import { buildAllowedSigners, listAffirmationKeys } from "../services/affirmation-keys.js";
import { issueRefById } from "../services/issues.js";
import { getSetting } from "../services/settings.js";
import { verifySshSig } from "../services/ssh-verify.js";
import { SESSION_COOKIE } from "./auth-routes.js";

/**
 * The human-presence surface for supervised sessions.
 *
 * Phase 2: a gated action is released by a signature over the exact action
 * (see canonical-action.ts), not by a click. The click survives only while
 * supervised.affirm_requires_signature is false — leaving both live would BE
 * the break-glass the design rejected, and a break-glass weaker than the gate
 * IS the gate.
 */
type Env = { Variables: { actor: Actor; leaseToken?: string } };

export function buildPendingActionRoutes(db: Db) {
  const app = new Hono<Env>();

  // Re-derives the exact bytes the server will verify, from the row it will
  // execute. This is what makes replay protection structural rather than a
  // check someone must remember: a signature for SYD-42 cannot verify here.
  // Built as an explicit literal — NEVER spread a DB row into it. Task 3
  // shipped exactly that bug: extra columns leaking into signed bytes made
  // two callers produce different bytes for the same logical action.
  function canonicalFor(row: ReturnType<typeof getPendingAction>): CanonicalAction | null {
    if (!row) return null;
    const ref = issueRefById(db, row.issueId);
    if (!ref) return null;
    const sha = row.payload.expectedHeadSha;
    return {
      v: 1,
      pendingActionId: row.id,
      sessionId: row.sessionId,
      issueRef: ref,
      actionType: row.actionType,
      ...(typeof sha === "string" ? { expectedHeadSha: sha } : {}),
      expiresAt: row.expiresAt,
    };
  }

  // SYD-243: scoped to humans, and to the requesting human's own sessions.
  // Phase 2 widened this response (canonical doc, session, proposing agent), so
  // the Phase 1 posture — readable by any authed actor INCLUDING a plain agent
  // bearer — would now leak strictly more than it did. Not optional here.
  app.get("/pending-actions", (c) => {
    const human = c.var.actor;
    if (human.type !== "human") {
      return c.json({ error: "The approval queue is human-only." }, 403);
    }
    const status = c.req.query("status") ?? "pending";
    if (!(PENDING_ACTION_STATUSES as readonly string[]).includes(status)) {
      throw new SwitchyardError(
        `"${status}" is not a pending-action status — valid statuses are: ${PENDING_ACTION_STATUSES.join(", ")}.`,
      );
    }
    const mine = new Set(
      db
        .select()
        .from(sessions)
        .where(eq(sessions.actorId, human.id))
        .all()
        .map((s) => s.id),
    );
    const rows = listPendingActions(db, status as PendingActionStatus).filter((r) =>
      mine.has(r.sessionId),
    );
    return c.json(
      rows.map((row) => {
        const action = canonicalFor(row);
        const session = db.select().from(sessions).where(eq(sessions.id, row.sessionId)).get();
        const agent = session?.viaAgentId
          ? db.select().from(actors).where(eq(actors.id, session.viaAgentId)).get()
          : null;
        // Current status, for the CLI's "current -> target" render (SYD-245 review
        // finding). Volatile display data ONLY — it is NOT part of the signed
        // canonical doc (canonicalizeAction's field allowlist would drop it anyway;
        // see canonicalFor's comment on why nothing gets spread into that literal).
        const issue = db.select().from(issues).where(eq(issues.id, row.issueId)).get();
        return {
          ...row,
          issueRef: action?.issueRef ?? null, // SYD-244
          issueStatus: issue?.status ?? null,
          canonical: action ? canonicalizeAction(action) : null,
          viaAgentName: agent?.name ?? null,
        };
      }),
    );
  });

  app.post("/pending-actions/:id/affirm", (c) => {
    if (getSetting(db, "supervised.affirm_requires_signature")) {
      return c.json(
        { error: "A signed affirmation is required — run `syd affirm <REF>` and touch your key." },
        403,
      );
    }
    // Cookie-only, never c.var.actor: the middleware resolves a Bearer FIRST,
    // and a human's syd_ bearer is a token an agent process could hold — so an
    // actor.type === "human" check would let an agent affirm its own gated
    // action, defeating the gate. A browser cookie is the closest thing we
    // have to a human being present.
    const cookie = getCookie(c, SESSION_COOKIE);
    const human = cookie ? getSessionActor(db, cookie) : null;
    if (!human || human.type !== "human") {
      return c.json({ error: "A human web session is required to affirm a gated action." }, 403);
    }
    return c.json(affirmPendingAction(db, human, parsePendingId(c.req.param("id"))));
  });

  // Bearer-authed, unlike the cookie route: the caller is the syd affirm CLI,
  // not a browser. That is SAFE here precisely because holding the bearer is no
  // longer sufficient — the signature is the authorization, so the token only
  // proves who is asking, not who approved.
  app.post("/pending-actions/:id/affirm-signed", async (c) => {
    const human = c.var.actor;
    if (human.type !== "human") {
      return c.json({ error: "Only a human can affirm a gated action." }, 403);
    }
    const id = parsePendingId(c.req.param("id"));
    const body = await c.req.json<{ signature?: unknown }>();
    if (typeof body.signature !== "string" || body.signature.length === 0) {
      throw new SwitchyardError("Send the SSHSIG blob as { signature: string }.");
    }
    const row = getPendingAction(db, id);
    if (!row) throw new SwitchyardError(`There is no pending action ${id}.`);

    const keys = listAffirmationKeys(db, human.id);
    if (keys.length === 0) {
      throw new SwitchyardError(
        `No affirmation keys enrolled for ${human.name} — enroll one with: switchyard add-affirm-key <db> ${human.name} <key.pub>`,
      );
    }
    const action = canonicalFor(row);
    if (!action)
      throw new SwitchyardError(`Pending action ${id} points at an issue that no longer exists.`);

    const verified = verifySshSig({
      message: canonicalizeAction(action),
      armoredSignature: body.signature,
      allowedSigners: buildAllowedSigners(keys, human.name),
      principal: human.name,
    });
    if (!verified) {
      throw new SwitchyardError(
        "That signature does not match this action — the action may have been re-proposed since you signed. Re-run `syd affirm`.",
      );
    }
    // Ownership, expiry, exactly-once and the head pin are all re-checked by the
    // executor; verification only proves a human signed THESE bytes.
    return c.json(affirmPendingAction(db, human, id));
  });

  return app;
}

function parsePendingId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0)
    throw new SwitchyardError(`There is no pending action ${raw}.`);
  return id;
}
