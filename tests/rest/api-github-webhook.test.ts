import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue } from "../../src/services/issues.js";
import { addGithubRepo } from "../../src/services/github-repos.js";
import { buildGithubWebhookRoutes } from "../../src/rest/github-routes.js";

const SECRET = "gh-secret";

function sign(body: string, secret: string = SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

let db: Db;
let app: ReturnType<typeof buildGithubWebhookRoutes>;
let human: Actor;

beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });
  app = buildGithubWebhookRoutes(db, SECRET);
});

async function post(
  body: unknown,
  opts: { event?: string | null; signature?: string | null } = {},
) {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.event !== null) headers["x-github-event"] = opts.event ?? "pull_request";
  const signature = opts.signature === undefined ? sign(raw) : opts.signature;
  if (signature !== null) headers["x-hub-signature-256"] = signature;
  return app.request("/webhooks/github", { method: "POST", headers, body: raw });
}

describe("POST /webhooks/github", () => {
  it("records a gh_pr_opened event for a validly signed delivery", async () => {
    const res = await post({
      action: "opened",
      pull_request: {
        number: 7,
        html_url: "https://github.com/acme/widgets/pull/7",
        head: { ref: "agent/SYD-1" },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; handled: boolean; ref: string; type: string };
    expect(body).toMatchObject({ ok: true, handled: true, ref: "SYD-1", type: "gh_pr_opened" });
  });

  it("rejects a missing signature", async () => {
    const res = await post(
      { action: "opened", pull_request: { number: 7, head: { ref: "agent/SYD-1" } } },
      { signature: null },
    );
    expect(res.status).toBe(401);
  });

  it("rejects an invalid signature", async () => {
    const res = await post(
      { action: "opened", pull_request: { number: 7, head: { ref: "agent/SYD-1" } } },
      { signature: "sha256=" + "0".repeat(64) },
    );
    expect(res.status).toBe(401);
  });

  it("rejects a missing x-github-event header", async () => {
    const res = await post({ action: "opened" }, { event: null });
    expect(res.status).toBe(400);
  });

  it("returns 501 when no secret is configured", async () => {
    const unconfigured = buildGithubWebhookRoutes(db, undefined);
    const raw = JSON.stringify({ action: "opened" });
    const res = await unconfigured.request("/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(raw),
      },
      body: raw,
    });
    expect(res.status).toBe(501);
  });

  it("records a gh_pushed event for a validly signed push delivery", async () => {
    const res = await post(
      {
        ref: "refs/heads/agent/SYD-1",
        after: "deadbeefcafe",
        compare: "https://github.com/acme/widgets/compare/a...b",
        commits: [{ message: "wip" }],
      },
      { event: "push" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; handled: boolean; ref: string; type: string };
    expect(body).toMatchObject({ ok: true, handled: true, ref: "SYD-1", type: "gh_pushed" });
  });

  it("responds 200 with handled:false for an unmatched ref instead of erroring", async () => {
    const res = await post({
      action: "opened",
      pull_request: { number: 7, head: { ref: "agent/SYD-999" } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; handled: boolean };
    expect(body).toMatchObject({ ok: true, handled: false });
  });
});

describe("POST /webhooks/github with a per-repo secret", () => {
  it("verifies against the linked repo's own secret, not the global one", async () => {
    const repoSecret = "repo-only-secret";
    addGithubRepo(db, human, { fullName: "acme/widgets", secret: repoSecret });
    const raw = JSON.stringify({
      action: "opened",
      repository: { full_name: "acme/widgets" },
      pull_request: { number: 7, head: { ref: "agent/SYD-1" } },
    });
    const res = await app.request("/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(raw, repoSecret),
      },
      body: raw,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, handled: true, ref: "SYD-1" });
  });

  it("rejects a delivery signed with the global secret once the repo has its own", async () => {
    addGithubRepo(db, human, { fullName: "acme/widgets", secret: "repo-only-secret" });
    const raw = JSON.stringify({
      action: "opened",
      repository: { full_name: "acme/widgets" },
      pull_request: { number: 7, head: { ref: "agent/SYD-1" } },
    });
    const res = await app.request("/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(raw, SECRET),
      },
      body: raw,
    });
    expect(res.status).toBe(401);
  });

  it("resolves the linked repo's secret despite a casing mismatch (hand-typed lowercase link, canonical-case payload) (SYD-212)", async () => {
    const repoSecret = "repo-only-secret";
    addGithubRepo(db, human, { fullName: "acme/widgets", secret: repoSecret });
    const raw = JSON.stringify({
      action: "opened",
      repository: { full_name: "Acme/Widgets" },
      pull_request: { number: 7, head: { ref: "agent/SYD-1" } },
    });
    const res = await app.request("/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(raw, repoSecret),
      },
      body: raw,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, handled: true, ref: "SYD-1" });
  });

  it("falls back to the global secret for a repo linked without its own", async () => {
    addGithubRepo(db, human, { fullName: "acme/widgets" });
    const raw = JSON.stringify({
      action: "opened",
      repository: { full_name: "acme/widgets" },
      pull_request: { number: 7, head: { ref: "agent/SYD-1" } },
    });
    const res = await app.request("/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(raw, SECRET),
      },
      body: raw,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, handled: true, ref: "SYD-1" });
  });

  it("falls back to the global secret for an unlinked repo", async () => {
    const raw = JSON.stringify({
      action: "opened",
      repository: { full_name: "acme/unlinked" },
      pull_request: { number: 7, head: { ref: "agent/SYD-1" } },
    });
    const res = await app.request("/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(raw, SECRET),
      },
      body: raw,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, handled: true, ref: "SYD-1" });
  });

  it("returns 501 when the repo has no own secret, is unlinked, and no global secret is set", async () => {
    const unconfigured = buildGithubWebhookRoutes(db, undefined);
    const raw = JSON.stringify({ action: "opened", repository: { full_name: "acme/unlinked" } });
    const res = await unconfigured.request("/webhooks/github", {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "pull_request" },
      body: raw,
    });
    expect(res.status).toBe(501);
  });
});
