import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// SYD-61: the Dreamer's first real launchd run failed offline and then hung
// for 4.5h with no visible trace. These tests spawn the actual dreamer.sh
// against a stubbed `claude` binary to verify the hardening: a hung session
// gets killed instead of burning hours, a failed/timed-out run leaves a
// FAILED note in the digest itself (not just the log), and a run that
// already succeeded today is a no-op so hourly launchd retries are safe.

const REPO_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.join(REPO_DIR, "scripts/dreamer.sh");

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "dreamer-test-"));
  const dreamsDir = path.join(dir, "dreams");
  const binDir = path.join(dir, "bin");
  mkdirSync(dreamsDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  return { dir, dreamsDir, binDir };
}

function writeStubClaude(binDir: string, script: string) {
  const p = path.join(binDir, "claude");
  writeFileSync(p, `#!/bin/bash\n${script}\n`);
  chmodSync(p, 0o755);
  return p;
}

function runDreamer(dreamsDir: string, claudeBin: string, extraEnv: Record<string, string> = {}) {
  try {
    execFileSync("bash", [SCRIPT], {
      cwd: REPO_DIR,
      env: {
        ...process.env,
        SWITCHYARD_URL: "http://localhost:3300",
        SWITCHYARD_TOKEN: "test-token",
        CLAUDE_BIN: claudeBin,
        DREAMS_DIR: dreamsDir,
        ...extraEnv,
      },
      timeout: 15_000,
    });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? 1;
  }
}

function digestPath(dreamsDir: string, date: string) {
  return path.join(dreamsDir, `switchyard-${date}.md`);
}

function okMarkerPath(dreamsDir: string, date: string) {
  return path.join(dreamsDir, `.switchyard-${date}.ok`);
}

// Must be the LOCAL date: dreamer.sh names files by `date +%Y-%m-%d`, so the
// UTC date (toISOString) diverges from it every evening and 404s every path.
const today = () => {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
};

describe("scripts/dreamer.sh", () => {
  it("on success, writes an .ok marker and leaves the digest the session wrote", () => {
    const { dreamsDir, binDir } = setup();
    const date = today();
    const claude = writeStubClaude(
      binDir,
      `printf '# digest\\n' > "$DREAMS_DIR/switchyard-$DREAMER_DATE.md"\nexit 0`
    );

    const rc = runDreamer(dreamsDir, claude);

    expect(rc).toBe(0);
    expect(existsSync(okMarkerPath(dreamsDir, date))).toBe(true);
    expect(readFileSync(digestPath(dreamsDir, date), "utf8")).toContain("# digest");
    rmSync(dreamsDir, { recursive: true, force: true });
  });

  it("on a non-zero exit, appends a FAILED note to the digest and does not write an .ok marker", () => {
    const { dreamsDir, binDir } = setup();
    const date = today();
    const claude = writeStubClaude(binDir, `exit 1`);

    const rc = runDreamer(dreamsDir, claude);

    expect(rc).toBe(1);
    expect(existsSync(okMarkerPath(dreamsDir, date))).toBe(false);
    const digest = readFileSync(digestPath(dreamsDir, date), "utf8");
    expect(digest).toMatch(/\*\*FAILED\*\*/);
    expect(digest).toContain("non-zero exit");
    rmSync(dreamsDir, { recursive: true, force: true });
  });

  it("kills a hung session after the timeout and records it as a timed-out FAILED note", () => {
    const { dreamsDir, binDir } = setup();
    const date = today();
    const claude = writeStubClaude(binDir, `sleep 300`);

    const start = Date.now();
    const rc = runDreamer(dreamsDir, claude, { DREAMER_TIMEOUT_SECONDS: "1" });
    const elapsedMs = Date.now() - start;

    expect(rc).toBe(1);
    expect(elapsedMs).toBeLessThan(10_000); // would be 300s+ without the timeout wrapper
    expect(existsSync(okMarkerPath(dreamsDir, date))).toBe(false);
    const digest = readFileSync(digestPath(dreamsDir, date), "utf8");
    expect(digest).toMatch(/\*\*FAILED\*\*/);
    expect(digest).toContain("timed out");
    rmSync(dreamsDir, { recursive: true, force: true });
  }, 15_000);

  it("skips the session entirely once today's run already succeeded (hourly retry no-op)", () => {
    const { dreamsDir, binDir } = setup();
    const date = today();
    writeFileSync(okMarkerPath(dreamsDir, date), "");
    const sentinel = path.join(dreamsDir, "should-not-exist");
    const claude = writeStubClaude(binDir, `touch "${sentinel}"\nexit 0`);

    const rc = runDreamer(dreamsDir, claude);

    expect(rc).toBe(0);
    expect(existsSync(sentinel)).toBe(false);
    rmSync(dreamsDir, { recursive: true, force: true });
  });
});
