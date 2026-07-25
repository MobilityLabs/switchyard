import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../src/db/index.js";
import { createApp } from "../../src/server.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";

let db: Db, app: ReturnType<typeof createApp>;
let agentH: Record<string, string>;
let attachmentsDir: string;

beforeAll(() => {
  attachmentsDir = mkdtempSync(path.join(tmpdir(), "syd-body-limit-"));
  process.env.ATTACHMENTS_DIR = attachmentsDir;
});

afterAll(() => {
  delete process.env.ATTACHMENTS_DIR;
  rmSync(attachmentsDir, { recursive: true, force: true });
});

beforeEach(() => {
  db = openDb(":memory:");
  const { token } = createActor(db, { name: "claude/dev", type: "agent" });
  agentH = { authorization: `Bearer ${token}` };
  createProject(db, createActor(db, { name: "sean", type: "human" }).actor, {
    key: "SYD",
    name: "Switchyard",
  });
  app = createApp(db);
});

async function json<T>(r: Response): Promise<T> {
  return (await r.json()) as T;
}

describe("global request body-size limit (SYD-137)", () => {
  it("rejects an oversized JSON body on /api routes before parsing (413)", async () => {
    const big = "x".repeat(2 * 1024 * 1024);
    const res = await app.request("/api/issues", {
      method: "POST",
      headers: { ...agentH, "content-type": "application/json" },
      body: JSON.stringify({ projectKey: "SYD", title: "t", description: big }),
    });
    expect(res.status).toBe(413);
    const body = await json<{ error: string }>(res);
    expect(body.error).toMatch(/too large/i);
  });

  it("still allows a normal-sized JSON body through on /api routes", async () => {
    const res = await app.request("/api/issues", {
      method: "POST",
      headers: { ...agentH, "content-type": "application/json" },
      body: JSON.stringify({
        projectKey: "SYD",
        title: "normal issue",
        description: "A normal-sized description.",
        provenance: { sourceType: "manual", detail: "test" },
      }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects an oversized body on /mcp before it reaches the transport (413)", async () => {
    const big = "x".repeat(2 * 1024 * 1024);
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { ...agentH, "content-type": "application/json" },
      body: big,
    });
    expect(res.status).toBe(413);
  });

  it("rejects an oversized body on /webhooks/github before signature verification (413)", async () => {
    const big = "x".repeat(2 * 1024 * 1024);
    const res = await app.request("/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-hub-signature-256": "sha256=doesnotmatter",
      },
      body: big,
    });
    expect(res.status).toBe(413);
  });

  it("does not apply the modest JSON limit to attachment uploads", async () => {
    const created = await app.request("/api/issues", {
      method: "POST",
      headers: { ...agentH, "content-type": "application/json" },
      body: JSON.stringify({
        projectKey: "SYD",
        title: "needs a screenshot",
        description: "Repro needs visual evidence attached.",
        provenance: { sourceType: "manual", detail: "test" },
      }),
    });
    const { ref } = await json<{ ref: string }>(created);

    // Bigger than JSON_BODY_LIMIT (1MB) but well under the attachment route's
    // own 20MB cap — proves the exemption, not just a small upload.
    const data = Buffer.alloc(2 * 1024 * 1024, 1);
    const form = new FormData();
    form.set("file", new File([new Uint8Array(data)], "big.png"));
    const res = await app.request(`/api/issues/${ref}/attachments`, {
      method: "POST",
      headers: agentH,
      body: form,
    });
    expect(res.status).toBe(200);
  });
});
