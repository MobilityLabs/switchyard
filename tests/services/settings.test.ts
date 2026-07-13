import { describe, it, expect, afterEach, vi } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import {
  getSetting,
  getAllSettings,
  setSetting,
  resetSetting,
  resolveBaseUrl,
  getDispatchPolicy,
  REGISTRY,
} from "../../src/services/settings.js";

describe("settings", () => {
  it("falls back to the compiled-in default when unset", () => {
    const db = openDb(":memory:");
    expect(getSetting(db, "sessions.stale_seconds")).toBe(
      REGISTRY["sessions.stale_seconds"].default,
    );
    expect(getSetting(db, "webhooks.suppressed_events")).toEqual(["progress_note"]);
  });

  it("getAllSettings returns the full registry merged with overrides, isDefault true on a fresh DB", () => {
    const db = openDb(":memory:");
    const all = getAllSettings(db);
    expect(all).toHaveLength(Object.keys(REGISTRY).length);
    for (const row of all) {
      expect(row.isDefault).toBe(true);
      expect(row.value).toEqual(row.default);
    }
  });

  it("a human can override a setting, read it back, and it shows isDefault: false", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    setSetting(db, human, "sessions.stale_seconds", 60);
    expect(getSetting(db, "sessions.stale_seconds")).toBe(60);
    const row = getAllSettings(db).find((r) => r.key === "sessions.stale_seconds")!;
    expect(row.isDefault).toBe(false);
    expect(row.value).toBe(60);
  });

  it("setting twice overwrites rather than duplicating", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    setSetting(db, human, "dispatch.poll_seconds", 100);
    setSetting(db, human, "dispatch.poll_seconds", 200);
    expect(getSetting(db, "dispatch.poll_seconds")).toBe(200);
  });

  it("resetSetting deletes the row, reverting to default", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    setSetting(db, human, "instance.name", "Acme Tracker");
    expect(getSetting(db, "instance.name")).toBe("Acme Tracker");
    resetSetting(db, human, "instance.name");
    expect(getSetting(db, "instance.name")).toBe(REGISTRY["instance.name"].default);
    expect(getAllSettings(db).find((r) => r.key === "instance.name")!.isDefault).toBe(true);
  });

  it("validates type and range", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    expect(() => setSetting(db, human, "dispatch.max_concurrent", "not a number")).toThrowError(
      /positive integer/i,
    );
    expect(() => setSetting(db, human, "dispatch.max_concurrent", -1)).toThrowError(
      /positive integer/i,
    );
    expect(() => setSetting(db, human, "dispatch.max_concurrent", 1.5)).toThrowError(
      /positive integer/i,
    );
    expect(() => setSetting(db, human, "instance.name", "")).toThrowError(/non-empty string/i);
    expect(() => setSetting(db, human, "instance.name", 42)).toThrowError(/non-empty string/i);
    expect(() => setSetting(db, human, "webhooks.suppressed_events", "nope")).toThrowError(
      /array of strings/i,
    );
    expect(() => setSetting(db, human, "webhooks.suppressed_events", [1, 2])).toThrowError(
      /array of strings/i,
    );
  });

  it("rejects unknown keys on get/set/reset", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    expect(() => getSetting(db, "nope.nope" as never)).toThrowError(/unknown setting/i);
    expect(() => setSetting(db, human, "nope.nope", 1)).toThrowError(/unknown setting/i);
    expect(() => resetSetting(db, human, "nope.nope")).toThrowError(/unknown setting/i);
  });

  it("rejects agent actors writing settings", () => {
    const db = openDb(":memory:");
    const agent = createActor(db, { name: "claude/dev", type: "agent" }).actor;
    expect(() => setSetting(db, agent, "instance.name", "Nope")).toThrowError(/human-only/i);
    expect(() => resetSetting(db, agent, "instance.name")).toThrowError(/human-only/i);
  });

  it("getDispatchPolicy returns just the dispatch.* group, defaults on a fresh DB", () => {
    const db = openDb(":memory:");
    expect(getDispatchPolicy(db)).toEqual({
      maxConcurrent: REGISTRY["dispatch.max_concurrent"].default,
      maxAnswerConcurrent: REGISTRY["dispatch.max_answer_concurrent"].default,
      intervalSeconds: REGISTRY["dispatch.poll_seconds"].default,
      eventPollSeconds: REGISTRY["dispatch.event_poll_seconds"].default,
    });
  });

  describe("resolveBaseUrl", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("an instance.base_url override wins over SWITCHYARD_URL", () => {
      const db = openDb(":memory:");
      const human = createActor(db, { name: "sean", type: "human" }).actor;
      setSetting(db, human, "instance.base_url", "https://tracker.example.com");
      vi.stubEnv("SWITCHYARD_URL", "http://env.example:9999");
      expect(resolveBaseUrl(db)).toBe("https://tracker.example.com");
    });

    it("falls back to SWITCHYARD_URL when the setting is unset", () => {
      const db = openDb(":memory:");
      vi.stubEnv("SWITCHYARD_URL", "http://env.example:9999");
      expect(resolveBaseUrl(db)).toBe("http://env.example:9999");
    });

    it("falls back to the registry default when neither is set", () => {
      const db = openDb(":memory:");
      vi.stubEnv("SWITCHYARD_URL", undefined);
      expect(resolveBaseUrl(db)).toBe(REGISTRY["instance.base_url"].default);
    });

    it("resetSetting restores env/default resolution", () => {
      const db = openDb(":memory:");
      const human = createActor(db, { name: "sean", type: "human" }).actor;
      setSetting(db, human, "instance.base_url", "https://tracker.example.com");
      resetSetting(db, human, "instance.base_url");
      vi.stubEnv("SWITCHYARD_URL", "http://env.example:9999");
      expect(resolveBaseUrl(db)).toBe("http://env.example:9999");
    });
  });

  it("getDispatchPolicy reflects human overrides", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    setSetting(db, human, "dispatch.max_concurrent", 5);
    setSetting(db, human, "dispatch.poll_seconds", 30);
    expect(getDispatchPolicy(db)).toMatchObject({ maxConcurrent: 5, intervalSeconds: 30 });
  });
});
