import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue } from "../../src/services/issues.js";
import { searchIssues } from "../../src/services/search.js";
import { recordDeliveryEvent } from "../../src/services/delivery-events.js";

let db: Db, human: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  createProject(db, { key: "AIPI", name: "aipi" });
  createProject(db, { key: "HAND", name: "housing" });
  createIssue(db, human, { projectKey: "AIPI", title: "Fix flaky API test", labels: ["testing"] });
  createIssue(db, human, { projectKey: "AIPI", title: "Write docs" });
  createIssue(db, human, { projectKey: "HAND", title: "Map layer bug" });
  updateIssue(db, human, "AIPI-1", { status: "todo", assigneeName: "sean" });
});

describe("searchIssues", () => {
  it("filters by project, status, assignee, label, and text — ANDed", () => {
    expect(searchIssues(db, { projectKey: "AIPI" })).toHaveLength(2);
    expect(searchIssues(db, { status: "todo" }).map((i) => i.ref)).toEqual(["AIPI-1"]);
    expect(searchIssues(db, { assigneeName: "sean" }).map((i) => i.ref)).toEqual(["AIPI-1"]);
    expect(searchIssues(db, { label: "testing" }).map((i) => i.ref)).toEqual(["AIPI-1"]);
    expect(searchIssues(db, { text: "FLAKY" }).map((i) => i.ref)).toEqual(["AIPI-1"]);
    expect(searchIssues(db, { projectKey: "HAND", status: "todo" })).toHaveLength(0);
  });

  it("returns everything with no filters, newest first", () => {
    const all = searchIssues(db, {});
    expect(all).toHaveLength(3);
    expect(all[0].ref).toBe("HAND-1");
  });

  it("orders the triage status filter oldest first (SYD-159)", () => {
    const agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
    const provenance = { sourceType: "session" as const, detail: "test" };
    createIssue(db, agent, { projectKey: "AIPI", title: "Filed first", description: "d", provenance });
    createIssue(db, agent, { projectKey: "AIPI", title: "Filed second", description: "d", provenance });
    const triaged = searchIssues(db, { status: "triage" }).map((i) => i.ref);
    expect(triaged).toEqual(["AIPI-3", "AIPI-4"]);
  });

  it("attention filter (SYD-94) restricts to issues with an unresolved delivery_failed", () => {
    const agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
    recordDeliveryEvent(db, agent, "AIPI-2", { type: "delivery_failed", message: "merge conflict" });
    expect(searchIssues(db, { attention: "delivery_failed" }).map((i) => i.ref)).toEqual(["AIPI-2"]);
  });

  it("attention filter returns nothing when no issue is flagged", () => {
    expect(searchIssues(db, { attention: "delivery_failed" })).toEqual([]);
  });

  it("attention filter clears once a later delivered event fires", () => {
    const agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
    recordDeliveryEvent(db, agent, "AIPI-2", { type: "delivery_failed", message: "merge conflict" });
    recordDeliveryEvent(db, agent, "AIPI-2", { type: "delivered", prNumber: 7, mergeSha: "abc123", deploy: { ran: false } });
    expect(searchIssues(db, { attention: "delivery_failed" })).toEqual([]);
  });

  it("attention filter combines (ANDed) with other filters", () => {
    const agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
    recordDeliveryEvent(db, agent, "AIPI-2", { type: "delivery_failed", message: "merge conflict" });
    expect(searchIssues(db, { attention: "delivery_failed", projectKey: "HAND" })).toEqual([]);
    expect(searchIssues(db, { attention: "delivery_failed", projectKey: "AIPI" }).map((i) => i.ref)).toEqual(["AIPI-2"]);
  });

  it("issues a single query regardless of result-set size (SYD-143 — no per-row project SELECT)", () => {
    for (let i = 0; i < 20; i++) {
      createIssue(db, human, { projectKey: "AIPI", title: `Bulk issue ${i}` });
    }
    const client = (db as unknown as { $client: Database.Database }).$client;
    const prepare = client.prepare.bind(client);
    const calls: string[] = [];
    client.prepare = ((sql: string) => {
      calls.push(sql);
      return prepare(sql);
    }) as typeof client.prepare;
    try {
      const results = searchIssues(db, {});
      expect(results.length).toBeGreaterThan(15);
      expect(calls.filter((sql) => /select/i.test(sql))).toHaveLength(1);
    } finally {
      client.prepare = prepare;
    }
  });

  it("openPr filter (SYD-171) restricts to issues with a still-open agent PR", () => {
    const agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
    recordDeliveryEvent(db, agent, "AIPI-2", { type: "pr_opened", prNumber: 41, url: "https://github.com/acme/widgets/pull/41" });
    expect(searchIssues(db, { openPr: true }).map((i) => i.ref)).toEqual(["AIPI-2"]);
    expect(searchIssues(db, { openPr: false }).map((i) => i.ref).sort()).toEqual(["AIPI-1", "HAND-1"]);
  });

  it("openPr filter returns nothing when no issue has an open PR", () => {
    expect(searchIssues(db, { openPr: true })).toEqual([]);
  });

  it("openPr filter clears once the PR is delivered", () => {
    const agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
    recordDeliveryEvent(db, agent, "AIPI-2", { type: "pr_opened", prNumber: 41, url: "https://github.com/acme/widgets/pull/41" });
    recordDeliveryEvent(db, agent, "AIPI-2", { type: "delivered", prNumber: 41, mergeSha: "abc123", deploy: { ran: false } });
    expect(searchIssues(db, { openPr: true })).toEqual([]);
  });

  it("openPr filter combines (ANDed) with status, e.g. done-but-not-yet-merged", () => {
    const agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
    updateIssue(db, human, "AIPI-2", { status: "todo" });
    recordDeliveryEvent(db, agent, "AIPI-2", { type: "pr_opened", prNumber: 41, url: "https://github.com/acme/widgets/pull/41" });
    updateIssue(db, human, "AIPI-2", { status: "done" });
    expect(searchIssues(db, { status: "done", openPr: true }).map((i) => i.ref)).toEqual(["AIPI-2"]);
    expect(searchIssues(db, { status: "todo", openPr: true })).toEqual([]);
  });

  it("treats %, _ and ~ in text as literals", () => {
    createIssue(db, human, { projectKey: "AIPI", title: "Progress at 50% done" });
    createIssue(db, human, { projectKey: "AIPI", title: "snake_case naming" });
    createIssue(db, human, { projectKey: "AIPI", title: "v1.2~beta release" });
    createIssue(db, human, { projectKey: "AIPI", title: "Progress at 50x done" });   // would match "50%" if % were a wildcard
    createIssue(db, human, { projectKey: "AIPI", title: "each case handling" });      // would match "e_c" if _ were a wildcard
    expect(searchIssues(db, { text: "50%" }).map((i) => i.title)).toEqual(["Progress at 50% done"]);
    expect(searchIssues(db, { text: "e_c" }).map((i) => i.title)).toEqual(["snake_case naming"]);
    expect(searchIssues(db, { text: "2~beta" }).map((i) => i.title)).toEqual(["v1.2~beta release"]);
  });
});
