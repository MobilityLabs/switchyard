import { describe, it, expect, beforeEach } from "vitest";
import { createHuman } from "../helpers/human.js";
import type { HumanActor } from "../../src/services/principal.js";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue } from "../../src/services/issues.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

// SYD-213: REST-layer authorization for a `service` token. The service-layer
// matrix (tests/services/service-actor.test.ts) covers the guards that live in
// services; these capabilities are gated at the route layer only:
// requireHumanCaller (create actor / mint login link) and the /github-events
// poster guard.
let db: Db,
  app: ReturnType<typeof buildApiRoutes>,
  serviceToken: string,
  agentToken: string,
  human: HumanActor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createHuman(db, "sean");
  serviceToken = createActor(db, { name: "github-poller", type: "service" }).token;
  agentToken = createActor(db, { name: "claude/dev", type: "agent" }).token;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  createIssue(db, human, { projectKey: "SYD", title: "Poll target" }); // SYD-1
  app = buildApiRoutes(db);
});

const svc = () => ({ authorization: `Bearer ${serviceToken}`, "content-type": "application/json" });

describe("service token — REST-layer guards", () => {
  it("CANNOT create an actor (requireHumanCaller)", async () => {
    const res = await app.request("/actors", {
      method: "POST",
      headers: svc(),
      body: JSON.stringify({ name: "claude/other", type: "agent" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/only (a )?humans?/i);
  });

  it("CANNOT mint a login link (requireHumanCaller)", async () => {
    const res = await app.request(`/actors/${human.id}/login-link`, {
      method: "POST",
      headers: svc(),
      body: "{}",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/only (a )?humans?/i);
  });

  it("CAN post GitHub events (trusted poller)", async () => {
    const res = await app.request("/github-events", {
      method: "POST",
      headers: svc(),
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
    expect((await res.json()) as { handled: boolean }).toMatchObject({ handled: true });
  });

  it("CAN read the delivery work queue", async () => {
    const res = await app.request("/delivery-work", { headers: svc() });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("pending");
  });
});

// SYD-281: the human-only gates moved from six private `requireHuman` helpers in
// the service layer to `requireHumanCaller` at the adapter, so the refusals that
// used to be asserted service-side (tests/services/*.test.ts, calling
// setSetting(db, agent, …) and friends) are asserted here instead. They are NOT
// asserted by a cast in a service test: a `HumanActor` a test manufactured is
// exactly the "tests construct state the producer never produces" failure this
// story exists to remove.
//
// Both non-human tiers are covered — the old service-level tests checked one or
// the other per file, and `service` was the tier that slipped through
// `confirmPrLink`'s `!== "agent"` (SYD-298).
describe("non-human bearers are refused at every human-only route", () => {
  const ROUTES: Array<{ what: string; method: string; path: string; body?: unknown }> = [
    {
      what: "create a project",
      method: "POST",
      path: "/projects",
      body: { key: "NEW", name: "n" },
    },
    { what: "rename a project", method: "PATCH", path: "/projects/SYD", body: { name: "n" } },
    {
      what: "change a setting",
      method: "PUT",
      path: "/settings/dispatch.max_concurrent",
      body: { value: 9 },
    },
    { what: "reset a setting", method: "DELETE", path: "/settings/dispatch.max_concurrent" },
    { what: "add a webhook", method: "POST", path: "/webhooks", body: { url: "https://e.test/h" } },
    { what: "remove a webhook", method: "DELETE", path: "/webhooks/1" },
    {
      what: "link a GitHub repo",
      method: "POST",
      path: "/github-repos",
      body: { fullName: "acme/w" },
    },
    { what: "unlink a GitHub repo", method: "DELETE", path: "/github-repos/1" },
    {
      what: "snooze an issue",
      method: "POST",
      path: "/issues/SYD-1/snooze",
      body: { until: 9999999999 },
    },
    {
      what: "mark a duplicate",
      method: "POST",
      path: "/issues/SYD-1/duplicate",
      body: { of: "SYD-1" },
    },
    {
      what: "confirm a PR link",
      method: "POST",
      path: "/issues/SYD-1/pr-links/confirm",
      body: { repo: "acme/w", prNumber: 1 },
    },
    {
      what: "create an actor",
      method: "POST",
      path: "/actors",
      body: { name: "x", type: "agent" },
    },
    { what: "mint a login link", method: "POST", path: "/actors/1/login-link" },
    { what: "rotate an actor's token", method: "POST", path: "/actors/1/rotate-token" },
    { what: "revoke an actor's token", method: "DELETE", path: "/actors/1/token" },
    {
      what: "change whether an actor is attended",
      method: "POST",
      path: "/actors/1/attended",
      body: { attended: true },
    },
    { what: "retry a delivery", method: "POST", path: "/issues/SYD-1/redeliver", body: {} },
    {
      what: "resolve a delivery failure",
      method: "POST",
      path: "/issues/SYD-1/resolve-delivery",
      body: { note: "merged by hand" },
    },
    {
      what: "resolve a process deviation",
      method: "POST",
      path: "/issues/SYD-1/resolve-deviation",
      body: { reason: "open_pr_not_in_review", note: "handled" },
    },
    // A mixed function (population B) rather than a requireHumanCaller route,
    // but the refusal is the same CLAUDE.md invariant — "dependency removal is
    // human-only" — and the service tier is the one that reached it. Takes
    // query params, not a body.
    {
      what: "remove a dependency",
      method: "DELETE",
      path: "/dependencies?blockerRef=SYD-1&blockedRef=SYD-1",
    },
  ];

  for (const tier of ["agent", "service"] as const) {
    for (const r of ROUTES) {
      it(`a ${tier} bearer cannot ${r.what}`, async () => {
        const token = tier === "service" ? serviceToken : agentToken;
        const res = await app.request(r.path, {
          method: r.method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          ...(r.body === undefined ? {} : { body: JSON.stringify(r.body) }),
        });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toMatch(/only (a )?humans?/i);
      });
    }
  }
});
