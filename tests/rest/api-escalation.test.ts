import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

let db: Db, app: ReturnType<typeof buildApiRoutes>;
let agentH: Record<string, string>, humanH: Record<string, string>;

beforeEach(() => {
  db = openDb(":memory:");
  const agent = createActor(db, { name: "claude/dev", type: "agent" });
  const human = createActor(db, { name: "sean", type: "human" });
  agentH = { authorization: `Bearer ${agent.token}`, "content-type": "application/json" };
  humanH = { authorization: `Bearer ${human.token}`, "content-type": "application/json" };
  createProject(db, { key: "SYD", name: "Switchyard" });
  app = buildApiRoutes(db);
});

async function body<T>(r: Response): Promise<T> { return (await r.json()) as T; }

describe("escalation, snooze, and duplicate routes", () => {
  it("request-input sets needs-input, comments visible, filterable, and clears on human comment", async () => {
    const filed = await body<{ ref: string }>(await app.request("/issues", {
      method: "POST", headers: agentH,
      body: JSON.stringify({
        projectKey: "SYD", title: "Ambiguous requirement",
        description: "Not sure whether to support multi-tenant here; needs a human decision.",
        provenance: { sourceType: "manual", detail: "x" },
      }),
    }));

    const escalated = await body<{ needsInput: boolean }>(await app.request(`/issues/${filed.ref}/request-input`, {
      method: "POST", headers: agentH,
      body: JSON.stringify({ question: "Should this support multi-tenant configs?" }),
    }));
    expect(escalated.needsInput).toBe(true);

    const detail = await body<{ needsInput: boolean; activity: { type: string; payload: { body?: string } }[] }>(
      await app.request(`/issues/${filed.ref}`, { headers: humanH })
    );
    expect(detail.needsInput).toBe(true);
    expect(detail.activity.some((a) => a.type === "needs_input_set")).toBe(true);
    expect(detail.activity.some((a) => a.type === "comment" && a.payload.body === "Should this support multi-tenant configs?")).toBe(true);

    const filtered = await body<{ ref: string }[]>(
      await app.request("/issues?needs_input=true", { headers: humanH })
    );
    expect(filtered.map((i) => i.ref)).toContain(filed.ref);

    await app.request(`/issues/${filed.ref}/comments`, {
      method: "POST", headers: humanH, body: JSON.stringify({ body: "No, single-tenant is fine." }),
    });
    const cleared = await body<{ needsInput: boolean }>(await app.request(`/issues/${filed.ref}`, { headers: humanH }));
    expect(cleared.needsInput).toBe(false);
  });

  it("snooze is human-only and hides the issue from exclude_snoozed searches", async () => {
    const filed = await body<{ ref: string }>(await app.request("/issues", {
      method: "POST", headers: humanH,
      body: JSON.stringify({ projectKey: "SYD", title: "Later" }),
    }));

    const future = Math.floor(Date.now() / 1000) + 3600;
    const denied = await app.request(`/issues/${filed.ref}/snooze`, {
      method: "POST", headers: agentH, body: JSON.stringify({ until: future }),
    });
    expect(denied.status).toBe(400);
    expect((await body<{ error: string }>(denied)).error).toMatch(/only humans/i);

    const snoozed = await body<{ snoozedUntil: number }>(await app.request(`/issues/${filed.ref}/snooze`, {
      method: "POST", headers: humanH, body: JSON.stringify({ until: future }),
    }));
    expect(snoozed.snoozedUntil).toBe(future);

    const withDefault = await body<{ ref: string }[]>(
      await app.request(`/issues?project=SYD&status=backlog`, { headers: humanH })
    );
    expect(withDefault.map((i) => i.ref)).toContain(filed.ref);

    const excluded = await body<{ ref: string }[]>(
      await app.request(`/issues?project=SYD&status=backlog&exclude_snoozed=true`, { headers: humanH })
    );
    expect(excluded.map((i) => i.ref)).not.toContain(filed.ref);
  });

  it("duplicate is human-only, links, and cancels the issue", async () => {
    const original = await body<{ ref: string }>(await app.request("/issues", {
      method: "POST", headers: humanH,
      body: JSON.stringify({ projectKey: "SYD", title: "Original bug" }),
    }));
    const dup = await body<{ ref: string }>(await app.request("/issues", {
      method: "POST", headers: humanH,
      body: JSON.stringify({ projectKey: "SYD", title: "Duplicate bug" }),
    }));

    const denied = await app.request(`/issues/${dup.ref}/duplicate`, {
      method: "POST", headers: agentH, body: JSON.stringify({ of: original.ref }),
    });
    expect(denied.status).toBe(400);
    expect((await body<{ error: string }>(denied)).error).toMatch(/only humans/i);

    const marked = await body<{ status: string; activity: { type: string; payload: { of?: string } }[] }>(
      await (async () => {
        await app.request(`/issues/${dup.ref}/duplicate`, {
          method: "POST", headers: humanH, body: JSON.stringify({ of: original.ref }),
        });
        return app.request(`/issues/${dup.ref}`, { headers: humanH });
      })()
    );
    expect(marked.status).toBe("canceled");
    expect(marked.activity.some((a) => a.type === "marked_duplicate" && a.payload.of === original.ref)).toBe(true);
  });
});
