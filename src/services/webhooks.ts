import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { webhooks } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { getProjectByKey } from "./projects.js";

export type Webhook = typeof webhooks.$inferSelect;

function requireHuman(actor: Actor): void {
  if (actor.type === "agent") {
    throw new SwitchyardError(
      "Only humans manage webhooks — ask a human to add or remove webhook endpoints."
    );
  }
}

export function addWebhook(
  db: Db,
  actor: Actor,
  input: { url: string; projectKey?: string; secret?: string }
): Webhook {
  requireHuman(actor);
  if (!/^https?:\/\//.test(input.url)) {
    throw new SwitchyardError(`Webhook url must be http(s) — got "${input.url}".`);
  }
  const projectId = input.projectKey ? getProjectByKey(db, input.projectKey).id : null;
  return db
    .insert(webhooks)
    .values({ url: input.url, projectId, secret: input.secret ?? null })
    .returning()
    .get();
}

export function listWebhooks(db: Db): Webhook[] {
  return db.select().from(webhooks).all();
}

export function removeWebhook(db: Db, actor: Actor, id: number): void {
  requireHuman(actor);
  const gone = db.delete(webhooks).where(eq(webhooks.id, id)).returning().get();
  if (!gone) throw new SwitchyardError(`There is no webhook with id ${id} — list them with GET /api/webhooks.`);
}

export function setWebhookActive(db: Db, actor: Actor, id: number, active: boolean): Webhook {
  requireHuman(actor);
  const row = db.update(webhooks).set({ active }).where(eq(webhooks.id, id)).returning().get();
  if (!row) throw new SwitchyardError(`There is no webhook with id ${id} — list them with GET /api/webhooks.`);
  return row;
}
