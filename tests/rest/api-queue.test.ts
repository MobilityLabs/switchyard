// GET /api/queue and POST /api/issues/:ref/queue-position (SYD-294).
//
// The ordering logic itself is covered in tests/services/queue.test.ts; this
// file exists for the wiring, which nothing else exercises — a route reaching
// the wrong service, or a body schema that rejects the `null` that means
// "remove from the queue", would both pass typecheck and fail in production.
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue } from "../../src/services/issues.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

let db: Db, app: ReturnType<typeof buildApiRoutes>;
let humanHeaders: Record<string, string>, agentHeaders: Record<string, string>;

beforeEach(() => {
  db = openDb(":memory:");
  const human = createActor(db, { name: "sean", type: "human" });
  const agent = createActor(db, { name: "claude/dev", type: "agent" });
  humanHeaders = { authorization: `Bearer ${human.token}` };
  agentHeaders = { authorization: `Bearer ${agent.token}` };
  createProject(db, human.actor, { key: "SYD", name: "Switchyard" });
  for (const title of ["One", "Two"]) {
    const issue = createIssue(db, human.actor, { projectKey: "SYD", title });
    updateIssue(db, human.actor, issue.ref, { status: "todo" });
  }
  app = buildApiRoutes(db);
});

const place = (ref: string, position: number | null, headers = humanHeaders) =>
  app.request(`/issues/${ref}/queue-position`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ position }),
  });

const queueRefs = async () => {
  const res = await app.request("/queue", { headers: humanHeaders });
  return ((await res.json()) as { ref: string }[]).map((i) => i.ref);
};

describe("the queue over REST", () => {
  it("starts empty", async () => {
    expect(await queueRefs()).toEqual([]);
  });

  it("places an issue and returns the resulting queue", async () => {
    const res = await place("SYD-2", 1);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ref: string }[]).map((i) => i.ref)).toEqual(["SYD-2"]);
    expect(await queueRefs()).toEqual(["SYD-2"]);
  });

  it("accepts null to remove an issue from the queue", async () => {
    await place("SYD-1", 1);
    await place("SYD-2", 2);
    expect(await queueRefs()).toEqual(["SYD-1", "SYD-2"]);
    // The case a non-nullable schema would silently reject.
    expect((await place("SYD-1", null)).status).toBe(200);
    expect(await queueRefs()).toEqual(["SYD-2"]);
  });

  it("rejects a zero or negative position with a 400, not a 500", async () => {
    const res = await place("SYD-1", 0);
    expect(res.status).toBe(400);
  });

  it("lets an agent order the board — ordering refines priority, which is not human-gated", async () => {
    expect((await place("SYD-2", 1, agentHeaders)).status).toBe(200);
    expect(await queueRefs()).toEqual(["SYD-2"]);
  });

  it("requires authentication", async () => {
    expect((await app.request("/queue")).status).toBe(401);
  });
});
