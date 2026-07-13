import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue, getIssue } from "../../src/services/issues.js";
import { getActivity } from "../../src/services/comments.js";
import { searchIssues } from "../../src/services/search.js";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "AIPI", name: "aipi" });
  createIssue(db, human, { projectKey: "AIPI", title: "t" });
  updateIssue(db, human, "AIPI-1", { status: "todo" });
});

describe("lease token never appears in serialized state", () => {
  it("is absent from the issue view, activity events, and search results", () => {
    const { leaseToken } = claimIssue(db, agent, "AIPI-1");
    const hay = JSON.stringify({
      issue: getIssue(db, "AIPI-1"),
      activity: getActivity(db, "AIPI-1"),
      search: searchIssues(db, { projectKey: "AIPI" }),
    });
    expect(hay).not.toContain(leaseToken);
    // not even the hash leaks into issue/event state
    expect(hay).not.toMatch(/token_?[Hh]ash/);
  });
});
