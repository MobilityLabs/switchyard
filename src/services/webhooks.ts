import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { webhooks } from "../db/schema.js";
import { SwitchyardError } from "./errors.js";
import { getProjectByKey } from "./projects.js";

export type Webhook = typeof webhooks.$inferSelect;

export function addWebhook(
  db: Db,
  input: { url: string; projectKey?: string; secret?: string }
): Webhook {
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

export function removeWebhook(db: Db, id: number): void {
  const gone = db.delete(webhooks).where(eq(webhooks.id, id)).returning().get();
  if (!gone) throw new SwitchyardError(`There is no webhook with id ${id} — list them with GET /api/webhooks.`);
}

export function setWebhookActive(db: Db, id: number, active: boolean): Webhook {
  const row = db.update(webhooks).set({ active }).where(eq(webhooks.id, id)).returning().get();
  if (!row) throw new SwitchyardError(`There is no webhook with id ${id} — list them with GET /api/webhooks.`);
  return row;
}
