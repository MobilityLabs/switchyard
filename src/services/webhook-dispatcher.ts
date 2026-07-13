import { createHmac } from "node:crypto";
import { asc, eq, gt } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { actors, events, issues, projects, webhooks, webhookCursor } from "../db/schema.js";
import { releaseStaleClaims } from "./stale-claims.js";
import { expireLeases } from "./leases.js";
import { sweepOrphanedAgentSessions } from "./agent-sessions.js";
import { getSetting } from "./settings.js";
import { emitProcessDeviations } from "./deviation.js";

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
  // progress_note events fire once per work step (buildPrompt prompts agents
  // to post them liberally) — a chatty session posts 10-20 per issue.
  // Forwarding every one to every active webhook floods generic consumers
  // (e.g. Slack) within the ~2s dispatch interval, so they're suppressed by
  // default (webhooks.suppressed_events, SYD-104). Every other event type
  // still fans out unchanged.
  const suppressed = new Set(getSetting(db, "webhooks.suppressed_events"));
  let delivered = 0;
  for (const r of rows) {
    if (suppressed.has(r.e.type)) {
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

export function startWebhookDispatcher(db: Db, intervalMs = 2000): () => void {
  // SYD-210 Layer B: capture process start once so lease expiry can gate on
  // server uptime — a redeploy's correlated heartbeat outage must not
  // mass-expire live leases before they re-heartbeat.
  const serverStartedAt = Math.floor(Date.now() / 1000);
  const timer = setInterval(() => {
    try {
      emitProcessDeviations(db);
    } catch (err) {
      console.error("process deviation emit:", err);
    }
    dispatchPending(db).catch((err) => console.error("webhook dispatch:", err));
    try {
      // No explicit staleSeconds: releaseStaleClaims reads claims.stale_seconds
      // fresh from settings every tick, so a human's edit in the UI takes
      // effect on the next sweep, not just at process start. serverStartedAt
      // shares the lease sweep's post-restart grace (SYD-210 review).
      releaseStaleClaims(db, undefined, serverStartedAt);
    } catch (err) {
      console.error("stale claim release:", err);
    }
    try {
      expireLeases(db, Math.floor(Date.now() / 1000), serverStartedAt);
    } catch (err) {
      console.error("lease expiry sweep:", err);
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
