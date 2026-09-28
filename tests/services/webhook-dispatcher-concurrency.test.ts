import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openDb } from "../../src/db/index.js";
import { webhookCursor } from "../../src/db/schema.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue } from "../../src/services/issues.js";
import { addWebhook } from "../../src/services/webhooks.js";
import { recordProgressNote } from "../../src/services/agent-sessions.js";
import * as leases from "../../src/services/leases.js";
import { dispatchPending, startWebhookDispatcher } from "../../src/services/webhook-dispatcher.js";

function setup() {
  const db = openDb(":memory:");
  const human = createActor(db, { name: "sean", type: "human" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  addWebhook(db, human, { url: "https://receiver.test/hook" });
  createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
  return { db, human };
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("webhook dispatcher concurrency", () => {
  it("coalesces overlapping batches so each event fans out once", async () => {
    const { db, human } = setup();
    updateIssue(db, human, "SYD-1", { status: "todo" });
    const firstResponse = deferredResponse();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockResolvedValue(new Response(null, { status: 200 }));

    const first = dispatchPending(db, fetchFn);
    const second = dispatchPending(db, fetchFn);
    expect(second).toBe(first);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    firstResponse.resolve(new Response(null, { status: 200 }));
    expect(await first).toBe(2);
    expect(await second).toBe(2);
    expect(fetchFn.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).event)).toEqual([
      "created",
      "status_changed",
    ]);
    expect(await dispatchPending(db, fetchFn)).toBe(0);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("never regresses the cursor, including while skipping suppressed events", async () => {
    const { db } = setup();
    const agent = createActor(db, { name: "worker", type: "agent" }).actor;
    recordProgressNote(db, agent, "SYD-1", "compiling");
    const response = deferredResponse();
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(() => response.promise);
    const pending = dispatchPending(db, fetchFn);
    db.update(webhookCursor).set({ lastEventId: 100 }).where(eq(webhookCursor.id, 1)).run();
    response.resolve(new Response(null, { status: 200 }));
    await pending;

    expect(db.select().from(webhookCursor).get()?.lastEventId).toBe(100);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("releases the active batch after a database failure so a later tick retries", async () => {
    const { db } = setup();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    vi.spyOn(db, "select").mockImplementationOnce(() => {
      throw new Error("database unavailable");
    });
    await expect(dispatchPending(db, fetchFn)).rejects.toThrow("database unavailable");
    expect(await dispatchPending(db, fetchFn)).toBe(1);
  });

  it("keeps lease housekeeping running on every tick while a receiver is slow", async () => {
    const { db } = setup();
    vi.useFakeTimers();
    const sweep = vi.spyOn(leases, "expireLeases").mockReturnValue(0);
    const response = deferredResponse();
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(() => response.promise);
    vi.stubGlobal("fetch", fetchFn);
    const stop = startWebhookDispatcher(db, 2000);
    try {
      await vi.advanceTimersByTimeAsync(6000);
      expect(sweep).toHaveBeenCalledTimes(3);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const pending = dispatchPending(db, fetchFn);
      stop();
      response.resolve(new Response(null, { status: 200 }));
      await pending;
    } finally {
      stop();
      response.resolve(new Response(null, { status: 200 }));
    }
  });
});
