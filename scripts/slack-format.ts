// Pure formatting logic for the Slack notifier (scripts/slack-notifier.ts).
// Kept separate from the Hono app / network code so it's trivially unit-testable.

export type SwitchyardWebhookBody = {
  event: string;
  payload?: Record<string, unknown>;
  issue: string;
  title: string;
  status: string;
  project: string;
  actor: string;
  at: number;
};

/**
 * Decide whether a Switchyard webhook event is worth a Slack ping, and if so, how
 * to word it. Returns null for events we don't notify on.
 */
export function formatNotification(body: SwitchyardWebhookBody): string | null {
  if (body.event === "created" && body.status === "triage") {
    return `🆕 ${body.issue} filed by ${body.actor}: ${body.title}`;
  }
  if (body.event === "needs_input_set") {
    return `⚠️ ${body.actor} needs a human answer on ${body.issue}: ${body.title}`;
  }
  if (body.event === "status_changed" && body.payload?.to === "in_review") {
    return `👀 ${body.issue} ready for review: ${body.title}`;
  }
  return null;
}
