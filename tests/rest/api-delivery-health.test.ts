// GET /api/delivery-health (SYD-180): rolling-window aggregate over the
// delivery_attempts ledger so a human doesn't have to eyeball raw events to
// tell whether a night was bad.

import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, getIssue, updateIssue } from "../../src/services/issues.js";
import { recordEvent } from "../../src/services/events.js";
import {
  listPendingDeliveryAuthorizations,
  startDeliveryAttempt,
  finishDeliveryAttempt,
} from "../../src/services/delivery-attempts.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

let db: Db, app: ReturnType<typeof buildApiRoutes>;
let humanHeaders: Record<string, string>;
let agentHeaders: Record<string, string>;

const REPO = "acme/widgets";

beforeEach(() => {
  db = openDb(":memory:");
  const human = createActor(db, { name: "sean", type: "human" });
  const agent = createActor(db, { name: "claude/dev", type: "agent" });
  humanHeaders = { authorization: `Bearer ${human.token}` };
  agentHeaders = { authorization: `Bearer ${agent.token}` };
  createProject(db, human.actor, { key: "SYD", name: "Switchyard" });

  const issue = createIssue(db, human.actor, { projectKey: "SYD", title: "Ship it" });
  updateIssue(db, human.actor, issue.ref, { status: "done" });
  recordEvent(db, {
    issueId: issue.id,
    actorId: human.actor.id,
    type: "status_changed",
    payload: { from: "done", to: "done", pin: { repo: REPO, prNumber: 1, headSha: "sha-1" } },
  });
  const [pending] = listPendingDeliveryAuthorizations(db);
  const attempt = startDeliveryAttempt(db, human.actor, issue.ref, {
    authorizationId: pending.authorizationId,
  });
  finishDeliveryAttempt(db, human.actor, attempt.id, { outcome: "merged_deployed" });

  app = buildApiRoutes(db);
});

describe("GET /delivery-health", () => {
  it("returns the aggregate health surface for a human caller", async () => {
    const res = await app.request("/delivery-health", { headers: humanHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      windowHours: number;
      firstAttempt: { total: number; succeeded: number; rate: number };
      redeliverRequiredCount: number;
      topByRedeliverCount: unknown[];
    };
    expect(body.windowHours).toBe(24);
    expect(body.firstAttempt).toEqual({ total: 1, succeeded: 1, rate: 1 });
    expect(body.redeliverRequiredCount).toBe(0);
    expect(body.topByRedeliverCount).toEqual([]);
  });

  it("is readable by agent callers too (read-only observability, not a trigger surface)", async () => {
    const res = await app.request("/delivery-health", { headers: agentHeaders });
    expect(res.status).toBe(200);
  });

  it("honors a custom hours window", async () => {
    const res = await app.request("/delivery-health?hours=1", { headers: humanHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { windowHours: number };
    expect(body.windowHours).toBe(1);
  });

  it("rejects a non-positive hours window", async () => {
    const res = await app.request("/delivery-health?hours=0", { headers: humanHeaders });
    expect(res.status).toBe(400);
  });

  it("requires authentication", async () => {
    const res = await app.request("/delivery-health");
    expect(res.status).toBe(401);
  });
});
