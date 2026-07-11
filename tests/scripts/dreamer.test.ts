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

// Same as runDreamer but without the default SWITCHYARD_TOKEN, so tests can
// exercise the SWITCHYARD_TOKEN_FILE fallback (SYD-119) directly.
function runDreamerNoTokenEnv(dreamsDir: string, claudeBin: string, extraEnv: Record<string, string> = {}) {
  try {
    execFileSync("bash", [SCRIPT], {
      cwd: REPO_DIR,
      env: {
        ...process.env,
        SWITCHYARD_URL: "http://localhost:3300",
        SWITCHYARD_TOKEN: "",
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

const today = () => new Date().toISOString().slice(0, 10);

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

// SYD-119: the launchd plist no longer embeds SWITCHYARD_TOKEN (installed
// plists are world-readable at 0644). These tests cover the SWITCHYARD_TOKEN_FILE
// fallback dreamer.sh reads instead: a 0600 file is trusted, a group/world
// readable one is refused, and an already-set env var still wins.
describe("scripts/dreamer.sh SWITCHYARD_TOKEN_FILE fallback", () => {
  function logPath(dreamsDir: string) {
    return path.join(dreamsDir, "switchyard-dreamer.log");
  }

  it("loads the token from a 0600 SWITCHYARD_TOKEN_FILE when SWITCHYARD_TOKEN is unset", () => {
    const { dir, dreamsDir, binDir } = setup();
    const date = today();
    const tokenFile = path.join(dir, "dreamer-token");
    writeFileSync(tokenFile, "file-token\n");
    chmodSync(tokenFile, 0o600);
    const claude = writeStubClaude(
      binDir,
      `printf 'token seen: %s\\n' "$SWITCHYARD_TOKEN" > "$DREAMS_DIR/switchyard-$DREAMER_DATE.md"\nexit 0`
    );

    const rc = runDreamerNoTokenEnv(dreamsDir, claude, { SWITCHYARD_TOKEN_FILE: tokenFile });

    expect(rc).toBe(0);
    expect(existsSync(okMarkerPath(dreamsDir, date))).toBe(true);
    expect(readFileSync(digestPath(dreamsDir, date), "utf8")).toContain("token seen: file-token");
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a SWITCHYARD_TOKEN_FILE that is group/world readable and never runs claude", () => {
    const { dir, dreamsDir, binDir } = setup();
    const tokenFile = path.join(dir, "dreamer-token");
    writeFileSync(tokenFile, "file-token\n");
    chmodSync(tokenFile, 0o644);
    const sentinel = path.join(dreamsDir, "should-not-exist");
    const claude = writeStubClaude(binDir, `touch "${sentinel}"\nexit 0`);

    const rc = runDreamerNoTokenEnv(dreamsDir, claude, { SWITCHYARD_TOKEN_FILE: tokenFile });

    expect(rc).toBe(1);
    expect(existsSync(sentinel)).toBe(false);
    const log = readFileSync(logPath(dreamsDir), "utf8");
    expect(log).toContain("FATAL");
    expect(log).toContain("chmod 600");
    rmSync(dir, { recursive: true, force: true });
  });

  it("prefers an already-set SWITCHYARD_TOKEN over the file", () => {
    const { dir, dreamsDir, binDir } = setup();
    const date = today();
    const tokenFile = path.join(dir, "dreamer-token");
    writeFileSync(tokenFile, "file-token\n");
    chmodSync(tokenFile, 0o600);
    const claude = writeStubClaude(
      binDir,
      `printf 'token seen: %s\\n' "$SWITCHYARD_TOKEN" > "$DREAMS_DIR/switchyard-$DREAMER_DATE.md"\nexit 0`
    );

    const rc = runDreamer(dreamsDir, claude, { SWITCHYARD_TOKEN_FILE: tokenFile });

    expect(rc).toBe(0);
    expect(readFileSync(digestPath(dreamsDir, date), "utf8")).toContain("token seen: test-token");
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails with the original FATAL when neither SWITCHYARD_TOKEN nor the file is present", () => {
    const { dir, dreamsDir, binDir } = setup();
    const claude = writeStubClaude(binDir, `exit 0`);

    const rc = runDreamerNoTokenEnv(dreamsDir, claude, {
      SWITCHYARD_TOKEN_FILE: path.join(dir, "does-not-exist"),
    });

    expect(rc).toBe(1);
    const log = readFileSync(logPath(dreamsDir), "utf8");
    expect(log).toContain("FATAL: SWITCHYARD_URL and SWITCHYARD_TOKEN must both be set");
    rmSync(dir, { recursive: true, force: true });
  });
});
