import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { addGithubRepo } from "../../src/services/github-repos.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";
import {
  findResumeRefs,
  selectDispatchable,
  type FeedEvent,
  type WorkerIssue,
} from "../../scripts/worker-select.js";

let db: Db, app: ReturnType<typeof buildApiRoutes>;
let agentH: Record<string, string>, humanH: Record<string, string>;
let humanActor: Actor;

beforeEach(() => {
  db = openDb(":memory:");
  const agent = createActor(db, { name: "claude/dev", type: "agent" });
  const human = createActor(db, { name: "sean", type: "human" });
  humanActor = human.actor;
  agentH = { authorization: `Bearer ${agent.token}`, "content-type": "application/json" };
  humanH = { authorization: `Bearer ${human.token}`, "content-type": "application/json" };
  createProject(db, human.actor, { key: "SYD", name: "Switchyard" });
  app = buildApiRoutes(db);
});

async function body<T>(r: Response): Promise<T> {
  return (await r.json()) as T;
}

describe("escalation, snooze, and duplicate routes", () => {
  it("request-input sets needs-input, comments visible, filterable, and clears on human comment", async () => {
    const filed = await body<{ ref: string }>(
      await app.request("/issues", {
        method: "POST",
        headers: agentH,
        body: JSON.stringify({
          projectKey: "SYD",
          title: "Ambiguous requirement",
          description: "Not sure whether to support multi-tenant here; needs a human decision.",
          provenance: { sourceType: "manual", detail: "x" },
        }),
      }),
    );

    const escalated = await body<{ needsInput: boolean }>(
      await app.request(`/issues/${filed.ref}/request-input`, {
        method: "POST",
        headers: agentH,
        body: JSON.stringify({ question: "Should this support multi-tenant configs?" }),
      }),
    );
    expect(escalated.needsInput).toBe(true);

    const detail = await body<{
      needsInput: boolean;
      activity: { type: string; payload: { body?: string } }[];
    }>(await app.request(`/issues/${filed.ref}`, { headers: humanH }));
    expect(detail.needsInput).toBe(true);
    expect(detail.activity.some((a) => a.type === "needs_input_set")).toBe(true);
    expect(
      detail.activity.some(
        (a) =>
          a.type === "comment" && a.payload.body === "Should this support multi-tenant configs?",
      ),
    ).toBe(true);

    const filtered = await body<{ ref: string }[]>(
      await app.request("/issues?needs_input=true", { headers: humanH }),
    );
    expect(filtered.map((i) => i.ref)).toContain(filed.ref);

    await app.request(`/issues/${filed.ref}/comments`, {
      method: "POST",
      headers: humanH,
      body: JSON.stringify({ body: "No, single-tenant is fine." }),
    });
    const cleared = await body<{ needsInput: boolean }>(
      await app.request(`/issues/${filed.ref}`, { headers: humanH }),
    );
    expect(cleared.needsInput).toBe(false);
  });

  it("a human answer releases the claim and the event feed triggers a worker resume", async () => {
    const filed = await body<{ ref: string }>(
      await app.request("/issues", {
        method: "POST",
        headers: agentH,
        body: JSON.stringify({
          projectKey: "SYD",
          title: "Needs a decision mid-flight",
          description: "Agent work that will hit an open question.",
          provenance: { sourceType: "manual", detail: "x" },
        }),
      }),
    );
    await app.request(`/issues/${filed.ref}`, {
      method: "PATCH",
      headers: humanH,
      body: JSON.stringify({ status: "todo", labels: ["auto"] }),
    });
    const claimed = await body<{ leaseToken: string }>(
      await app.request(`/issues/${filed.ref}/claim`, { method: "POST", headers: agentH }),
    );
    await app.request(`/issues/${filed.ref}/request-input`, {
      method: "POST",
      headers: { ...agentH, "X-Switchyard-Lease": claimed.leaseToken },
      body: JSON.stringify({ question: "Ship behind a flag?" }),
    });

    // A worker that initialized its event cursor before the answer landed...
    const config = {
      url: "http://x",
      label: "auto",
      intervalSeconds: 300,
      maxConcurrent: 1,
      projects: { SYD: { repo: "/tmp" } },
    };
    const before = await body<FeedEvent[]>(await app.request("/events", { headers: agentH }));
    const cursor = findResumeRefs(before, config, null).lastEventId;

    // ...sees the human's answer as a resume trigger for exactly that ref,
    await app.request(`/issues/${filed.ref}/comments`, {
      method: "POST",
      headers: humanH,
      body: JSON.stringify({ body: "Yes — behind a flag." }),
    });
    const after = await body<FeedEvent[]>(await app.request("/events", { headers: agentH }));
    expect(findResumeRefs(after, config, cursor).refs).toEqual([filed.ref]);

    // ...and the issue is already released: todo, unassigned, dispatchable.
    const released = await body<WorkerIssue[]>(
      await app.request("/issues?status=todo", { headers: agentH }),
    );
    expect(selectDispatchable(released, config, []).map((i) => i.ref)).toEqual([filed.ref]);
  });

  it("snooze is human-only and hides the issue from exclude_snoozed searches", async () => {
    const filed = await body<{ ref: string }>(
      await app.request("/issues", {
        method: "POST",
        headers: humanH,
        body: JSON.stringify({ projectKey: "SYD", title: "Later" }),
      }),
    );

    const future = Math.floor(Date.now() / 1000) + 3600;
    const denied = await app.request(`/issues/${filed.ref}/snooze`, {
      method: "POST",
      headers: agentH,
      body: JSON.stringify({ until: future }),
    });
    expect(denied.status).toBe(400);
    expect((await body<{ error: string }>(denied)).error).toMatch(/only humans/i);

    const snoozed = await body<{ snoozedUntil: number }>(
      await app.request(`/issues/${filed.ref}/snooze`, {
        method: "POST",
        headers: humanH,
        body: JSON.stringify({ until: future }),
      }),
    );
    expect(snoozed.snoozedUntil).toBe(future);

    const withDefault = await body<{ ref: string }[]>(
      await app.request(`/issues?project=SYD&status=backlog`, { headers: humanH }),
    );
    expect(withDefault.map((i) => i.ref)).toContain(filed.ref);

    const excluded = await body<{ ref: string }[]>(
      await app.request(`/issues?project=SYD&status=backlog&exclude_snoozed=true`, {
        headers: humanH,
      }),
    );
    expect(excluded.map((i) => i.ref)).not.toContain(filed.ref);
  });

  it("duplicate is human-only, links, and cancels the issue", async () => {
    const original = await body<{ ref: string }>(
      await app.request("/issues", {
        method: "POST",
        headers: humanH,
        body: JSON.stringify({ projectKey: "SYD", title: "Original bug" }),
      }),
    );
    const dup = await body<{ ref: string }>(
      await app.request("/issues", {
        method: "POST",
        headers: humanH,
        body: JSON.stringify({ projectKey: "SYD", title: "Duplicate bug" }),
      }),
    );

    const denied = await app.request(`/issues/${dup.ref}/duplicate`, {
      method: "POST",
      headers: agentH,
      body: JSON.stringify({ of: original.ref }),
    });
    expect(denied.status).toBe(400);
    expect((await body<{ error: string }>(denied)).error).toMatch(/only humans/i);

    const marked = await body<{
      status: string;
      activity: { type: string; payload: { of?: string } }[];
    }>(
      await (async () => {
        await app.request(`/issues/${dup.ref}/duplicate`, {
          method: "POST",
          headers: humanH,
          body: JSON.stringify({ of: original.ref }),
        });
        return app.request(`/issues/${dup.ref}`, { headers: humanH });
      })(),
    );
    expect(marked.status).toBe("canceled");
    expect(
      marked.activity.some((a) => a.type === "marked_duplicate" && a.payload.of === original.ref),
    ).toBe(true);
  });

  it("redeliver is human-only and requires an unresolved delivery failure", async () => {
    const filed = await body<{ ref: string }>(
      await app.request("/issues", {
        method: "POST",
        headers: humanH,
        body: JSON.stringify({ projectKey: "SYD", title: "Ship it" }),
      }),
    );

    const noFailure = await app.request(`/issues/${filed.ref}/redeliver`, {
      method: "POST",
      headers: humanH,
      body: "{}",
    });
    expect(noFailure.status).toBe(400);
    expect((await body<{ error: string }>(noFailure)).error).toMatch(
      /no unresolved delivery failure/i,
    );

    await app.request(`/issues/${filed.ref}/delivery-events`, {
      method: "POST",
      headers: humanH,
      body: JSON.stringify({ type: "delivery_failed", message: "merge conflict" }),
    });

    const denied = await app.request(`/issues/${filed.ref}/redeliver`, {
      method: "POST",
      headers: agentH,
      body: "{}",
    });
    expect(denied.status).toBe(400);
    expect((await body<{ error: string }>(denied)).error).toMatch(/only humans/i);

    // This issue has no pr_state row at all (no repo bound, no PR ever
    // opened), so deliveryPinFor finds nothing to redeliver — refused before
    // the expectedHeadSha compare-and-set even gets a chance to run.
    const retried = await app.request(`/issues/${filed.ref}/redeliver`, {
      method: "POST",
      headers: humanH,
      body: "{}",
    });
    expect(retried.status).toBe(400);
    expect((await body<{ error: string }>(retried)).error).toMatch(/no agent PR on record/i);
  });

  it("redeliver succeeds with a confirmed head SHA and refuses a moved one (SYD-208)", async () => {
    addGithubRepo(db, humanActor, { fullName: "acme/widgets", projectKey: "SYD" });
    const filed = await body<{ ref: string }>(
      await app.request("/issues", {
        method: "POST",
        headers: humanH,
        body: JSON.stringify({ projectKey: "SYD", title: "Ship it again" }),
      }),
    );
    // pr_opened writes the pr_state row (attributed via the agent/<ref>
    // branch convention) that deliveryPinFor reads back below.
    await app.request(`/issues/${filed.ref}/delivery-events`, {
      method: "POST",
      headers: humanH,
      body: JSON.stringify({
        type: "pr_opened",
        prNumber: 55,
        url: "https://github.com/acme/widgets/pull/55",
        headSha: "sha55",
      }),
    });
    await app.request(`/issues/${filed.ref}/delivery-events`, {
      method: "POST",
      headers: humanH,
      body: JSON.stringify({ type: "delivery_failed", message: "merge conflict" }),
    });

    const movedHead = await app.request(`/issues/${filed.ref}/redeliver`, {
      method: "POST",
      headers: humanH,
      body: JSON.stringify({ expectedHeadSha: "stale-sha" }),
    });
    expect(movedHead.status).toBe(400);
    expect((await body<{ error: string }>(movedHead)).error).toMatch(/head moved/i);

    const ok = await app.request(`/issues/${filed.ref}/redeliver`, {
      method: "POST",
      headers: humanH,
      body: JSON.stringify({ expectedHeadSha: "sha55" }),
    });
    expect(ok.status).toBe(200);

    const detail = await body<{
      activity: { type: string; payload: Record<string, unknown> }[];
    }>(await app.request(`/issues/${filed.ref}`, { headers: humanH }));
    const ev = detail.activity.find((a) => a.type === "redeliver_requested");
    expect(ev?.payload).toEqual({
      pin: { repo: "acme/widgets", prNumber: 55, headSha: "sha55" },
    });
  });
});
