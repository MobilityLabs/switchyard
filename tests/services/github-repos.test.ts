import { describe, it, expect } from "vitest";
import { createHuman } from "../helpers/human.js";
import type { HumanActor } from "../../src/services/principal.js";
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
    const human = createHuman(db, "sean");
    const p = createProject(db, human, { key: "SYD", name: "Switchyard" });
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
    const human = createHuman(db, "sean");
    createProject(db, human, { key: "SYD", name: "Switchyard" });
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
    const human = createHuman(db, "sean");
    expect(() => removeGithubRepo(db, human, 999)).toThrowError(
      /no linked github repo with id 999/i,
    );
  });

  it("finds a linked repo by full name, or undefined when unlinked", () => {
    const db = openDb(":memory:");
    const human = createHuman(db, "sean");
    addGithubRepo(db, human, { fullName: "acme/widgets", secret: "s3cret" });
    expect(findGithubRepo(db, "acme/widgets")?.secret).toBe("s3cret");
    expect(findGithubRepo(db, "acme/other")).toBeUndefined();
  });

  it("normalizes fullName to lowercase on write and matches regardless of casing (SYD-212)", () => {
    const db = openDb(":memory:");
    const human = createHuman(db, "sean");
    const repo = addGithubRepo(db, human, { fullName: "MobilityLabs/Switchyard" });
    expect(repo.fullName).toBe("mobilitylabs/switchyard");

    // A hand-typed lowercase link and a canonical-case lookup (or vice versa)
    // both resolve to the same row — this is the exact drift the worker's
    // canonical-case publishes vs. a hand-typed lowercase link used to hit.
    expect(findGithubRepo(db, "MobilityLabs/Switchyard")?.id).toBe(repo.id);
    expect(findGithubRepo(db, "mobilitylabs/switchyard")?.id).toBe(repo.id);
    expect(findGithubRepo(db, "MOBILITYLABS/SWITCHYARD")?.id).toBe(repo.id);
  });

  it("rejects linking the same repo twice under different casing", () => {
    const db = openDb(":memory:");
    const human = createHuman(db, "sean");
    addGithubRepo(db, human, { fullName: "acme/widgets" });
    expect(() => addGithubRepo(db, human, { fullName: "Acme/Widgets" })).toThrowError(
      /already linked/i,
    );
  });

  // SYD-281: the agent/service refusal moved to the adapter — see
  // tests/rest/api-service-actor.test.ts (link and unlink, both non-human tiers).
});
