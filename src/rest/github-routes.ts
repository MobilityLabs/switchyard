// Inbound receiver for GitHub webhook deliveries (SYD-64). Unauthenticated
// (GitHub can't hold a Switchyard bearer token) — trust comes from verifying
// the HMAC-SHA256 signature GitHub sends in X-Hub-Signature-256, the same
// "sha256=<hex>" scheme webhook-dispatcher.ts already uses for outbound
// payloads (see scripts/slack-notifier.ts for the inbound-verification
// mirror of that scheme). The secret to verify against is per-repo when the
// sending repo is linked via `github_repos` (SYD-72), falling back to the
// single instance-wide GITHUB_WEBHOOK_SECRET otherwise.

import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/index.js";
import { handleGithubWebhook } from "../services/github-webhook.js";
import { findGithubRepo } from "../services/github-repos.js";

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

/**
 * A repo linked via `github_repos` with its own secret verifies against
 * that secret (so one repo's key can rotate without affecting others); a
 * repo that's linked with no secret of its own, or isn't linked at all,
 * falls back to the instance-wide GITHUB_WEBHOOK_SECRET.
 */
function resolveSecret(
  db: Db,
  globalSecret: string | undefined,
  fullName: unknown,
): string | undefined {
  if (typeof fullName === "string") {
    const repo = findGithubRepo(db, fullName);
    if (repo?.secret) return repo.secret;
  }
  return globalSecret;
}

export function buildGithubWebhookRoutes(
  db: Db,
  secret: string | undefined = defaultGithubWebhookSecret(),
) {
  const app = new Hono();

  app.post("/webhooks/github", async (c) => {
    // Read the raw body once: the signature is an HMAC over these exact
    // bytes, so it must be verified before acting on the parsed payload.
    // Parsing happens first anyway (rather than after verification, as
    // before) because picking the right secret to verify against requires
    // reading `repository.full_name` out of the body — that's safe because
    // the signature check right after still rejects any payload that
    // doesn't match the secret selected for that repo.
    const raw = await c.req.text();
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return c.json({ error: "request body is not valid JSON" }, 400);
    }
    const effectiveSecret = resolveSecret(db, secret, (payload as any)?.repository?.full_name);
    if (!effectiveSecret) {
      console.error(
        "github webhook: no secret configured for this repo, and GITHUB_WEBHOOK_SECRET is not set — rejecting delivery",
      );
      return c.json(
        {
          error:
            "GitHub webhook receiver is not configured — link this repo or set GITHUB_WEBHOOK_SECRET.",
        },
        501,
      );
    }
    if (!validSignature(effectiveSecret, raw, c.req.header("x-hub-signature-256"))) {
      return c.json({ error: "invalid signature" }, 401);
    }
    const githubEvent = c.req.header("x-github-event");
    if (!githubEvent) {
      return c.json({ error: "missing x-github-event header" }, 400);
    }
    const outcome = handleGithubWebhook(db, githubEvent, payload);
    return c.json({ ok: true, ...outcome });
  });

  return app;
}
