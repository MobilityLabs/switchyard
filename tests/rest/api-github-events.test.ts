import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue } from "../../src/services/issues.js";
import { getActivity } from "../../src/services/comments.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

function setup() {
  const db = openDb(":memory:");
  const human = createActor(db, { name: "sean", type: "human" }).actor;
  const humanToken = createActor(db, { name: "github-poller", type: "human" }).token;
  const agentToken = createActor(db, { name: "claude/dev", type: "agent" }).token;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  createIssue(db, human, { projectKey: "SYD", title: "Poll fallback target" });
  const app = buildApiRoutes(db);
  return { db, app, humanToken, agentToken };
}

describe("POST /github-events", () => {
  it("records a gh_pr_opened event through the same matching/recording logic as the real webhook", async () => {
    const { db, app, humanToken } = setup();
    const res = await app.request("/github-events", {
      method: "POST",
      headers: { authorization: `Bearer ${humanToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        event: "pull_request",
        payload: {
          action: "opened",
          pull_request: {
            number: 5,
            html_url: "https://github.com/acme/widgets/pull/5",
            head: { ref: "agent/SYD-1" },
            title: "unrelated",
            body: null,
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      handled: true,
      ref: "SYD-1",
      type: "gh_pr_opened",
    });
    const ev = getActivity(db, "SYD-1").find((a) => a.type === "gh_pr_opened")!;
    expect(ev.actorName).toBe("github");
  });

  it("threads a top-level repo into the recorded payload (SYD-205)", async () => {
    const { db, app, humanToken } = setup();
    const res = await app.request("/github-events", {
      method: "POST",
      headers: { authorization: `Bearer ${humanToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        event: "pull_request",
        repo: "acme/widgets",
        payload: {
          action: "opened",
          pull_request: {
            number: 5,
            html_url: "https://github.com/acme/widgets/pull/5",
            head: { ref: "agent/SYD-1", sha: "d".repeat(40) },
            updated_at: "2026-07-12T10:00:00Z",
            title: "unrelated",
            body: null,
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const ev = getActivity(db, "SYD-1").find((a) => a.type === "gh_pr_opened")!;
    expect(ev.payload).toEqual({
      prNumber: 5,
      url: "https://github.com/acme/widgets/pull/5",
      branch: "agent/SYD-1",
      repo: "acme/widgets",
      headSha: "d".repeat(40),
      ghUpdatedAt: "2026-07-12T10:00:00Z",
    });
  });

  it("records a gh_checks_failed event for a check_suite payload", async () => {
    const { app, humanToken } = setup();
    const res = await app.request("/github-events", {
      method: "POST",
      headers: { authorization: `Bearer ${humanToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        event: "check_suite",
        payload: {
          action: "completed",
          check_suite: { head_branch: "agent/SYD-1", head_sha: "deadbeef", conclusion: "failure" },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      handled: true,
      ref: "SYD-1",
      type: "gh_checks_failed",
    });
  });

  it("returns handled:false without erroring when no ref matches", async () => {
    const { app, humanToken } = setup();
    const res = await app.request("/github-events", {
      method: "POST",
      headers: { authorization: `Bearer ${humanToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        event: "pull_request",
        payload: {
          action: "opened",
          pull_request: { number: 1, head: { ref: "main" }, title: "no ref", body: null },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      handled: false,
      reason: "no issue ref found in branch, title, or body",
    });
  });

  it("requires authentication", async () => {
    const { app } = setup();
    const res = await app.request("/github-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "pull_request", payload: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects an unsupported event value at the schema layer", async () => {
    const { app, humanToken } = setup();
    const res = await app.request("/github-events", {
      method: "POST",
      headers: { authorization: `Bearer ${humanToken}`, "content-type": "application/json" },
      body: JSON.stringify({ event: "push", payload: {} }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an agent actor — only a trusted human-authenticated poller may post GitHub events", async () => {
    const { app, agentToken } = setup();
    const res = await app.request("/github-events", {
      method: "POST",
      headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        event: "pull_request",
        payload: {
          action: "closed",
          pull_request: {
            number: 5,
            html_url: "https://github.com/acme/widgets/pull/5",
            merged: true,
            head: { ref: "agent/SYD-1" },
            title: "unrelated",
            body: null,
          },
        },
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/agents cannot call/);
  });
});
