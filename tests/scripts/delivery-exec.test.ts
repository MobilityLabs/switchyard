import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installDeps, run, runGit } from "../../scripts/delivery-exec.js";

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
