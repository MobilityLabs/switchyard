import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// SYD-80: NOC-7 stalled and exited silently because the container's /work
// clone was an untrusted workspace -- Claude Code ignored its checked-in
// .claude/settings.json permissions and gated protected-path writes behind
// an interactive prompt a headless session could never answer. These tests
// exercise the actual script container-entry.sh now shells out to, against a
// fake $HOME, so they don't need Docker or a real container.

const REPO_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.join(REPO_DIR, "scripts/prime-workspace-trust.mjs");

function run(home: string, workspace: string) {
  execFileSync("node", [SCRIPT, workspace], {
    env: { ...process.env, HOME: home },
  });
}

function readConfig(home: string) {
  return JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8"));
}

describe("prime-workspace-trust.mjs", () => {
  it("creates ~/.claude.json marking the workspace trusted when none exists", () => {
    const home = mkdtempSync(path.join(tmpdir(), "trust-test-"));
    run(home, "/work");
    const config = readConfig(home);
    expect(config.projects["/work"].hasTrustDialogAccepted).toBe(true);
  });

  it("merges into an existing config without disturbing other projects or keys", () => {
    const home = mkdtempSync(path.join(tmpdir(), "trust-test-"));
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        someOtherSetting: "keep-me",
        projects: { "/elsewhere": { hasTrustDialogAccepted: false, extra: "keep-me-too" } },
      }),
    );

    run(home, "/work");

    const config = readConfig(home);
    expect(config.someOtherSetting).toBe("keep-me");
    expect(config.projects["/elsewhere"]).toEqual({
      hasTrustDialogAccepted: false,
      extra: "keep-me-too",
    });
    expect(config.projects["/work"].hasTrustDialogAccepted).toBe(true);
  });

  it("preserves other fields already set on the target project", () => {
    const home = mkdtempSync(path.join(tmpdir(), "trust-test-"));
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        projects: { "/work": { hasTrustDialogAccepted: false, allowedTools: ["Read"] } },
      }),
    );

    run(home, "/work");

    const config = readConfig(home);
    expect(config.projects["/work"]).toEqual({
      hasTrustDialogAccepted: true,
      allowedTools: ["Read"],
    });
  });

  it("is idempotent", () => {
    const home = mkdtempSync(path.join(tmpdir(), "trust-test-"));
    run(home, "/work");
    run(home, "/work");
    const config = readConfig(home);
    expect(config.projects["/work"].hasTrustDialogAccepted).toBe(true);
  });
});
