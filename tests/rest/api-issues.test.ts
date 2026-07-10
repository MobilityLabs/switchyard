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

describe("issue routes", () => {
  it("drives the core loop over REST", async () => {
    const filed = await body<{ ref: string; status: string }>(await app.request("/issues", {
      method: "POST", headers: agentH,
      body: JSON.stringify({
        projectKey: "SYD", title: "Flaky test",
        description: "src/x.ts:1 fails intermittently in CI; looks like a timing issue in the retry loop. Suggest adding a fake timer.",
        provenance: { sourceType: "todo", detail: "src/x.ts:1" },
      }),
    }));
    expect(filed.status).toBe("triage");

    // agent cannot exit triage (SYD-8, over REST)
    const denied = await app.request(`/issues/${filed.ref}`, {
      method: "PATCH", headers: agentH, body: JSON.stringify({ status: "todo" }),
    });
    expect(denied.status).toBe(400);
    expect((await body<{ error: string }>(denied)).error).toMatch(/only humans/i);

    const accepted = await app.request(`/issues/${filed.ref}`, {
      method: "PATCH", headers: humanH, body: JSON.stringify({ status: "todo", priority: "high" }),
    });
    expect((await body<{ status: string }>(accepted)).status).toBe("todo");

    const next = await body<{ ref: string }>(await app.request("/next-task", { headers: agentH }));
    expect(next.ref).toBe(filed.ref);

    await app.request(`/issues/${filed.ref}/claim`, { method: "POST", headers: agentH });
    await app.request(`/issues/${filed.ref}/comments`, {
      method: "POST", headers: agentH, body: JSON.stringify({ body: "done, 3 tests green" }),
    });
    const detail = await body<{ status: string; activity: { type: string }[] }>(
      await app.request(`/issues/${filed.ref}`, { headers: humanH })
    );
    expect(detail.status).toBe("in_progress");
    expect(detail.activity.map((a) => a.type)).toContain("comment");

    const search = await body<unknown[]>(
      await app.request("/issues?project=SYD&status=in_progress", { headers: humanH })
    );
    expect(search).toHaveLength(1);
  });

  it("flags attention for an unresolved delivery_failed, over REST list and detail", async () => {
    await app.request("/issues", { method: "POST", headers: humanH, body: JSON.stringify({ projectKey: "SYD", title: "Ship it" }) });
    await app.request("/issues/SYD-1/delivery-events", {
      method: "POST", headers: agentH, body: JSON.stringify({ type: "delivery_failed", message: "merge conflict" }),
    });

    const detail = await body<{ attention: { reason: string; message: string } | null }>(
      await app.request("/issues/SYD-1", { headers: humanH })
    );
    expect(detail.attention).toEqual({ reason: "delivery_failed", message: "merge conflict" });

    const list = await body<{ ref: string; attention: unknown }[]>(
      await app.request("/issues?project=SYD", { headers: humanH })
    );
    expect(list.find((i) => i.ref === "SYD-1")?.attention).toEqual({ reason: "delivery_failed", message: "merge conflict" });

    // Clears once delivered.
    await app.request("/issues/SYD-1/delivery-events", {
      method: "POST", headers: agentH,
      body: JSON.stringify({ type: "delivered", prNumber: 1, mergeSha: "abc123", deploy: { ran: false } }),
    });
    const cleared = await body<{ attention: unknown }>(await app.request("/issues/SYD-1", { headers: humanH }));
    expect(cleared.attention).toBeNull();
  });

  it("flags an open PR for list/detail, and refuses a second claim while it's open (SYD-99)", async () => {
    await app.request("/issues", { method: "POST", headers: humanH, body: JSON.stringify({ projectKey: "SYD", title: "Ship it" }) });
    await app.request("/issues/SYD-1", { method: "PATCH", headers: humanH, body: JSON.stringify({ status: "todo" }) });
    await app.request("/issues/SYD-1/claim", { method: "POST", headers: agentH });
    await app.request("/issues/SYD-1/delivery-events", {
      method: "POST", headers: agentH,
      body: JSON.stringify({ type: "pr_opened", prNumber: 41, url: "https://github.com/acme/widgets/pull/41" }),
    });

    const detail = await body<{ openPr: { prNumber: number; url: string } | null }>(
      await app.request("/issues/SYD-1", { headers: humanH })
    );
    expect(detail.openPr).toEqual({ prNumber: 41, url: "https://github.com/acme/widgets/pull/41" });

    const list = await body<{ ref: string; openPr: unknown }[]>(
      await app.request("/issues?project=SYD", { headers: humanH })
    );
    expect(list.find((i) => i.ref === "SYD-1")?.openPr).toEqual({ prNumber: 41, url: "https://github.com/acme/widgets/pull/41" });

    // A different actor claiming while the PR is open is refused.
    const other = createActor(db, { name: "claude/other", type: "agent" });
    const otherH = { authorization: `Bearer ${other.token}` };
    const denied = await app.request("/issues/SYD-1/claim", { method: "POST", headers: otherH });
    expect(denied.status).toBe(400);
    expect((await body<{ error: string }>(denied)).error).toMatch(/already claimed by claude\/dev/i);
  });

  it("flags a blocked issue in the todo list feed the dispatcher reads (SYD-160)", async () => {
    for (const title of ["Schema", "API"]) {
      await app.request("/issues", { method: "POST", headers: humanH, body: JSON.stringify({ projectKey: "SYD", title }) });
    }
    for (const ref of ["SYD-1", "SYD-2"]) {
      await app.request(`/issues/${ref}`, { method: "PATCH", headers: humanH, body: JSON.stringify({ status: "todo" }) });
    }
    await app.request("/dependencies", {
      method: "POST", headers: humanH, body: JSON.stringify({ blockerRef: "SYD-1", blockedRef: "SYD-2" }),
    });
    const list = await body<{ ref: string; blocked: boolean }[]>(
      await app.request("/issues?project=SYD&status=todo", { headers: humanH })
    );
    expect(list.find((i) => i.ref === "SYD-1")?.blocked).toBe(false);
    expect(list.find((i) => i.ref === "SYD-2")?.blocked).toBe(true);
  });

  it("dependencies block claims over REST", async () => {
    for (const title of ["Schema", "API"]) {
      await app.request("/issues", { method: "POST", headers: humanH, body: JSON.stringify({ projectKey: "SYD", title }) });
    }
    for (const ref of ["SYD-1", "SYD-2"]) {
      await app.request(`/issues/${ref}`, { method: "PATCH", headers: humanH, body: JSON.stringify({ status: "todo" }) });
    }
    await app.request("/dependencies", {
      method: "POST", headers: humanH, body: JSON.stringify({ blockerRef: "SYD-1", blockedRef: "SYD-2" }),
    });
    const denied = await app.request("/issues/SYD-2/claim", { method: "POST", headers: agentH });
    expect(denied.status).toBe(400);
    expect((await body<{ error: string }>(denied)).error).toMatch(/blocked by SYD-1/);
  });
});
