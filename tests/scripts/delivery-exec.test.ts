import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installDeps, run, runGit, pollUntilMergeable, runVerification } from "../../scripts/delivery-exec.js";

const execFileP = promisify(execFile);

/**
 * Sets up a real git repo with a `pre-push` hook that leaves a marker file if
 * it fires, plus a bare remote to push to — the exact SYD-109 shape: a
 * containerized dispatch session has RW Bash+Write access to a repo mount and
 * can plant hooks directly under .git/hooks, which a later host-side `git`
 * command against that same directory would otherwise execute.
 */
async function makeRepoWithPlantedHook(): Promise<{ repo: string; remote: string; marker: string }> {
  const repo = mkdtempSync(path.join(tmpdir(), "delivery-exec-hook-test-"));
  await execFileP("git", ["init", "-q", repo]);
  await execFileP("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await execFileP("git", ["-C", repo, "config", "user.name", "test"]);
  writeFileSync(path.join(repo, "file.txt"), "hello");
  await execFileP("git", ["-C", repo, "add", "file.txt"]);
  await execFileP("git", ["-C", repo, "commit", "-q", "-m", "init"]);

  const marker = path.join(repo, "pwned");
  const hooksDir = path.join(repo, ".git", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, "pre-push");
  writeFileSync(hookPath, `#!/bin/sh\ntouch "${marker}"\n`);
  chmodSync(hookPath, 0o755);

  const remote = mkdtempSync(path.join(tmpdir(), "delivery-exec-remote-"));
  await execFileP("git", ["init", "-q", "--bare", remote]);

  return { repo, remote, marker };
}

describe("runGit", () => {
  it("does not execute a hook planted in the container-touched repo (SYD-109)", async () => {
    const { repo, remote, marker } = await makeRepoWithPlantedHook();

    await runGit(["-C", repo, "push", remote, "HEAD:refs/heads/agent/TEST-1"]);

    expect(existsSync(marker)).toBe(false);
  });

  it("control: the planted hook does fire on a plain git push (proves the marker methodology)", async () => {
    const { repo, remote, marker } = await makeRepoWithPlantedHook();

    await run("git", ["-C", repo, "push", remote, "HEAD:refs/heads/agent/TEST-1"]);

    expect(existsSync(marker)).toBe(true);
  });
});

// SYD-101: the persistent deliver clone kept native modules (e.g.
// better-sqlite3) compiled for a node version the gate no longer runs,
// because `npm install` (the prior behavior) leaves already-installed
// packages alone and `git clean -fd` doesn't touch the gitignored
// node_modules dir. `npm ci` fixes this by deleting node_modules wholesale
// before installing -- this reproduces that exact scenario.
describe("installDeps", () => {
  it("wipes a stale node_modules before installing", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "delivery-exec-test-"));
    writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "tmp-x", version: "1.0.0" }));
    writeFileSync(
      path.join(workspace, "package-lock.json"),
      JSON.stringify({
        name: "tmp-x",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "tmp-x", version: "1.0.0" } },
      })
    );
    const staleModule = path.join(workspace, "node_modules", "stale-native-module");
    mkdirSync(staleModule, { recursive: true });
    writeFileSync(path.join(staleModule, "binding.node"), "stale binary compiled for the wrong node ABI");

    await installDeps(workspace);

    expect(existsSync(staleModule)).toBe(false);
  });
});

// SYD-168: the verify gate ran typecheck + vitest but never build:ui, so
// tests needing dist/ui (spa-fallback) failed on EVERY clean-clone tree and
// no delivery could pass the queue-mode pre-merge gate. These run the real
// runVerification against fake npm/npx shims on PATH that record each
// invocation (and NO_COLOR, so verify tails are born plain — SYD-161).
describe("runVerification", () => {
  function makeWorkspace(scripts: Record<string, string>): string {
    const workspace = mkdtempSync(path.join(tmpdir(), "delivery-exec-verify-"));
    writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "tmp-v", version: "1.0.0", scripts }));
    return workspace;
  }

  /** Fake `npm` and `npx` that log `<cmd> <args> NO_COLOR=<value>` per call. */
  function makeFakeNpm(binDir: string): { callsFile: string } {
    const callsFile = path.join(binDir, "calls");
    writeFileSync(callsFile, "");
    for (const cmd of ["npm", "npx"]) {
      const shim = path.join(binDir, cmd);
      writeFileSync(shim, `#!/bin/sh\necho "${cmd} $* NO_COLOR=\${NO_COLOR:-unset}" >> "${callsFile}"\n`);
      chmodSync(shim, 0o755);
    }
    return { callsFile };
  }

  async function withFakeBinOnPath<T>(binDir: string, fn: () => Promise<T>): Promise<T> {
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${origPath ?? ""}`;
    try {
      return await fn();
    } finally {
      process.env.PATH = origPath;
    }
  }

  function loggedCommands(callsFile: string): string[] {
    return readFileSync(callsFile, "utf8").trim().split("\n").map((l) => l.replace(/ NO_COLOR=\S+$/, ""));
  }

  it("runs build:ui between typecheck and the tests when the project has that script (SYD-168)", async () => {
    const workspace = makeWorkspace({ typecheck: "x", "build:ui": "x", test: "x" });
    const binDir = mkdtempSync(path.join(tmpdir(), "delivery-exec-npm-"));
    const { callsFile } = makeFakeNpm(binDir);

    const result = await withFakeBinOnPath(binDir, () => runVerification(workspace));

    expect(result.ok).toBe(true);
    expect(loggedCommands(callsFile)).toEqual([
      "npm ci",
      "npm run typecheck",
      "npm run build:ui",
      "npx vitest run",
    ]);
  });

  it("skips build:ui for a project without that script instead of failing (NOC has none)", async () => {
    const workspace = makeWorkspace({ typecheck: "x", test: "x" });
    const binDir = mkdtempSync(path.join(tmpdir(), "delivery-exec-npm-"));
    const { callsFile } = makeFakeNpm(binDir);

    const result = await withFakeBinOnPath(binDir, () => runVerification(workspace));

    expect(result.ok).toBe(true);
    expect(loggedCommands(callsFile)).toEqual(["npm ci", "npm run typecheck", "npx vitest run"]);
  });

  it("sets NO_COLOR=1 for every verify step so tails are born plain (SYD-161)", async () => {
    const workspace = makeWorkspace({ typecheck: "x", "build:ui": "x", test: "x" });
    const binDir = mkdtempSync(path.join(tmpdir(), "delivery-exec-npm-"));
    const { callsFile } = makeFakeNpm(binDir);

    await withFakeBinOnPath(binDir, () => runVerification(workspace));

    const lines = readFileSync(callsFile, "utf8").trim().split("\n");
    // npm ci (installDeps) is shared with non-verify callers; the gate steps
    // after it must all run colorless.
    for (const line of lines.slice(1)) {
      expect(line).toMatch(/ NO_COLOR=1$/);
    }
  });
});

// SYD-152: pollUntilMergeable (SYD-103) had no direct test coverage of its
// own — only the pure shouldRetryMergePoll stop-condition was tested. These
// exercise the real poll loop (including the sleep between UNKNOWN reads)
// against a fake `gh` on PATH, since it's now called before every merge
// attempt in deliver.ts, not just post-force-push retries.
describe("pollUntilMergeable", () => {
  async function makeRepoWithOrigin(): Promise<string> {
    const repo = mkdtempSync(path.join(tmpdir(), "delivery-exec-poll-test-"));
    await execFileP("git", ["init", "-q", repo]);
    await execFileP("git", ["-C", repo, "remote", "add", "origin", "https://github.com/acme/widgets.git"]);
    return repo;
  }

  /** Fake `gh` that answers `pr view --json mergeable --jq .mergeable` with
   * "UNKNOWN" for the first `unknownCount` invocations, then `finalState`. */
  function makeFakeGh(binDir: string, unknownCount: number, finalState: string): { callsFile: string } {
    const callsFile = path.join(binDir, "calls");
    writeFileSync(callsFile, "0");
    const ghPath = path.join(binDir, "gh");
    writeFileSync(
      ghPath,
      "#!/bin/sh\n" +
        `n=$(cat "${callsFile}")\n` +
        "n=$((n + 1))\n" +
        `echo "$n" > "${callsFile}"\n` +
        `if [ "$n" -le ${unknownCount} ]; then echo UNKNOWN; else echo ${finalState}; fi\n`
    );
    chmodSync(ghPath, 0o755);
    return { callsFile };
  }

  async function withFakeGhOnPath<T>(binDir: string, fn: () => Promise<T>): Promise<T> {
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${origPath ?? ""}`;
    try {
      return await fn();
    } finally {
      process.env.PATH = origPath;
    }
  }

  it("returns immediately when gh already reports a definitive state", async () => {
    const repo = await makeRepoWithOrigin();
    const binDir = mkdtempSync(path.join(tmpdir(), "delivery-exec-gh-"));
    const { callsFile } = makeFakeGh(binDir, 0, "MERGEABLE");

    const state = await withFakeGhOnPath(binDir, () => pollUntilMergeable(repo, 42));

    expect(state).toBe("MERGEABLE");
    expect(readFileSync(callsFile, "utf8").trim()).toBe("1");
  });

  it("stops immediately on a real CONFLICTING verdict without retrying", async () => {
    const repo = await makeRepoWithOrigin();
    const binDir = mkdtempSync(path.join(tmpdir(), "delivery-exec-gh-"));
    const { callsFile } = makeFakeGh(binDir, 0, "CONFLICTING");

    const state = await withFakeGhOnPath(binDir, () => pollUntilMergeable(repo, 42));

    expect(state).toBe("CONFLICTING");
    expect(readFileSync(callsFile, "utf8").trim()).toBe("1");
  });

  it(
    "polls past a transient UNKNOWN (e.g. right after a push) until gh settles",
    async () => {
      const repo = await makeRepoWithOrigin();
      const binDir = mkdtempSync(path.join(tmpdir(), "delivery-exec-gh-"));
      const { callsFile } = makeFakeGh(binDir, 1, "MERGEABLE");

      const state = await withFakeGhOnPath(binDir, () => pollUntilMergeable(repo, 42));

      expect(state).toBe("MERGEABLE");
      expect(readFileSync(callsFile, "utf8").trim()).toBe("2");
    },
    15000
  );
});
