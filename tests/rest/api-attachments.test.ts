import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

let db: Db, app: ReturnType<typeof buildApiRoutes>, attachmentsDir: string;
let agentH: Record<string, string>;

beforeEach(() => {
  db = openDb(":memory:");
  const agent = createActor(db, { name: "claude/dev", type: "agent" });
  agentH = { authorization: `Bearer ${agent.token}` };
  createProject(db, { key: "SYD", name: "Switchyard" });
  attachmentsDir = mkdtempSync(path.join(tmpdir(), "syd-attachments-"));
  app = buildApiRoutes(db, attachmentsDir);
});

afterEach(() => {
  rmSync(attachmentsDir, { recursive: true, force: true });
});

async function body<T>(r: Response): Promise<T> {
  return (await r.json()) as T;
}

async function fileIssue() {
  const r = await app.request("/issues", {
    method: "POST",
    headers: { ...agentH, "content-type": "application/json" },
    body: JSON.stringify({
      projectKey: "SYD", title: "Needs a screenshot",
      description: "Repro needs visual evidence attached.",
      provenance: { sourceType: "manual", detail: "x" },
    }),
  });
  return body<{ ref: string }>(r);
}

function upload(ref: string, filename: string, data: Buffer, headers = agentH) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(data)], filename));
  return app.request(`/issues/${ref}/attachments`, { method: "POST", headers, body: form });
}

describe("attachment routes", () => {
  it("uploads a png, records an event, and returns markdown", async () => {
    const { ref } = await fileIssue();
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await upload(ref, "screenshot.png", data);
    expect(res.status).toBe(200);
    const json = await body<{ id: number; url: string; markdown: string }>(res);
    expect(json.url).toBe(`/api/attachments/${json.id}/screenshot.png`);
    expect(json.markdown).toBe(`![screenshot.png](${json.url})`);

    const detail = await body<{ activity: { type: string; payload: { filename: string; size: number } }[] }>(
      await app.request(`/issues/${ref}`, { headers: agentH })
    );
    const event = detail.activity.find((a) => a.type === "attachment_added");
    expect(event).toBeDefined();
    expect(event!.payload.filename).toBe("screenshot.png");
    expect(event!.payload.size).toBe(data.length);
  });

  it("rejects svg attachments", async () => {
    const { ref } = await fileIssue();
    const res = await upload(ref, "evil.svg", Buffer.from("<svg onload=alert(1)></svg>"));
    expect(res.status).toBe(400);
    const json = await body<{ error: string }>(res);
    expect(json.error).toMatch(/svg/i);
  });

  it("rejects uploads over 20MB (post-parse size check)", async () => {
    const { ref } = await fileIssue();
    // Between MAX_ATTACHMENT_SIZE (20MB) and the bodyLimit middleware's cap
    // (21MB) so this exercises the post-parse belt-and-braces check rather
    // than the pre-buffer bodyLimit rejection covered below.
    const big = Buffer.alloc(20.5 * 1024 * 1024);
    const res = await upload(ref, "huge.png", big);
    expect(res.status).toBe(400);
    const json = await body<{ error: string }>(res);
    expect(json.error).toMatch(/20MB/);
  });

  it("rejects request bodies over 21MB before buffering (413)", async () => {
    const { ref } = await fileIssue();
    const huge = Buffer.alloc(22 * 1024 * 1024);
    const res = await upload(ref, "way-too-huge.png", huge);
    expect(res.status).toBe(413);
    const json = await body<{ error: string }>(res);
    expect(json.error).toBe("Attachment too large — the limit is 20MB.");
  });

  it("rejects disallowed extensions", async () => {
    const { ref } = await fileIssue();
    const res = await upload(ref, "notes.txt", Buffer.from("hello"));
    expect(res.status).toBe(400);
    const json = await body<{ error: string }>(res);
    expect(json.error).toMatch(/not an allowed attachment type/i);
  });

  it("round-trips bytes and sets nosniff on GET", async () => {
    const { ref } = await fileIssue();
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const uploaded = await body<{ id: number; url: string }>(await upload(ref, "shot.png", data));

    // buildApiRoutes' own routes aren't prefixed with "/api" — that prefix is
    // added when it's mounted in server.ts — so strip it for direct requests
    // against this sub-app, matching the pattern used by the other REST tests.
    const res = await app.request(uploaded.url.replace(/^\/api/, ""), { headers: agentH });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toMatch(/inline/);
    expect(res.headers.get("cache-control")).toMatch(/^private/);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(data)).toBe(true);
  });

  it("requires auth on GET", async () => {
    const { ref } = await fileIssue();
    const uploaded = await body<{ id: number; url: string }>(
      await upload(ref, "shot.png", Buffer.from([1, 2, 3]))
    );
    const res = await app.request(uploaded.url.replace(/^\/api/, ""));
    expect(res.status).toBe(401);
  });
});
