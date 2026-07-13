import { describe, it, expect, beforeEach } from "vitest";
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
let db: Db, app: ReturnType<typeof buildApiRoutes>, serviceToken: string, human: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  serviceToken = createActor(db, { name: "github-poller", type: "service" }).token;
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
    expect(((await res.json()) as { error: string }).error).toMatch(/only humans/i);
  });

  it("CANNOT mint a login link (requireHumanCaller)", async () => {
    const res = await app.request(`/actors/${human.id}/login-link`, {
      method: "POST",
      headers: svc(),
      body: "{}",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/only humans/i);
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
