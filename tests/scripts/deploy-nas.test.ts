import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// SYD-120: deploy-nas.sh hardcoded the NAS Tailscale IP and had no in-repo
// rollback path — a bad deploy meant SSHing to the NAS by hand. These tests
// run the actual script against a stubbed `ssh` binary (captured via PATH)
// inside a throwaway git repo, verifying the host is overridable and that a
// git-ref argument ships that ref's tree instead of the working tree.

const REPO_DIR = path.resolve(__dirname, "../..");
const SCRIPT_SRC = path.join(REPO_DIR, "scripts/deploy-nas.sh");
const DEFAULT_HOST = "100.85.158.109";

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "deploy-nas-test-"));
  mkdirSync(path.join(dir, "scripts"));
  copyFileSync(SCRIPT_SRC, path.join(dir, "scripts/deploy-nas.sh"));
  chmodSync(path.join(dir, "scripts/deploy-nas.sh"), 0o755);

  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);

  writeFileSync(path.join(dir, "marker.txt"), "v1\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "v1"]);
  const v1Sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();

  writeFileSync(path.join(dir, "marker.txt"), "v2\n");
  writeFileSync(path.join(dir, ".env"), "SECRET=v2\n");
  git(dir, ["add", "-A", "--", "marker.txt"]);
  git(dir, ["commit", "-q", "-m", "v2"]);

  const binDir = path.join(dir, "bin");
  mkdirSync(binDir);
  const callsDir = path.join(dir, "ssh-calls");
  mkdirSync(callsDir);

  return { dir, binDir, callsDir, v1Sha };
}

function writeStubSsh(binDir: string) {
  const p = path.join(binDir, "ssh");
  writeFileSync(
    p,
    `#!/bin/bash
set -e
N_FILE="$SSH_CALLS_DIR/count"
N=0
[ -f "$N_FILE" ] && N=$(cat "$N_FILE")
N=$((N + 1))
echo "$N" > "$N_FILE"
{
  echo "HOST=$1"
  echo "CMD=$2"
} > "$SSH_CALLS_DIR/call-$N.args"
cat > "$SSH_CALLS_DIR/call-$N.stdin"
exit 0
`,
  );
  chmodSync(p, 0o755);
}

function runDeploy(
  dir: string,
  binDir: string,
  callsDir: string,
  scriptArgs: string[] = [],
  extraEnv: Record<string, string> = {},
) {
  try {
    const stdout = execFileSync("sh", [path.join(dir, "scripts/deploy-nas.sh"), ...scriptArgs], {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        SSH_CALLS_DIR: callsDir,
        ...extraEnv,
      },
      timeout: 15_000,
    });
    return { status: 0, stdout: stdout.toString() };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer };
    return { status: e.status ?? 1, stdout: e.stdout?.toString() ?? "" };
  }
}

function readCallArgs(callsDir: string, call: number) {
  return readFileSync(path.join(callsDir, `call-${call}.args`), "utf8");
}

function extractStdin(callsDir: string, call: number) {
  const outDir = mkdtempSync(path.join(tmpdir(), "deploy-nas-extract-"));
  execFileSync("tar", ["xzf", path.join(callsDir, `call-${call}.stdin`), "-C", outDir]);
  return outDir;
}

describe("scripts/deploy-nas.sh", () => {
  it("defaults to the Tailscale IP, ships the working tree, and rebuilds", () => {
    const { dir, binDir, callsDir } = setup();
    writeStubSsh(binDir);

    const { status } = runDeploy(dir, binDir, callsDir);

    expect(status).toBe(0);
    expect(readCallArgs(callsDir, 1)).toContain(`HOST=${DEFAULT_HOST}`);
    expect(readCallArgs(callsDir, 1)).toContain("tar xzf - -C mcps/switchyard");
    expect(readCallArgs(callsDir, 2)).toContain(`HOST=${DEFAULT_HOST}`);
    expect(readCallArgs(callsDir, 2)).toContain("sudo -n /usr/local/bin/switchyard-deploy");

    const extracted = extractStdin(callsDir, 1);
    expect(readFileSync(path.join(extracted, "marker.txt"), "utf8")).toBe("v2\n");
    expect(existsSync(path.join(extracted, ".env"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
    rmSync(extracted, { recursive: true, force: true });
  });

  it("honors SWITCHYARD_NAS_HOST instead of the hardcoded IP", () => {
    const { dir, binDir, callsDir } = setup();
    writeStubSsh(binDir);

    const { status } = runDeploy(dir, binDir, callsDir, [], { SWITCHYARD_NAS_HOST: "10.0.0.5" });

    expect(status).toBe(0);
    expect(readCallArgs(callsDir, 1)).toContain("HOST=10.0.0.5");
    expect(readCallArgs(callsDir, 2)).toContain("HOST=10.0.0.5");
    rmSync(dir, { recursive: true, force: true });
  });

  it("rolls back to a given git ref instead of the working tree", () => {
    const { dir, binDir, callsDir, v1Sha } = setup();
    writeStubSsh(binDir);

    const { status, stdout } = runDeploy(dir, binDir, callsDir, [v1Sha]);

    expect(status).toBe(0);
    expect(stdout).toContain("rolling back");
    const extracted = extractStdin(callsDir, 1);
    expect(readFileSync(path.join(extracted, "marker.txt"), "utf8")).toBe("v1\n");
    rmSync(dir, { recursive: true, force: true });
    rmSync(extracted, { recursive: true, force: true });
  });

  it("refuses an invalid git ref and never touches the NAS", () => {
    const { dir, binDir, callsDir } = setup();
    writeStubSsh(binDir);

    const { status } = runDeploy(dir, binDir, callsDir, ["not-a-real-ref"]);

    expect(status).not.toBe(0);
    expect(existsSync(path.join(callsDir, "call-1.args"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
