import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

describe("webhook routes", () => {
  it("creates, lists, deletes, and redacts secrets", async () => {
    const db = openDb(":memory:");
    const h = {
      authorization: `Bearer ${createActor(db, { name: "sean", type: "human" }).token}`,
      "content-type": "application/json",
    };
    const app = buildApiRoutes(db);

    // Create a webhook without a secret
    const createdRes = await app.request("/webhooks", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ url: "http://example.com/hook" }),
    });
    expect(createdRes.status).toBe(200);
    const created = (await createdRes.json()) as { id: number; url: string; hasSecret?: boolean; secret?: unknown };
    expect(created.id).toBeDefined();
    expect(created.url).toBe("http://example.com/hook");
    expect(created.hasSecret).toBe(false);
    expect(created.secret).toBeUndefined();

    // Create a webhook with a secret
    const withSecretRes = await app.request("/webhooks", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ url: "http://example.com/secure", secret: "s3cret" }),
    });
    expect(withSecretRes.status).toBe(200);
    const withSecret = (await withSecretRes.json()) as { id: number; url: string; hasSecret?: boolean; secret?: unknown };
    expect(withSecret.hasSecret).toBe(true);
    expect(withSecret.secret).toBeUndefined();

    // List webhooks and verify secrets are redacted
    const listRes = await app.request("/webhooks", { headers: h });
    expect(listRes.status).toBe(200);
    const webhooks = (await listRes.json()) as Array<{ id: number; hasSecret?: boolean; secret?: unknown }>;
    expect(webhooks).toHaveLength(2);
    for (const webhook of webhooks) {
      expect(webhook.secret).toBeUndefined();
      expect(webhook.hasSecret).toBeDefined();
    }

    // Delete the first webhook
    const deleteRes = await app.request(`/webhooks/${created.id}`, {
      method: "DELETE",
      headers: h,
    });
    expect(deleteRes.status).toBe(200);

    // Verify deletion
    const listAfterDelete = await app.request("/webhooks", { headers: h });
    const remaining = (await listAfterDelete.json()) as Array<{ id: number }>;
    expect(remaining).toHaveLength(1);
  });
});
