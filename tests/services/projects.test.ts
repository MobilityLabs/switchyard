import { describe, it, expect } from "vitest";
import { createHuman } from "../helpers/human.js";
import { openDb } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import type { HumanActor } from "../../src/services/principal.js";
import {
  createProject,
  updateProject,
  listProjects,
  getProjectByKey,
  reserveIssueNumber,
} from "../../src/services/projects.js";

function actors(db: ReturnType<typeof openDb>): { human: HumanActor; agent: Actor } {
  return {
    human: createHuman(db, "sean"),
    agent: createActor(db, { name: "claude/dev", type: "agent" }).actor,
  };
}

describe("updateProject (SYD-157, landed via SYD-158)", () => {
  it("renames a project for a human actor, leaving key and counter untouched", () => {
    const db = openDb(":memory:");
    const { human } = actors(db);
    const p = createProject(db, human, { key: "AIPI", name: "old name" });
    reserveIssueNumber(db, p.id);

    const renamed = updateProject(db, human, "AIPI", { name: "new name" });
    expect(renamed.name).toBe("new name");
    expect(renamed.key).toBe("AIPI");
    expect(renamed.nextIssueNumber).toBe(2);
  });

  // SYD-281: the agent-refusal assertion moved to the adapter, where the gate
  // now lives — tests/rest/api-service-actor.test.ts covers both the agent and
  // the service tier against every human-only route. Re-asserting it here would
  // need a manufactured HumanActor, which is the state-constructing test shape
  // this story exists to remove.

  it("throws legibly for an unknown project key", () => {
    const db = openDb(":memory:");
    const { human } = actors(db);
    expect(() => updateProject(db, human, "NOPE", { name: "x" })).toThrowError(
      /no project with key "NOPE"/i,
    );
  });
});

describe("projects", () => {
  it("creates, lists, and fetches by key", () => {
    const db = openDb(":memory:");
    const { human } = actors(db);
    const p = createProject(db, human, { key: "AIPI", name: "aipi benchmarking" });
    expect(p.key).toBe("AIPI");
    expect(listProjects(db).map((x) => x.key)).toEqual(["AIPI"]);
    expect(getProjectByKey(db, "AIPI").id).toBe(p.id);
    expect(() => getProjectByKey(db, "NOPE")).toThrowError(/no project with key "NOPE"/i);
  });

  it("rejects malformed keys", () => {
    const db = openDb(":memory:");
    const { human } = actors(db);
    expect(() => createProject(db, human, { key: "bad key", name: "x" })).toThrowError(
      /2–10 uppercase letters/,
    );
  });

  it("hands out sequential issue numbers", () => {
    const db = openDb(":memory:");
    const { human } = actors(db);
    const p = createProject(db, human, { key: "HAND", name: "housing atlas" });
    expect(reserveIssueNumber(db, p.id)).toBe(1);
    expect(reserveIssueNumber(db, p.id)).toBe(2);
  });

  it("rejects duplicate keys with an agent-legible error", () => {
    const db = openDb(":memory:");
    const { human } = actors(db);
    createProject(db, human, { key: "AIPI", name: "aipi" });
    expect(() => createProject(db, human, { key: "AIPI", name: "again" })).toThrowError(
      /project with key "AIPI" already exists/i,
    );
  });
});
