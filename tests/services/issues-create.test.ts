import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, getIssue } from "../../src/services/issues.js";
import { listIssueEvents } from "../../src/services/events.js";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, { key: "AIPI", name: "aipi" });
});

describe("createIssue", () => {
  it("human-created issues land in backlog with a ref and a created event", () => {
    const issue = createIssue(db, human, { projectKey: "AIPI", title: "Ship v1" });
    expect(issue.ref).toBe("AIPI-1");
    expect(issue.status).toBe("backlog");
    const ev = listIssueEvents(db, issue.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: "created", actorName: "sean" });
  });

  it("agent-created issues require provenance and land in triage", () => {
    expect(() => createIssue(db, agent, { projectKey: "AIPI", title: "Flaky test" }))
      .toThrowError(/provenance/i);
    const issue = createIssue(db, agent, {
      projectKey: "AIPI",
      title: "Flaky test in api suite",
      provenance: { sourceType: "todo", detail: "src/api.ts:88" },
    });
    expect(issue.status).toBe("triage");
    expect(issue.sourceType).toBe("todo");
  });

  it("rejects agent-supplied provenance urls that aren't http(s) and accepts http(s) urls", () => {
    expect(() =>
      createIssue(db, agent, {
        projectKey: "AIPI",
        title: "Malicious link",
        provenance: { sourceType: "manual", url: "javascript:alert(1)" },
      })
    ).toThrowError(/must be http/i);
    const issue = createIssue(db, agent, {
      projectKey: "AIPI",
      title: "Safe link",
      provenance: { sourceType: "manual", url: "https://example.com/run/123" },
    });
    expect(issue.sourceUrl).toBe("https://example.com/run/123");
  });

  it("getIssue round-trips by ref and rejects unknown refs legibly", () => {
    createIssue(db, human, { projectKey: "AIPI", title: "One" });
    expect(getIssue(db, "AIPI-1").title).toBe("One");
    expect(() => getIssue(db, "AIPI-99")).toThrowError(/AIPI-99 does not exist/);
    expect(() => getIssue(db, "banana")).toThrowError(/like "AIPI-42"/);
  });
});
