import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import {
  addGithubRepo,
  listGithubRepos,
  removeGithubRepo,
  findGithubRepo,
} from "../../src/services/github-repos.js";

describe("github repos", () => {
  it("links, lists, scopes to a project, and unlinks", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    const p = createProject(db, { key: "SYD", name: "Switchyard" });
    const unscoped = addGithubRepo(db, human, { fullName: "acme/widgets" });
    const scoped = addGithubRepo(db, human, {
      fullName: "acme/syd",
      projectKey: "SYD",
      secret: "s3cret",
    });
    expect(unscoped.projectId).toBeNull();
    expect(unscoped.secret).toBeNull();
    expect(scoped.projectId).toBe(p.id);
    expect(scoped.secret).toBe("s3cret");
    expect(listGithubRepos(db)).toHaveLength(2);

    removeGithubRepo(db, human, unscoped.id);
    expect(listGithubRepos(db)).toHaveLength(1);
  });

  it("rejects malformed full names, unknown projects, and duplicate links", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    createProject(db, { key: "SYD", name: "Switchyard" });
    expect(() => addGithubRepo(db, human, { fullName: "not-a-repo" })).toThrowError(
      /must be "owner\/repo"/i,
    );
    expect(() => addGithubRepo(db, human, { fullName: "acme/x", projectKey: "NOPE" })).toThrowError(
      /no project with key/i,
    );
    addGithubRepo(db, human, { fullName: "acme/widgets" });
    expect(() => addGithubRepo(db, human, { fullName: "acme/widgets" })).toThrowError(
      /already linked/i,
    );
  });

  it("errors removing an unknown id", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    expect(() => removeGithubRepo(db, human, 999)).toThrowError(
      /no linked github repo with id 999/i,
    );
  });

  it("finds a linked repo by full name, or undefined when unlinked", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    addGithubRepo(db, human, { fullName: "acme/widgets", secret: "s3cret" });
    expect(findGithubRepo(db, "acme/widgets")?.secret).toBe("s3cret");
    expect(findGithubRepo(db, "acme/other")).toBeUndefined();
  });

  it("rejects agent actors managing linked repos", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    const agent = createActor(db, { name: "claude/dev", type: "agent" }).actor;
    const repo = addGithubRepo(db, human, { fullName: "acme/widgets" });

    expect(() => addGithubRepo(db, agent, { fullName: "acme/other" })).toThrowError(
      /only humans manage linked github repos/i,
    );
    expect(() => removeGithubRepo(db, agent, repo.id)).toThrowError(
      /only humans manage linked github repos/i,
    );
  });
});
