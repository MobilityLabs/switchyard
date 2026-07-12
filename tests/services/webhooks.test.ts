import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import {
  addWebhook,
  listWebhooks,
  removeWebhook,
  setWebhookActive,
} from "../../src/services/webhooks.js";

describe("webhooks", () => {
  it("registers, lists, scopes to a project, and removes", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    const p = createProject(db, human, { key: "SYD", name: "Switchyard" });
    const all = addWebhook(db, human, { url: "http://example.com/hook" });
    const scoped = addWebhook(db, human, {
      url: "http://example.com/syd",
      projectKey: "SYD",
      secret: "s3cret",
    });
    expect(all.projectId).toBeNull();
    expect(scoped.projectId).toBe(p.id);
    expect(listWebhooks(db)).toHaveLength(2);
    removeWebhook(db, human, all.id);
    expect(listWebhooks(db)).toHaveLength(1);
    expect(() => removeWebhook(db, human, 999)).toThrowError(/no webhook with id 999/i);
    expect(() => addWebhook(db, human, { url: "ftp://nope" })).toThrowError(/must be http/i);
    expect(() => addWebhook(db, human, { url: "http://x.com", projectKey: "NOPE" })).toThrowError(
      /no project with key/i,
    );
  });

  it("rejects agent actors managing webhooks", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    const agent = createActor(db, { name: "claude/dev", type: "agent" }).actor;
    const hook = addWebhook(db, human, { url: "http://example.com/hook" });

    expect(() => addWebhook(db, agent, { url: "http://example.com/other" })).toThrowError(
      /only humans manage webhooks/i,
    );
    expect(() => removeWebhook(db, agent, hook.id)).toThrowError(/only humans manage webhooks/i);
    expect(() => setWebhookActive(db, agent, hook.id, false)).toThrowError(
      /only humans manage webhooks/i,
    );
  });
});
