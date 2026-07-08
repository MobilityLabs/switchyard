import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { formatNotification } from "../../scripts/slack-format.js";
import { buildApp } from "../../scripts/slack-notifier.js";

describe("formatNotification", () => {
  it("formats a newly filed issue landing in triage", () => {
    expect(
      formatNotification({
        event: "created",
        status: "triage",
        issue: "SYD-1",
        title: "Fix flaky test",
        actor: "claude/worker",
        project: "SYD",
        at: 0,
      })
    ).toBe("🆕 SYD-1 filed by claude/worker: Fix flaky test");
  });

  it("formats a needs-input escalation", () => {
    expect(
      formatNotification({
        event: "needs_input_set",
        status: "in_progress",
        issue: "SYD-2",
        title: "Ambiguous spec",
        actor: "claude/worker",
        project: "SYD",
        at: 0,
      })
    ).toBe("⚠️ claude/worker needs a human answer on SYD-2: Ambiguous spec");
  });

  it("formats a status change into in_review", () => {
    expect(
      formatNotification({
        event: "status_changed",
        payload: { from: "in_progress", to: "in_review" },
        status: "in_review",
        issue: "SYD-3",
        title: "Ship it",
        actor: "claude/worker",
        project: "SYD",
        at: 0,
      })
    ).toBe("👀 SYD-3 ready for review: Ship it");
  });

  it("returns null for everything else, including other status transitions", () => {
    expect(
      formatNotification({
        event: "status_changed",
        payload: { from: "todo", to: "in_progress" },
        status: "in_progress",
        issue: "SYD-4",
        title: "Noop",
        actor: "claude/worker",
        project: "SYD",
        at: 0,
      })
    ).toBeNull();
    expect(
      formatNotification({
        event: "priority_changed",
        status: "todo",
        issue: "SYD-5",
        title: "Noop2",
        actor: "sean",
        project: "SYD",
        at: 0,
      })
    ).toBeNull();
    expect(
      formatNotification({
        event: "created",
        status: "backlog",
        issue: "SYD-6",
        title: "Human-filed, no notification",
        actor: "sean",
        project: "SYD",
        at: 0,
      })
    ).toBeNull();
  });
});

describe("slack notifier app (signature verification)", () => {
  it("accepts a validly signed request and posts to slack, but rejects a wrong signature with 401", async () => {
    const posted: unknown[] = [];
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      posted.push(JSON.parse(init!.body as string));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const secret = "s3cret";
    const app = buildApp({ slackWebhookUrl: "http://example.invalid/hook", secret, fetchFn });

    const body = JSON.stringify({
      event: "created",
      status: "triage",
      issue: "SYD-1",
      title: "Fix flaky test",
      actor: "claude/worker",
      project: "SYD",
      at: 0,
    });
    const validSig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

    const goodRes = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json", "x-switchyard-signature": validSig },
      body,
    });
    expect(goodRes.status).toBe(200);
    expect(await goodRes.json()).toEqual({ ok: true });
    expect(posted).toEqual([{ text: "🆕 SYD-1 filed by claude/worker: Fix flaky test" }]);

    const badRes = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json", "x-switchyard-signature": "sha256=deadbeef" },
      body,
    });
    expect(badRes.status).toBe(401);
    expect(posted).toHaveLength(1); // no second slack post for the rejected request
  });
});
