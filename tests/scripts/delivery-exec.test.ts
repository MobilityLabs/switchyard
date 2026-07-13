import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  run,
  runGit,
  pollUntilMergeable,
  readChecks,
  waitForChecks,
} from "../../scripts/delivery-exec.js";

const execFileP = promisify(execFile);

/**
 * Sets up a real git repo with a `pre-push` hook that leaves a marker file if
 * it fires, plus a bare remote to push to — the exact SYD-109 shape: a
 * containerized dispatch session has RW Bash+Write access to a repo mount and
 * can plant hooks directly under .git/hooks, which a later host-side `git`
 * command against that same directory would otherwise execute.
 */
async function makeRepoWithPlantedHook(): Promise<{
  repo: string;
  remote: string;
  marker: string;
}> {
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

// SYD-152: pollUntilMergeable (SYD-103) had no direct test coverage of its
// own — only the pure shouldRetryMergePoll stop-condition was tested. These
// exercise the real poll loop (including the sleep between UNKNOWN reads)
// against a fake `gh` on PATH, since it's now called before every merge
// attempt in deliver.ts, not just post-force-push retries.
describe("pollUntilMergeable", () => {
  async function makeRepoWithOrigin(): Promise<string> {
    const repo = mkdtempSync(path.join(tmpdir(), "delivery-exec-poll-test-"));
    await execFileP("git", ["init", "-q", repo]);
    await execFileP("git", [
      "-C",
      repo,
      "remote",
      "add",
      "origin",
      "https://github.com/acme/widgets.git",
    ]);
    return repo;
  }

  /** Fake `gh` that answers `pr view --json mergeable --jq .mergeable` with
   * "UNKNOWN" for the first `unknownCount` invocations, then `finalState`. */
  function makeFakeGh(
    binDir: string,
    unknownCount: number,
    finalState: string,
  ): { callsFile: string } {
    const callsFile = path.join(binDir, "calls");
    writeFileSync(callsFile, "0");
    const ghPath = path.join(binDir, "gh");
    writeFileSync(
      ghPath,
      "#!/bin/sh\n" +
        `n=$(cat "${callsFile}")\n` +
        "n=$((n + 1))\n" +
        `echo "$n" > "${callsFile}"\n` +
        `if [ "$n" -le ${unknownCount} ]; then echo UNKNOWN; else echo ${finalState}; fi\n`,
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

  it("polls past a transient UNKNOWN (e.g. right after a push) until gh settles", async () => {
    const repo = await makeRepoWithOrigin();
    const binDir = mkdtempSync(path.join(tmpdir(), "delivery-exec-gh-"));
    const { callsFile } = makeFakeGh(binDir, 1, "MERGEABLE");

    const state = await withFakeGhOnPath(binDir, () => pollUntilMergeable(repo, 42));

    expect(state).toBe("MERGEABLE");
    expect(readFileSync(callsFile, "utf8").trim()).toBe("2");
  }, 15000);
});

// SYD-209: CI is the check authority — the worker reads GitHub's required-check
// conclusion for the rebased head (S1) live instead of re-running the suite.
describe("readChecks / waitForChecks", () => {
  async function makeRepoWithOrigin(): Promise<string> {
    const repo = mkdtempSync(path.join(tmpdir(), "delivery-exec-checks-"));
    await execFileP("git", ["init", "-q", repo]);
    await execFileP("git", [
      "-C",
      repo,
      "remote",
      "add",
      "origin",
      "https://github.com/acme/widgets.git",
    ]);
    return repo;
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

  /** Fake `gh` that emits the Nth line of `rollupsJson` (one JSON blob per
   * invocation) for `pr view --json statusCheckRollup,headRefOid`. */
  function makeFakeGhChecks(binDir: string, rollupsJson: string[]): void {
    const callsFile = path.join(binDir, "n");
    writeFileSync(callsFile, "0");
    const dataFile = path.join(binDir, "rollups.json");
    writeFileSync(dataFile, JSON.stringify(rollupsJson));
    const ghPath = path.join(binDir, "gh");
    writeFileSync(
      ghPath,
      "#!/bin/sh\n" +
        `idx=$(cat "${callsFile}")\n` +
        `echo "$((idx + 1))" > "${callsFile}"\n` +
        `IDX=$idx node -e 'const d=require("${dataFile}"); const i=Math.min(Number(process.env.IDX), d.length-1); process.stdout.write(d[i]);'\n`,
    );
    chmodSync(ghPath, 0o755);
  }

  const S1 = "1".repeat(40);

  it("readChecks returns the parsed rollup bound to the current head", async () => {
    const repo = await makeRepoWithOrigin();
    const binDir = mkdtempSync(path.join(tmpdir(), "delivery-exec-checks-bin-"));
    makeFakeGhChecks(binDir, [
      JSON.stringify({
        headRefOid: S1,
        statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
      }),
    ]);

    const rollup = await withFakeGhOnPath(binDir, () => readChecks(repo, 42));
    expect(rollup.headRefOid).toBe(S1);
    expect(rollup.statusCheckRollup).toHaveLength(1);
  });

  it("waitForChecks polls past pending until CI concludes passing on S1", async () => {
    const repo = await makeRepoWithOrigin();
    const binDir = mkdtempSync(path.join(tmpdir(), "delivery-exec-checks-bin-"));
    makeFakeGhChecks(binDir, [
      JSON.stringify({
        headRefOid: S1,
        statusCheckRollup: [{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null }],
      }),
      JSON.stringify({
        headRefOid: S1,
        statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
      }),
    ]);

    const state = await withFakeGhOnPath(binDir, () =>
      waitForChecks(repo, 42, S1, { pollIntervalMs: 5, timeoutMs: 5000 }),
    );
    expect(state).toBe("passing");
  });

  it("waitForChecks reports head-moved when the live head left S1 (SHA chain broken)", async () => {
    const repo = await makeRepoWithOrigin();
    const binDir = mkdtempSync(path.join(tmpdir(), "delivery-exec-checks-bin-"));
    makeFakeGhChecks(binDir, [
      JSON.stringify({ headRefOid: "someoneelsepushed", statusCheckRollup: [] }),
    ]);

    const state = await withFakeGhOnPath(binDir, () =>
      waitForChecks(repo, 42, S1, { pollIntervalMs: 5, timeoutMs: 5000 }),
    );
    expect(state).toBe("head-moved");
  });

  it("waitForChecks times out to pending if checks never conclude", async () => {
    const repo = await makeRepoWithOrigin();
    const binDir = mkdtempSync(path.join(tmpdir(), "delivery-exec-checks-bin-"));
    makeFakeGhChecks(binDir, [
      JSON.stringify({
        headRefOid: S1,
        statusCheckRollup: [{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null }],
      }),
    ]);

    const state = await withFakeGhOnPath(binDir, () =>
      waitForChecks(repo, 42, S1, { pollIntervalMs: 5, timeoutMs: 20 }),
    );
    expect(state).toBe("pending");
  });
});
