import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquirePidLock } from "../../scripts/pidfile.js";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("acquirePidLock", () => {
  it("writes our pid and releases cleanly", () => {
    dir = mkdtempSync(path.join(tmpdir(), "pidlock-"));
    const lockPath = path.join(dir, "sub", "worker.pid"); // parent dir is created
    const release = acquirePidLock(lockPath);
    expect(readFileSync(lockPath, "utf8")).toBe(String(process.pid));
    release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("throws while a live process holds the lock", () => {
    dir = mkdtempSync(path.join(tmpdir(), "pidlock-"));
    const lockPath = path.join(dir, "worker.pid");
    writeFileSync(lockPath, String(process.pid)); // we are definitely alive
    expect(() => acquirePidLock(lockPath, "stop it first")).toThrow(/already running/);
  });

  it("reclaims a stale lock from a dead pid", () => {
    dir = mkdtempSync(path.join(tmpdir(), "pidlock-"));
    const lockPath = path.join(dir, "worker.pid");
    writeFileSync(lockPath, "999999"); // beyond macOS/Linux default pid range
    const release = acquirePidLock(lockPath);
    expect(readFileSync(lockPath, "utf8")).toBe(String(process.pid));
    release();
  });
});
