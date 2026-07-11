import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue } from "../../src/services/issues.js";
import { addWebhook } from "../../src/services/webhooks.js";
import { recordProgressNote } from "../../src/services/agent-sessions.js";
import { dispatchPending, resolveStaleClaimSeconds } from "../../src/services/webhook-dispatcher.js";

describe("webhook dispatcher", () => {
  it("delivers signed events once, then advances the cursor", async () => {
    const received: { body: string; sig: string | null }[] = [];
    const receiver = new Hono().post("/hook", async (c) => {
      received.push({ body: await c.req.text(), sig: c.req.header("x-switchyard-signature") ?? null });
      return c.json({ ok: true });
    });
    let port = 0;
    const server: ServerType = await new Promise((resolve) => {
      const s = serve({ fetch: receiver.fetch, port: 0 }, (i) => { port = i.port; resolve(s); });
    });

    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    createProject(db, { key: "SYD", name: "Switchyard" });
    addWebhook(db, human, { url: `http://127.0.0.1:${port}/hook`, secret: "s3cret" });
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });          // 1 event
    updateIssue(db, human, "SYD-1", { status: "todo" });                       // 1 event

    expect(await dispatchPending(db)).toBe(2);
    expect(received).toHaveLength(2);
    const first = JSON.parse(received[0].body);
    expect(first).toMatchObject({ event: "created", issue: "SYD-1", project: "SYD", actor: "sean" });
    const expected = "sha256=" + createHmac("sha256", "s3cret").update(received[0].body).digest("hex");
    expect(received[0].sig).toBe(expected);

    // cursor advanced: nothing new
    expect(await dispatchPending(db)).toBe(0);
    expect(received).toHaveLength(2);

    server.close();
  });

  it("skips webhooks scoped to another project and survives dead endpoints", async () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    createProject(db, { key: "SYD", name: "Switchyard" });
    createProject(db, { key: "AIPI", name: "aipi" });
    addWebhook(db, human, { url: "http://127.0.0.1:1/dead", projectKey: "AIPI" }); // scoped elsewhere + dead
    createIssue(db, human, { projectKey: "SYD", title: "One" });
    expect(await dispatchPending(db)).toBe(0); // no matching hook, no throw
  });

  it("suppresses progress_note events by default: never POSTed, cursor still advances", async () => {
    const received: string[] = [];
    const receiver = new Hono().post("/hook", async (c) => {
      received.push(await c.req.text());
      return c.json({ ok: true });
    });
    let port = 0;
    const server: ServerType = await new Promise((resolve) => {
      const s = serve({ fetch: receiver.fetch, port: 0 }, (i) => { port = i.port; resolve(s); });
    });

    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    const agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
    createProject(db, { key: "SYD", name: "Switchyard" });
    addWebhook(db, human, { url: `http://127.0.0.1:${port}/hook` });
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" }); // 1 event: created
    recordProgressNote(db, agent, "SYD-1", "compiling");             // 1 event: progress_note
    updateIssue(db, human, "SYD-1", { status: "todo" });              // 1 event: status_changed

    expect(await dispatchPending(db)).toBe(2); // only created + status_changed delivered
    expect(received).toHaveLength(2);
    expect(received.map((b) => JSON.parse(b).event)).toEqual(["created", "status_changed"]);

    // cursor advanced past the suppressed event too: nothing left to redeliver
    expect(await dispatchPending(db)).toBe(0);
    expect(received).toHaveLength(2);

    server.close();
  });

  it("does not count non-2xx responses as delivered, and still advances the cursor", async () => {
    const receiver = new Hono().post("/fail", (c) => c.json({}, 500));
    let port = 0;
    const server: ServerType = await new Promise((resolve) => {
      const s = serve({ fetch: receiver.fetch, port: 0 }, (i) => { port = i.port; resolve(s); });
    });

    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    createProject(db, { key: "SYD", name: "Switchyard" });
    addWebhook(db, human, { url: `http://127.0.0.1:${port}/fail` });
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" }); // 1 event

    expect(await dispatchPending(db)).toBe(0); // hook responded 500, not counted as delivered

    // cursor advanced despite the failed delivery: nothing new to redeliver
    expect(await dispatchPending(db)).toBe(0);

    server.close();
  });
});

describe("resolveStaleClaimSeconds", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to 4 hours when STALE_CLAIM_HOURS is unset, without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveStaleClaimSeconds(undefined)).toBe(4 * 3600);
    expect(warn).not.toHaveBeenCalled();
  });

  it("honors a valid positive value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveStaleClaimSeconds("2")).toBe(2 * 3600);
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to 4 hours and warns on a set-but-invalid value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveStaleClaimSeconds("not-a-number")).toBe(4 * 3600);
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockClear();
    expect(resolveStaleClaimSeconds("-1")).toBe(4 * 3600);
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockClear();
    expect(resolveStaleClaimSeconds("0")).toBe(4 * 3600);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
