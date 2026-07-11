// Standalone Slack notifier for Switchyard webhook events.
//
// This is its own process — it is NOT wired into src/server.ts. Run it separately
// and register it as a Switchyard webhook endpoint (see README "Slack notifications").
//
//   SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... npx tsx scripts/slack-notifier.ts
//
// Env:
//   PORT                        - default 3301
//   SLACK_WEBHOOK_URL           - required, Slack incoming webhook URL
//   SWITCHYARD_WEBHOOK_SECRET   - optional; when set, requests must carry a valid
//                                 x-switchyard-signature header (see webhook-dispatcher.ts
//                                 for the signing scheme: hex HMAC-SHA256 of the raw body).

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { formatNotification, type SwitchyardWebhookBody } from "./slack-format.js";

export type BuildAppOptions = {
  slackWebhookUrl: string;
  secret?: string;
  fetchFn?: typeof fetch;
};

function validSignature(secret: string, rawBody: string, header: string | undefined): boolean {
  if (!header) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Builds the notifier's Hono app. Exported so tests can inject a secret and a mock fetch. */
export function buildApp(opts: BuildAppOptions): Hono {
  const fetchFn = opts.fetchFn ?? fetch;
  const app = new Hono();

  app.post("/", async (c) => {
    const raw = await c.req.text();

    if (opts.secret && !validSignature(opts.secret, raw, c.req.header("x-switchyard-signature"))) {
      return c.json({ error: "invalid signature" }, 401);
    }

    let body: SwitchyardWebhookBody | null = null;
    try {
      body = JSON.parse(raw) as SwitchyardWebhookBody;
    } catch (err) {
      console.error(`slack-notifier: could not parse webhook body: ${(err as Error).message}`);
    }

    const text = body ? formatNotification(body) : null;
    if (text) {
      try {
        const res = await fetchFn(opts.slackWebhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) {
          console.error(`slack-notifier: slack webhook returned ${res.status}`);
        }
      } catch (err) {
        console.error(`slack-notifier: posting to slack failed: ${(err as Error).message}`);
      }
    }

    // Always ack Switchyard — delivery failures are logged, never propagated.
    return c.json({ ok: true });
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!slackWebhookUrl) {
    console.error("SLACK_WEBHOOK_URL is required");
    process.exit(1);
  }
  const secret = process.env.SWITCHYARD_WEBHOOK_SECRET || undefined;
  const port = Number(process.env.PORT ?? 3301);
  const app = buildApp({ slackWebhookUrl, secret });
  serve({ fetch: app.fetch, port }, (info) =>
    console.log(`slack notifier listening on :${info.port}`),
  );
}
