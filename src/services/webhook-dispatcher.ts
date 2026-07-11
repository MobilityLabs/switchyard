import { createHmac } from "node:crypto";
import { asc, eq, gt } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { actors, events, issues, projects, webhooks, webhookCursor } from "../db/schema.js";
import { releaseStaleClaims } from "./stale-claims.js";
import { sweepOrphanedAgentSessions } from "./agent-sessions.js";

// progress_note events fire once per work step (buildPrompt prompts agents to
// post them liberally) — a chatty session posts 10-20 per issue. Forwarding
// every one to every active webhook floods generic consumers (e.g. Slack)
// within the ~2s dispatch interval, so they're suppressed by default. Every
// other event type still fans out unchanged. (SYD-104)
const SUPPRESSED_WEBHOOK_EVENT_TYPES: ReadonlySet<string> = new Set(["progress_note"]);

export async function dispatchPending(db: Db, fetchFn: typeof fetch = fetch): Promise<number> {
  let cursor = db.select().from(webhookCursor).where(eq(webhookCursor.id, 1)).get();
  if (!cursor) {
    db.insert(webhookCursor).values({ id: 1, lastEventId: 0 }).run();
    cursor = { id: 1, lastEventId: 0 };
  }
  const rows = db
    .select({ e: events, i: issues, p: projects, a: actors })
    .from(events)
    .innerJoin(issues, eq(events.issueId, issues.id))
    .innerJoin(projects, eq(issues.projectId, projects.id))
    .innerJoin(actors, eq(events.actorId, actors.id))
    .where(gt(events.id, cursor.lastEventId))
    .orderBy(asc(events.id))
    .limit(100)
    .all();
  if (rows.length === 0) return 0;

  const hooks = db.select().from(webhooks).where(eq(webhooks.active, true)).all();
  let delivered = 0;
  for (const r of rows) {
    if (SUPPRESSED_WEBHOOK_EVENT_TYPES.has(r.e.type)) {
      db.update(webhookCursor).set({ lastEventId: r.e.id }).where(eq(webhookCursor.id, 1)).run();
      continue;
    }
    const body = JSON.stringify({
      event: r.e.type,
      payload: r.e.payload,
      issue: `${r.p.key}-${r.i.number}`,
      title: r.i.title,
      status: r.i.status,
      project: r.p.key,
      actor: r.a.name,
      at: r.e.createdAt,
    });
    for (const h of hooks) {
      if (h.projectId !== null && h.projectId !== r.i.projectId) continue;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (h.secret) {
        headers["x-switchyard-signature"] =
          "sha256=" + createHmac("sha256", h.secret).update(body).digest("hex");
      }
      try {
        const res = await fetchFn(h.url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          delivered++;
        } else {
          console.error(`webhook ${h.id} -> ${h.url} returned ${res.status}`);
        }
      } catch (err) {
        console.error(`webhook ${h.id} -> ${h.url} failed: ${(err as Error).message}`);
      }
    }
    db.update(webhookCursor).set({ lastEventId: r.e.id }).where(eq(webhookCursor.id, 1)).run();
  }
  return delivered;
}

/**
 * Resolves STALE_CLAIM_HOURS (as read from the environment) to a seconds value,
 * falling back to a 4h default when unset or invalid. Warns only when the
 * value was set but isn't a valid positive number — an unset var is the normal
 * default case and shouldn't warn.
 */
export function resolveStaleClaimSeconds(envValue: string | undefined): number {
  const n = Number(envValue);
  const valid = Number.isFinite(n) && n > 0;
  if (envValue !== undefined && !valid) {
    console.warn(
      `STALE_CLAIM_HOURS="${envValue}" is not a valid positive number of hours — falling back to 4h.`,
    );
  }
  return (valid ? n : 4) * 3600;
}

export function startWebhookDispatcher(db: Db, intervalMs = 2000): () => void {
  const staleSeconds = resolveStaleClaimSeconds(process.env.STALE_CLAIM_HOURS);
  const timer = setInterval(() => {
    dispatchPending(db).catch((err) => console.error("webhook dispatch:", err));
    try {
      releaseStaleClaims(db, staleSeconds);
    } catch (err) {
      console.error("stale claim release:", err);
    }
    try {
      sweepOrphanedAgentSessions(db);
    } catch (err) {
      console.error("orphaned agent session sweep:", err);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
