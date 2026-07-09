// Inbound receiver for GitHub webhook deliveries (SYD-64). Unauthenticated
// (GitHub can't hold a Switchyard bearer token) — trust comes from verifying
// the HMAC-SHA256 signature GitHub sends in X-Hub-Signature-256, the same
// "sha256=<hex>" scheme webhook-dispatcher.ts already uses for outbound
// payloads (see scripts/slack-notifier.ts for the inbound-verification
// mirror of that scheme).

import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/index.js";
import { handleGithubWebhook } from "../services/github-webhook.js";

export function defaultGithubWebhookSecret(): string | undefined {
  return process.env.GITHUB_WEBHOOK_SECRET || undefined;
}

function validSignature(secret: string, rawBody: string, header: string | undefined): boolean {
  if (!header) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildGithubWebhookRoutes(db: Db, secret: string | undefined = defaultGithubWebhookSecret()) {
  const app = new Hono();

  app.post("/webhooks/github", async (c) => {
    if (!secret) {
      console.error("github webhook: GITHUB_WEBHOOK_SECRET is not set — rejecting delivery");
      return c.json({ error: "GitHub webhook receiver is not configured — set GITHUB_WEBHOOK_SECRET." }, 501);
    }
    // Read the raw body once: the signature is an HMAC over these exact
    // bytes, so it must be verified before (and instead of) c.req.json().
    const raw = await c.req.text();
    if (!validSignature(secret, raw, c.req.header("x-hub-signature-256"))) {
      return c.json({ error: "invalid signature" }, 401);
    }
    const githubEvent = c.req.header("x-github-event");
    if (!githubEvent) {
      return c.json({ error: "missing x-github-event header" }, 400);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return c.json({ error: "request body is not valid JSON" }, 400);
    }
    const outcome = handleGithubWebhook(db, githubEvent, payload);
    return c.json({ ok: true, ...outcome });
  });

  return app;
}
