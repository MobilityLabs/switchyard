import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { addGithubRepo } from "../../src/services/github-repos.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";
import { WORKER_OUTCOMES } from "../../src/rest/schemas.js";
import { DELIVERY_OUTCOMES } from "../../src/db/schema.js";

let db: Db, app: ReturnType<typeof buildApiRoutes>;
let agentH: Record<string, string>, humanH: Record<string, string>;

beforeEach(() => {
  db = openDb(":memory:");
  // The delivery infra (deliver.ts / agent-worker.ts) authenticates with a
  // human-typed token (SYD-107/108) — agent tokens are rejected below.
  const agent = createActor(db, { name: "claude/dev", type: "agent" });
  const worker = createActor(db, { name: "delivery-worker", type: "human" });
  agentH = { authorization: `Bearer ${agent.token}`, "content-type": "application/json" };
  humanH = { authorization: `Bearer ${worker.token}`, "content-type": "application/json" };
  createProject(db, worker.actor, { key: "SYD", name: "Switchyard" });
  addGithubRepo(db, worker.actor, { fullName: "acme/widgets", projectKey: "SYD" });
  app = buildApiRoutes(db);
});

async function body<T>(r: Response): Promise<T> {
  return (await r.json()) as T;
}

/**
 * Files SYD-1 (if not already filed) and pins a done-stamp authorization to
 * it: pr_opened(headSha) followed by a human PATCH to done with a matching
 * expectedHeadSha. This is the same compare-and-set pin the SYD-208 delivery
 * trigger reads (see updateIssue's done-pin gate and pr-status.deliveryPinFor).
 */
async function seedPendingAuthorization(headSha: string): Promise<number> {
  await app.request("/issues", {
    method: "POST",
    headers: humanH,
    body: JSON.stringify({ projectKey: "SYD", title: "Ship v1" }),
  });
  await app.request("/issues/SYD-1/delivery-events", {
    method: "POST",
    headers: humanH,
    body: JSON.stringify({
      type: "pr_opened",
      prNumber: 9,
      url: "https://github.com/acme/widgets/pull/9",
      headSha,
    }),
  });
  const done = await app.request("/issues/SYD-1", {
    method: "PATCH",
    headers: humanH,
    body: JSON.stringify({ status: "done", expectedHeadSha: headSha }),
  });
  expect(done.status).toBe(200);
  const work = await body<{ pending: { authorizationId: number }[] }>(
    await app.request("/delivery-work", { headers: humanH }),
  );
  expect(work.pending).toHaveLength(1);
  return work.pending[0].authorizationId;
}

describe("GET /api/delivery-work", () => {
  it("refuses agent tokens", async () => {
    const res = await app.request("/delivery-work", { headers: agentH });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/delivery infrastructure/);
  });

  it("returns pending authorizations with pins, unfinished attempts, and deploy retries", async () => {
    const headSha = "a".repeat(40);
    const authorizationId = await seedPendingAuthorization(headSha);

    const work = await body<{
      pending: { authorizationId: number; ref: string; kind: string; pin: unknown }[];
      unfinished: unknown[];
      deployRetries: unknown[];
    }>(await app.request("/delivery-work", { headers: humanH }));

    expect(work.pending).toEqual([
      {
        authorizationId,
        ref: "SYD-1",
        kind: "done_stamp",
        pin: { repo: "acme/widgets", prNumber: 9, headSha },
      },
    ]);
    expect(work.unfinished).toEqual([]);
    expect(work.deployRetries).toEqual([]);
  });
});

describe("POST /api/issues/:ref/delivery-attempts", () => {
  it("starts an attempt and enforces once-per-authorization on a second call", async () => {
    const headSha = "b".repeat(40);
    const authorizationId = await seedPendingAuthorization(headSha);

    const first = await app.request("/issues/SYD-1/delivery-attempts", {
      method: "POST",
      headers: humanH,
      body: JSON.stringify({ authorizationId, prNumber: 9, headSha }),
    });
    expect(first.status).toBe(200);
    const attempt = await body<{ id: number; outcome: string | null; finishedAt: number | null }>(
      first,
    );
    expect(attempt.outcome).toBeNull();
    expect(attempt.finishedAt).toBeNull();

    const second = await app.request("/issues/SYD-1/delivery-attempts", {
      method: "POST",
      headers: humanH,
      body: JSON.stringify({ authorizationId, prNumber: 9, headSha }),
    });
    expect(second.status).toBe(400);
    expect((await body<{ error: string }>(second)).error).toMatch(
      /already has a delivery attempt/i,
    );
  });

  it("refuses agent tokens", async () => {
    const headSha = "b".repeat(40);
    const authorizationId = await seedPendingAuthorization(headSha);

    const res = await app.request("/issues/SYD-1/delivery-attempts", {
      method: "POST",
      headers: agentH,
      body: JSON.stringify({ authorizationId }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/delivery infrastructure/);
  });
});

describe("PATCH /api/delivery-attempts/:id", () => {
  it("finishes with an outcome; rejects skipped_rollout at the schema layer (400)", async () => {
    const headSha = "c".repeat(40);
    const authorizationId = await seedPendingAuthorization(headSha);
    const started = await body<{ id: number }>(
      await app.request("/issues/SYD-1/delivery-attempts", {
        method: "POST",
        headers: humanH,
        body: JSON.stringify({ authorizationId, prNumber: 9, headSha }),
      }),
    );

    const rejected = await app.request(`/delivery-attempts/${started.id}`, {
      method: "PATCH",
      headers: humanH,
      body: JSON.stringify({ outcome: "skipped_rollout" }),
    });
    expect(rejected.status).toBe(400);
    expect((await body<{ error: string }>(rejected)).error).toMatch(/at "outcome"/);

    const finished = await app.request(`/delivery-attempts/${started.id}`, {
      method: "PATCH",
      headers: humanH,
      body: JSON.stringify({ outcome: "merged_deployed", derivedHeadSha: "d".repeat(40) }),
    });
    expect(finished.status).toBe(200);
    const row = await body<{ outcome: string; finishedAt: number | null; derivedHeadSha: string }>(
      finished,
    );
    expect(row.outcome).toBe("merged_deployed");
    expect(row.derivedHeadSha).toBe("d".repeat(40));
    expect(row.finishedAt).not.toBeNull();
  });

  it("refuses agent tokens", async () => {
    const headSha = "e".repeat(40);
    const authorizationId = await seedPendingAuthorization(headSha);
    const started = await body<{ id: number }>(
      await app.request("/issues/SYD-1/delivery-attempts", {
        method: "POST",
        headers: humanH,
        body: JSON.stringify({ authorizationId, prNumber: 9, headSha }),
      }),
    );

    const res = await app.request(`/delivery-attempts/${started.id}`, {
      method: "PATCH",
      headers: agentH,
      body: JSON.stringify({ outcome: "merged_deployed" }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/delivery infrastructure/);
  });
});

// SYD-208 handoff note: WORKER_OUTCOMES is hand-written (not
// DELIVERY_OUTCOMES.filter(...) cast to a tuple) so z.enum typechecks
// cleanly — this pins the two lists together so they can't silently drift.
describe("WORKER_OUTCOMES", () => {
  it("equals DELIVERY_OUTCOMES minus skipped_rollout", () => {
    expect(WORKER_OUTCOMES).toEqual(DELIVERY_OUTCOMES.filter((o) => o !== "skipped_rollout"));
  });
});
