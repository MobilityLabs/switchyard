import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDb, type Db } from "../../src/db/index.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue } from "../../src/services/issues.js";
import { recordEvent } from "../../src/services/events.js";
import { addGithubRepo } from "../../src/services/github-repos.js";
import { recordDeliveryEvent } from "../../src/services/delivery-events.js";
import type { BoardPage, Issue } from "../../ui/src/types.js";

let db: Db, human: Actor, headers: Record<string, string>;
let app: ReturnType<typeof buildApiRoutes>;
beforeEach(() => {
  db = openDb(":memory:");
  const actor = createActor(db, { name: "human", type: "human" });
  human = actor.actor;
  headers = { authorization: `Bearer ${actor.token}` };
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  createProject(db, human, { key: "OTHER", name: "Other project" });
  app = buildApiRoutes(db);
});

async function read<T>(path: string): Promise<T> {
  const response = await app.request(path, { headers });
  expect(response.status).toBe(200);
  return response.json() as Promise<T>;
}

function traceReads() {
  const client = (db as unknown as { $client: Database.Database }).$client;
  const prepare = client.prepare.bind(client);
  const reads: { query: string; rows: number }[] = [];
  const spy = vi.spyOn(client, "prepare").mockImplementation((query: string) => {
    const statement = prepare(query);
    const all = statement.all.bind(statement);
    statement.all = ((...params: unknown[]) => {
      const rows = all(...params);
      reads.push({ query, rows: rows.length });
      return rows;
    }) as typeof statement.all;
    return statement;
  });
  return { reads, restore: () => spy.mockRestore() };
}

describe("scoped issue enrichment", () => {
  it("does no signal queries for an empty project/status selection", async () => {
    const other = createIssue(db, human, {
      projectKey: "OTHER",
      title: "Unrelated",
      description: "large".repeat(2000),
    });
    recordEvent(db, { issueId: other.id, actorId: human.id, type: "delivery_failed" });
    const trace = traceReads();
    expect(await read("/issues?project=SYD&status=todo")).toEqual([]);
    expect(trace.reads.some(({ query }) => /\b(events|pr_state|dependencies)\b/i.test(query))).toBe(
      false,
    );
    trace.restore();
  });

  it("hydrates signals only for selected issues and preserves full legacy bodies", async () => {
    const selected = createIssue(db, human, {
      projectKey: "SYD",
      title: "Selected",
      description: "Keep this body",
    });
    updateIssue(db, human, selected.ref, { status: "todo" });
    recordEvent(db, {
      issueId: selected.id,
      actorId: human.id,
      type: "delivery_failed",
      payload: { message: "local failure" },
    });
    for (let n = 0; n < 100; n++) {
      const issue = createIssue(db, human, {
        projectKey: "OTHER",
        title: `Other ${n}`,
        description: "unrelated".repeat(1000),
      });
      updateIssue(db, human, issue.ref, { status: "done" });
      recordEvent(db, {
        issueId: issue.id,
        actorId: human.id,
        type: "delivery_failed",
        payload: { message: "unrelated failure" },
      });
    }
    const trace = traceReads();
    const result = await read<Issue[]>("/issues?project=SYD&status=todo&attention=delivery_failed");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      description: "Keep this body",
      attention: { reason: "delivery_failed", message: "local failure" },
    });
    // The old implementation hydrated 100 unrelated issues/failures even
    // when the selected project contained just one row.
    expect(Math.max(...trace.reads.map((read) => read.rows))).toBeLessThanOrEqual(1);
    // The attention filter's result is reused by the REST enrichment pass.
    expect(
      trace.reads.filter(({ query }) => query.includes("WHERE type = 'delivery_failed'")),
    ).toHaveLength(1);
    trace.restore();
  });
});

describe("compact board pages", () => {
  it("bounds each column, paginates all history, and leaves /issues compatible", async () => {
    for (let n = 0; n < 120; n++) {
      const issue = createIssue(db, human, {
        projectKey: "SYD",
        title: `Done ${n}`,
        description: "body".repeat(2000),
      });
      updateIssue(db, human, issue.ref, { status: "done" });
    }
    createIssue(db, human, { projectKey: "OTHER", title: "Not on this board" });
    const first = await read<BoardPage>("/board?project=SYD&done=all");
    expect(first.columns.done).toMatchObject({ total: 120, matching: 120 });
    expect(first.columns.done.items).toHaveLength(50);
    expect(first.columns.done.items[0]).not.toHaveProperty("description");
    expect(JSON.stringify(first).length).toBeLessThan(30000);
    const trace = traceReads();
    const second = await read<BoardPage>(
      `/board?project=SYD&done=all&before_done=${first.columns.done.nextBeforeId}`,
    );
    expect(second.columns.done.items).toHaveLength(50);
    expect(
      second.columns.done.items.every(
        (item) => !first.columns.done.items.some((prior) => prior.id === item.id),
      ),
    ).toBe(true);
    expect(trace.reads.every(({ query }) => !query.includes('"description"'))).toBe(true);
    trace.restore();
    const last = await read<BoardPage>(
      `/board?project=SYD&done=all&before_done=${second.columns.done.nextBeforeId}`,
    );
    expect(last.columns.done.items).toHaveLength(20);
    expect(last.columns.done.nextBeforeId).toBeNull();
    const legacy = await read<Issue[]>("/issues?project=SYD");
    expect(legacy).toHaveLength(120);
    expect(legacy[0].description).toBe("body".repeat(2000));
  });

  it("applies done filters before paging, preserving OR semantics and total badges", async () => {
    addGithubRepo(db, human, { fullName: "acme/widgets", projectKey: "SYD" });
    const failed = createIssue(db, human, { projectKey: "SYD", title: "Old failure" });
    const open = createIssue(db, human, { projectKey: "SYD", title: "Old open PR" });
    const unlinked = createIssue(db, human, { projectKey: "SYD", title: "Missing link" });
    for (const issue of [failed, open, unlinked])
      updateIssue(db, human, issue.ref, { status: "done" });
    recordEvent(db, { issueId: failed.id, actorId: human.id, type: "delivery_failed" });
    recordEvent(db, {
      issueId: unlinked.id,
      actorId: human.id,
      type: "process_deviation",
      payload: { reason: "done_without_merged_pr" },
    });
    recordDeliveryEvent(db, human, open.ref, {
      type: "pr_opened",
      prNumber: 7,
      url: "https://github.com/acme/widgets/pull/7",
      headSha: "reviewed-head",
    });
    // Push both actionable cards beyond the first unfiltered history page.
    for (let n = 0; n < 60; n++) {
      const issue = createIssue(db, human, { projectKey: "SYD", title: `Clean ${n}` });
      updateIssue(db, human, issue.ref, { status: "done" });
    }
    const defaults = await read<BoardPage>("/board?project=SYD");
    expect(defaults.columns.done.total).toBe(63);
    expect(defaults.columns.done.matching).toBe(2);
    expect(defaults.columns.done.items.map((i) => i.id).sort()).toEqual(
      [failed.id, open.id].sort(),
    );
    expect(defaults.columns.done.items.find((i) => i.id === open.id)?.openPr?.headSha).toBe(
      "reviewed-head",
    );
    const missing = await read<BoardPage>("/board?project=SYD&done=unlinked");
    expect(missing.columns.done.items.map((i) => i.id)).toEqual([unlinked.id]);
    const small = await read<BoardPage>("/board?project=SYD&limit=1");
    expect(small.columns.done.items).toHaveLength(1);
    expect(small.columns.done.matching).toBe(2);
    expect(await read("/issue-counts?project=SYD")).toEqual({ done: 63 });
  });

  it("validates filters, page sizes, and cursors", async () => {
    for (const query of [
      "done=invalid",
      "limit=0",
      "limit=101",
      "before_done=-1",
      "before_todo=not-a-number",
    ]) {
      expect((await app.request(`/board?project=SYD&${query}`, { headers })).status).toBe(400);
    }
  });
});
