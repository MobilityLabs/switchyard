import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import {
  createProject, listProjects, getProjectByKey, reserveIssueNumber,
} from "../../src/services/projects.js";

describe("projects", () => {
  it("creates, lists, and fetches by key", () => {
    const db = openDb(":memory:");
    const p = createProject(db, { key: "AIPI", name: "aipi benchmarking" });
    expect(p.key).toBe("AIPI");
    expect(listProjects(db).map((x) => x.key)).toEqual(["AIPI"]);
    expect(getProjectByKey(db, "AIPI").id).toBe(p.id);
    expect(() => getProjectByKey(db, "NOPE")).toThrowError(/no project with key "NOPE"/i);
  });

  it("rejects malformed keys", () => {
    const db = openDb(":memory:");
    expect(() => createProject(db, { key: "bad key", name: "x" }))
      .toThrowError(/2–10 uppercase letters/);
  });

  it("hands out sequential issue numbers", () => {
    const db = openDb(":memory:");
    const p = createProject(db, { key: "HAND", name: "housing atlas" });
    expect(reserveIssueNumber(db, p.id)).toBe(1);
    expect(reserveIssueNumber(db, p.id)).toBe(2);
  });
});
