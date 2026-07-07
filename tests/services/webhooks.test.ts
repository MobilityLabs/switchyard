import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { addWebhook, listWebhooks, removeWebhook } from "../../src/services/webhooks.js";

describe("webhooks", () => {
  it("registers, lists, scopes to a project, and removes", () => {
    const db = openDb(":memory:");
    createActor(db, { name: "sean", type: "human" });
    const p = createProject(db, { key: "SYD", name: "Switchyard" });
    const all = addWebhook(db, { url: "http://example.com/hook" });
    const scoped = addWebhook(db, { url: "http://example.com/syd", projectKey: "SYD", secret: "s3cret" });
    expect(all.projectId).toBeNull();
    expect(scoped.projectId).toBe(p.id);
    expect(listWebhooks(db)).toHaveLength(2);
    removeWebhook(db, all.id);
    expect(listWebhooks(db)).toHaveLength(1);
    expect(() => removeWebhook(db, 999)).toThrowError(/no webhook with id 999/i);
    expect(() => addWebhook(db, { url: "ftp://nope" })).toThrowError(/must be http/i);
    expect(() => addWebhook(db, { url: "http://x.com", projectKey: "NOPE" })).toThrowError(/no project with key/i);
  });
});
